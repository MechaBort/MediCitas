# MediCitas
MediCitas is a multi-tenant SaaS platform that manage medical appointments for numerous clinics and ensures data security

## Cómo levantar el proyecto

```bash
cp .env.example .env
docker compose up --build
```

| Servicio | URL | Notas |
|---|---|---|
| API (gateway) | http://localhost:3000/health | Nginx: la única entrada de la API. Reparte cada ruta, según su prefijo, a uno de los tres servicios Node 24 + Express 5 (`admin`, `agenda` y `clinical`), que no publican puertos. El header `X-MediCitas-Service` de cada respuesta dice qué servicio contestó |
| Keycloak | http://localhost:8080 | Consola con `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` del `.env`; el realm `medicitas` se importa solo desde `keycloak/medicitas-realm.json` |
| PostgreSQL | `localhost:5432`, base `medicitas` | Esquema, permisos, catálogos y datos de demostración se cargan solos desde `db/` |
| Redis | solo dentro de la red de Compose | Caché de disponibilidad, sin persistencia. Inspeccionar con `docker compose exec redis redis-cli` |

La base y el realm se inicializan solo cuando el volumen de datos está vacío. Después de cambiar algo en
`db/sql/` o en `keycloak/`, recrear desde cero con `docker compose down -v`.

El gateway busca la dirección de cada servicio una sola vez, al arrancar. Si se recrea solo un servicio (por
ejemplo con `docker compose up --build agenda`) y sus rutas responden 503, reiniciar el gateway con
`docker compose restart gateway`. Una pila que todavía tenga el contenedor viejo
`medicitas-app-1` necesita `docker compose up --build --remove-orphans`.

Diagramas de arquitectura y entidad-relación: [docs/diagramas.md](docs/diagramas.md).
Diccionario de datos: [docs/diccionario-datos.md](docs/diccionario-datos.md). Se genera desde la base con
`./db/tools/generar-diccionario.sh` (con la pila levantada); las descripciones están en `db/sql/05-comments.sql`.

### En Kubernetes (minikube)

El mismo sistema se despliega en Kubernetes con un solo comando. Usa el mismo `.env` y los mismos archivos de
`db/`, y **no corre a la vez que Compose**.

```bash
cp .env.example .env              # si todavía no existe
minikube start --cpus=6 --memory=8192
./k8s/deploy.sh
```

Los manifiestos están en `k8s/`, numerados en el orden en que se aplican. Las decisiones están en
[docs/diseno-servicios.md](docs/diseno-servicios.md), sección 7.

| Paso | Qué despliega | Estado |
|---|---|---|
| 1 | PostgreSQL 18 con el operador CloudNativePG (`Cluster`), su inicialización con el mismo `db/init/00-init.sh` de Compose (Job `db-init`) y PgBouncer en modo transacción (`Pooler`) | Hecho |
| 2 | Los servicios `admin`, `agenda` y `clinical`, el gateway, Keycloak y Redis, con las imágenes construidas dentro de minikube y un Secret por componente | Hecho |
| 3 | `metrics-server` y el HPA de `agenda` (entre 2 y 6 copias según la CPU), con un PgBouncer propio para `agenda` | Hecho |

Para usar la API desde esta máquina, se abren los puertos en otra terminal. Son los mismos que usa Compose, así que
**no puede estar Compose arriba a la vez**:

```bash
kubectl -n medicitas port-forward svc/gateway 3000:3000
kubectl -n medicitas port-forward svc/keycloak 8080:8080
```

Con eso, los `curl` de este README funcionan igual que en Compose, con el mismo `iss` en los tokens.

Para correr **la misma suite de pruebas dentro del clúster**, contra el gateway de Kubernetes:

```bash
./k8s/run-tests.sh
```

Para ver el **HPA** escalar `agenda` bajo carga: k6 corre `tests/load/availability.js` dentro del clúster y, cada 10 s,
el script muestra la CPU y las copias de `agenda` mientras suben y vuelven a bajar.

```bash
./k8s/load-test.sh                       # 100 usuarios durante 3 minutos
VUS=50 DURATION=2m ./k8s/load-test.sh
kubectl -n medicitas get hpa agenda -w   # en otra terminal, en vivo
```

Los resultados y por qué `agenda` tiene su propio PgBouncer están en
[docs/diseno-servicios.md](docs/diseno-servicios.md), sección 7, "Decisiones del paso 3".

Para revisar el paso 1:

```bash
kubectl -n medicitas get cluster,pooler,pods
# Entrar a la base por PgBouncer como el usuario de agenda, igual que lo hará el servicio:
kubectl -n medicitas run psql --rm -it --image=postgres:18-alpine --env=PGPASSWORD=<DB_AGENDA_SVC_PASSWORD> -- \
  psql -h medicitas-db-pooler-rw -U mc_agenda_svc -d medicitas
```

`./k8s/deploy.sh` se puede repetir sin romper nada. Como en Compose, la base se inicializa **una sola vez**: para
recrearla después de cambiar algo en `db/`, se borra el namespace con `kubectl delete namespace medicitas` y se vuelve
a desplegar. `minikube delete` borra el clúster entero.

Un `.env` creado antes de la etapa 3 no tiene las contraseñas de los usuarios por servicio. En ese caso
`deploy.sh` dice qué variables faltan, y se copian desde `.env.example`.

### Usuarios de prueba

Todos tienen la contraseña `medicitas` (solo para desarrollo). El `sub` del token es el `keycloak_sub` de
la tabla `users`, y de ahí sale la clínica del usuario.

| Usuario | Rol | Clínica | Notas |
|---|---|---|---|
| `plataforma` | platform_admin | — | |
| `admin.sanjose` · `admin.cartago` · `admin.bogota` | clinic_admin | la del nombre | |
| `recepcion.sanjose` · `recepcion.cartago` · `recepcion.bogota` | reception | la del nombre | |
| `laura.mora` · `andres.solis` · `daniela.rojas` · `mariana.quesada` | professional | CR-SJ-001 San José | |
| `carlos.brenes` · `sofia.aguilar` · `javier.calderon` | professional | CR-CA-001 Cartago | |
| `valentina.restrepo` · `santiago.ospina` · `camila.herrera` · `mateo.cardenas` | professional | CO-BO-001 Bogotá (otra zona horaria) | |
| `exrecepcion.sanjose` | reception | CR-SJ-001 | Dado de baja en `users` (`is_active = false`) aunque Keycloak lo deje entrar |
| `sinregistro` | reception | — | Existe en Keycloak pero no en `users`: un token válido sin usuario en el sistema |

Obtener un token (válido 15 minutos):

```bash
curl -s -X POST http://localhost:8080/realms/medicitas/protocol/openid-connect/token \
  -d grant_type=password -d client_id=medicitas-api \
  -d username=recepcion.sanjose -d password=medicitas
```

### Datos de demostración

`db/sql/04-seed.sql` crea 3 clínicas (dos en Costa Rica y una en Colombia), 11 profesionales, 80 pacientes
por clínica, horarios entre 8 semanas atrás y 4 semanas adelante de la fecha en que se levanta la base, y
unas 4 000 citas en todos los estados, con notas clínicas y bitácora. Es determinista: no usa `random()`,
así que dos personas que levanten el proyecto el mismo día obtienen los mismos datos. Incluye a propósito
4 citas en conflicto con un bloqueo registrado después de reservarlas (RF6) y una reprogramación por clínica (RF10).

## Pruebas

Un solo comando ejecuta las pruebas unitarias y las de integración. Las de integración corren contra la pila real,
entrando por el gateway y con tokens reales de Keycloak. No hace falta preparar datos.

```bash
docker compose --profile test run --rm tests
```

Solo necesita Docker: levanta la pila si no está arriba, y corre las pruebas dentro de un contenedor. Termina con
código 0 si todas pasan.

Con Node 24 instalado, las mismas pruebas corren desde la máquina, con la pila arriba:

```bash
npm ci
npm test                 # todas
npm run test:unit        # solo las unitarias, sin la pila
npm run test:integration # solo las de integración
```

- `API_URL` y `KEYCLOAK_URL` cambian las direcciones (por defecto `http://localhost:3000` y
  `http://localhost:8080`). `TEST_DATABASE_URL` es la conexión directa a la base como `mc_owner` (por defecto
  `postgres://mc_owner:mc_owner_dev@localhost:5432/medicitas`), que algunas pruebas usan solo para preparar datos y
  verificar el resultado; lo que se prueba siempre pasa por la API.
- El nombre de cada prueba empieza con los requisitos e invariantes que cubre, por ejemplo
  `I5: un usuario de otra clínica responde 404…`.
- Las pruebas usan los usuarios fijos del seed y crean clínicas, usuarios, horarios y citas con nombres o fechas
  únicas, sin modificar los del seed. Lo que crean queda en la base y en Keycloak hasta un `docker compose down -v`.
- La prueba de carrera (pregunta rectora) está en `tests/integration/appointments.test.js`: dos recepcionistas, y
  después diez clientes, reservan a la vez el último espacio de un profesional, y siempre se concede exactamente
  una reserva.
- Las pruebas de I7 e I8 están en `tests/integration/availability.test.js` y
  `tests/integration/availability-cache.test.js`. Consultan los espacios de un día, reservan, cancelan o reprograman
  uno de los espacios devueltos, y vuelven a consultar. La siguiente consulta tiene que reflejar el cambio. Las de la
  caché, además, comprueban con el header `X-MediCitas-Cache` que la segunda consulta sale de Redis (`hit`) y que el
  cambio la invalida (`miss`). Exigen que Redis esté arriba.

### Medición de carga de RF7

`tests/load/availability.js` mide la consulta de disponibilidad (RF7) con [k6](https://k6.io), una herramienta de
pruebas de carga que corre en Docker, sin instalar nada. Con la pila arriba:

```bash
docker run --rm -i --network medicitas_default grafana/k6:1.3.0 run - < tests/load/availability.js
```

Durante 30 segundos, 50 usuarios simultáneos consultan sin pausas los espacios de un profesional en un día al azar
de las próximas dos semanas del seed, siempre a través del gateway y con un token real. Se mide cuántas consultas
por segundo se atienden y el **p95**, el tiempo dentro del cual responde el 95 % de las consultas. `cache_hits` es
el porcentaje de respuestas que salieron de la caché de Redis (header `X-MediCitas-Cache: hit`).

Para medir con varias copias de `agenda`, como las que agrega el HPA en Kubernetes, se levantan antes con
`docker compose up -d --scale agenda=3 --wait` y `docker compose restart gateway`, para que el gateway las vea a todas.

Resultados del 2026-11-11, sin errores en ninguna medición:

| Copias de `agenda` | Caché de RF7 | Consultas por segundo | p95 | CPU de PostgreSQL | Aciertos de la caché |
|---|---|---|---|---|---|
| 1 | No | ~716 | 111 ms | ~270 % | — |
| 1 | Sí | ~963 | 81 ms | ~190 % | 100 % |
| 3 | No | ~1 714 | 46 ms | ~820 % | — |
| 3 | Sí | ~2 415 | 37 ms | ~560 % | 99,9 % |

Lo que muestran:

- **La caché reduce a la mitad el trabajo de la base por consulta.** Con 3 copias, la base atendió un 41 % más de
  consultas usando un 30 % menos de CPU. Lo que sigue llegando a la base en cada consulta es la identidad del token
  y la validación del profesional y el servicio, que son búsquedas por índice.
- **El límite de cada copia es su CPU.** Cada copia de `agenda` usó ~105–115 % en todas las mediciones: el núcleo
  completo que aprovecha un proceso de Node. Por eso la capacidad crece con más copias, y la caché es lo que evita
  que la base se sature al agregarlas.
- **El porcentaje de aciertos es alto porque la prueba es pequeña:** 14 pares de profesional y día, consultados
  durante 30 segundos, menos que lo que dura una copia (60 s). Con más agendas distintas habría más cálculos en la
  base.

Todo corre en la misma máquina (16 hilos, Docker Desktop), incluso k6. Las cifras solo sirven para comparar entre
sí mediciones hechas en la misma máquina.

## Diseño de la base de datos (PostgreSQL)

### Convenciones
- Nombres: este documento usa camelCase; en SQL (`db/sql/01-schema.sql`) se escriben en snake_case
  (`clinicId` → `clinic_id`, `ServicesPerProfessionals` → `services_per_professionals`), porque PostgreSQL
  convierte a minúsculas todo identificador sin comillas.
- [tenant]: el tenant es la clínica. Las tablas marcadas con [tenant] contienen datos que pertenecen a una sola
  clínica y llevan la columna `clinicId`. Las tablas sin la marca son catálogos globales (países, especialidades,
  estados de cita...) o heredan la clínica de su tabla padre (se indica como "tenant implícito").
- NOT NULL por defecto: toda columna es `NOT NULL` salvo que diga explícitamente `NULL`.
- Extensión `btree_gist`: el esquema debe ejecutar `CREATE EXTENSION IF NOT EXISTS btree_gist;` antes de crear
  las tablas. Es necesaria para las restricciones `EXCLUDE` y los índices GiST que combinan un entero (`=`) con un
  rango (`&&`).
- Tipos: las PK son `INT GENERATED ALWAYS AS IDENTITY` (`BIGINT` en tablas de alto volumen; `SMALLINT` con valores fijos en catálogos que el código referencia por id). Todo instante es `TIMESTAMPTZ` y todo intervalo de tiempo es `TSTZRANGE` con límites `[inicio, fin)`.
- Columnas de control: `isActive` es `DEFAULT true` (baja lógica), `createdAt` y `updatedAt` son
  `DEFAULT now()`, y `updatedBy` es obligatorio. Los registros que crea el seed apuntan al usuario `Sistema`
  (userId 1). Las FKs de `updatedBy` son `DEFERRABLE INITIALLY DEFERRED` porque `Roles` y `Users` se referencian
  mutuamente: el seed inserta los roles y el usuario `Sistema` en la misma transacción y la FK se revisa al confirmar.
- Notación de FKs: una FK simple se marca en la columna como `(FK → Tabla)`. Una columna que forma parte de una
  FK compuesta se marca `(FK compuesta)` y la FK se declara al final de la tabla como `FK (a, b) → Tabla(x, y)`,
  que es una sola FK de dos columnas.
- Las credenciales (contraseña, sesiones, login) viven en Keycloak, no en este modelo.

==============================================================
|        			    GEOGRAPHY			                  |
==============================================================

## Countries
- countryId : INT GENERATED ALWAYS AS IDENTITY (PK)
- isoCode : CHAR(3) UNIQUE
- countryName : VARCHAR(50)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## States
- stateId : INT GENERATED ALWAYS AS IDENTITY (PK)
- countryId : INT (FK → Countries)
- stateName : VARCHAR(40)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## Cities
- cityId : INT GENERATED ALWAYS AS IDENTITY (PK)
- stateId : INT (FK → States)
- cityName : VARCHAR(50)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## Addresses
- addressId : INT GENERATED ALWAYS AS IDENTITY (PK)
- cityId : INT (FK → Cities)
- address : VARCHAR(100)
- zipCode : VARCHAR(20) NULL
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

==============================================================
|        			        USERS 		                     |
==============================================================

## Permissions
- permissionId : INT GENERATED ALWAYS AS IDENTITY (PK)
- permissionName : VARCHAR(50) UNIQUE
- description : VARCHAR(200) NULL
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## Roles (1 platform_admin, 2 clinic_admin, 3 reception, 4 professional)
Ids fijos porque las restricciones `CHECK` de `Users` y `Professionals` los usan como constantes.
- roleId : SMALLINT (PK)
- roleName : VARCHAR(50) UNIQUE - mismo nombre que el rol en Keycloak
- description : VARCHAR(150) NULL
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## PermissionsPerRoles
- permissionPerRoleId : INT GENERATED ALWAYS AS IDENTITY (PK)
- roleId : SMALLINT (FK → Roles)
- permissionId : INT (FK → Permissions)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- UNIQUE (roleId, permissionId)

## Users
- userId : INT GENERATED ALWAYS AS IDENTITY (PK)
- keycloakSub : UUID UNIQUE - identificador que emite Keycloak (claim `sub`)
- clinicId : INT (FK → Clinics) NULL - NULL solo para el administrador de plataforma (RF2: un usuario pertenece a exactamente una clínica)
- roleId : SMALLINT (FK → Roles)
- name : VARCHAR(50)
- lastName : VARCHAR(50)
- isActive : BOOLEAN - baja lógica (RF2)
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- UNIQUE (clinicId, userId) - destino de las FKs compuestas que garantizan el mismo tenant
- UNIQUE (userId, roleId) - destino de la FK de `Professionals` que garantiza el rol
- CHECK ((roleId = 1) = (clinicId IS NULL)) - el administrador de plataforma, y solo él, no tiene clínica

Usuario `Sistema` (userId 1): primer registro del seed, con rol `platform_admin`, `isActive = false`, `keycloakSub`
igual al UUID nulo (`00000000-0000-0000-0000-000000000000`, que ningún token de Keycloak trae) y `updatedBy`
apuntándose a sí mismo. No puede iniciar sesión; solo sirve como autor de los datos iniciales.

## Professionals (especialización 1:1 de Users; tenant implícito vía Users)
La PK es el mismo `userId`: un profesional es un usuario con datos extra. No guarda `clinicId`, porque ya
viene de `Users`. En las demás tablas, la columna `professionalId` contiene ese `userId` y lleva dos FKs:
- `(clinicId, professionalId) → Users(clinicId, userId)`: el profesional es de la misma clínica (I5).
- `professionalId → Professionals(userId)`: ese usuario realmente es un profesional.

- userId : INT (PK, FK → Users)
- roleId : SMALLINT DEFAULT 4 - columna que solo existe para la restricción de rol
- licenseNumber : VARCHAR(30) - código del colegio profesional
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- CHECK (roleId = 4)
- FK (userId, roleId) → Users(userId, roleId) - solo un usuario con rol `professional` puede estar aquí; si luego se le intenta cambiar el rol en `Users`, el par (userId, 4) sigue referenciado y el cambio se rechaza

## SpecialtiesPerProfessionals (tenant implícito vía professionalId)
Sin `clinicId`: las especialidades son un catálogo global y esta tabla solo se consulta a través del profesional
(ver la regla de `clinicId` en Normalización).
- specialtyPerProfessionalId : INT GENERATED ALWAYS AS IDENTITY (PK)
- professionalId : INT (FK → Professionals(userId))
- specialtyId : INT (FK → Specialties)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- UNIQUE (professionalId, specialtyId)

## ServicesPerProfessionals [tenant] (RF4: servicios que el profesional está habilitado para atender)
- servicePerProfessionalId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- professionalId : INT (FK compuesta)
- serviceId : INT (FK compuesta)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, professionalId) → Users(clinicId, userId)
- FK professionalId → Professionals(userId)
- FK (clinicId, serviceId) → Services(clinicId, serviceId)
- UNIQUE (clinicId, professionalId, serviceId) - evita asociar dos veces el mismo servicio y es el destino de la FK desde Appointments

==============================================================
|        			   AGENDA (horarios y bloqueos)          |
==============================================================

## ProfessionalSchedules [tenant] (RF5: bloques de atención, varios por día, pueden variar de una semana a otra)
Cada fila es un bloque concreto de atención (p. ej. lunes 2026-11-02 08:00–12:00). El horario semanal se define
cargando los bloques de esa semana; si la semana siguiente cambia, se cargan otros bloques. Los bloques se generan
a partir de la hora local de la clínica (`Clinics.timeZone`) y se guardan como instantes absolutos.
- scheduleId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- professionalId : INT (FK compuesta)
- period : TSTZRANGE - `[inicio, fin)` del bloque
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, professionalId) → Users(clinicId, userId)
- FK professionalId → Professionals(userId)
- CHECK (NOT isempty(period)) - un rango vacío (`[08:00, 08:00)`) es un valor válido distinto de NULL; se prohíbe porque un bloque de cero minutos no tiene sentido y además nunca se solaparía con nada
- EXCLUDE USING gist (professionalId WITH =, period WITH &&) - un profesional no tiene bloques solapados

## Blockades [tenant] (RF6: vacaciones o permisos)
- blockadeId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- professionalId : INT (FK compuesta)
- period : TSTZRANGE - `[inicio, fin)` del bloqueo
- reason : TEXT NULL
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, professionalId) → Users(clinicId, userId)
- FK professionalId → Professionals(userId)
- CHECK (NOT isempty(period))

==============================================================
|        				   PATIENTS                          |
==============================================================

## Patients [tenant] (RF14 — no son usuarios del sistema, no tienen credenciales)
- patientId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK → Clinics)
- identification : VARCHAR(30)
- name : VARCHAR(50)
- lastName : VARCHAR(50)
- birthDate : DATE
- genderId : SMALLINT (FK → Genders) NULL - NULL si el paciente no lo indica
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- UNIQUE (clinicId, identification)
- UNIQUE (clinicId, patientId) - destino de las FKs compuestas

## Genders (femenino, masculino, otro, prefiere no decir)
- genderId : SMALLINT (PK)
- genderName : VARCHAR(30) UNIQUE

## ContactTypes (Telefono, email)
- contactTypeId : INT GENERATED ALWAYS AS IDENTITY (PK)
- contactTypeName : VARCHAR(50) UNIQUE
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## PatientContacts [tenant] (dato sensible: toda lectura/escritura se registra en la bitácora, RF18)
- contactId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- patientId : INT (FK compuesta)
- contactTypeId : INT (FK → ContactTypes)
- contactValue : VARCHAR(320) - 320 por el máximo de un correo (RFC 5321)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, patientId) → Patients(clinicId, patientId)

## ProfessionalContacts [tenant] (para que recepción pueda contactar al profesional)
Tabla separada de `PatientContacts` porque tienen reglas distintas: los contactos de pacientes van a la
bitácora (RF18) y los de profesionales no; y así cada FK es obligatoria en lugar de tener dos FKs opcionales.
- contactId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- professionalId : INT (FK compuesta)
- contactTypeId : INT (FK → ContactTypes)
- contactValue : VARCHAR(320)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, professionalId) → Users(clinicId, userId)
- FK professionalId → Professionals(userId)
- UNIQUE (professionalId, contactTypeId, contactValue)

==============================================================
|        			 Clinics and appointments                |
==============================================================
## Clinics
- clinicId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicCode : VARCHAR(30) UNIQUE - identificador de la clínica (RF1)
- clinicName : VARCHAR(75)
- timeZone : VARCHAR(64) - nombre IANA, p. ej. `America/Costa_Rica`; el backend lo valida contra `pg_timezone_names`
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## ClinicsAddresses
- clinicAddressId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK → Clinics)
- addressId : INT (FK → Addresses)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)

## Specialties
- specialtyId : INT GENERATED ALWAYS AS IDENTITY (PK)
- specialtyName : VARCHAR(50) UNIQUE

## Services [tenant] (RF3)
- serviceId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK → Clinics)
- serviceName : VARCHAR(63)
- durationMinutes : INT
- specialtyId : INT (FK → Specialties)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- CHECK (durationMinutes > 0)
- UNIQUE (clinicId, serviceId) - destino de las FKs compuestas

## AppointmentStatuses (1 reservada, 2 atendida, 3 ausente, 4 cancelada, 5 reprogramada)
- appointmentStatusId : SMALLINT (PK)
- statusName : VARCHAR(12) UNIQUE
- isFinal : BOOLEAN - los cuatro estados finales no admiten salida (RF13)

## Appointments [tenant]
- appointmentId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- patientId : INT (FK compuesta)
- professionalId : INT (FK compuesta)
- serviceId : INT (FK compuesta)
- appointmentStatusId : SMALLINT (FK → AppointmentStatuses) DEFAULT 1
- period : TSTZRANGE - `[inicio, inicio + duración del servicio)`; lo calcula un trigger, la aplicación solo envía el inicio (I4)
- appointmentDescription : TEXT NULL - motivo de la consulta
- cancelReason : TEXT NULL (RF11)
- cancelledBy : INT (FK compuesta) NULL (RF11)
- cancelledAt : TIMESTAMPTZ NULL
- rescheduledFromId : BIGINT (FK compuesta) NULL - la cita nueva apunta a la que reemplaza (RF10)
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, patientId) → Patients(clinicId, patientId)
- FK (clinicId, professionalId) → Users(clinicId, userId)
- FK professionalId → Professionals(userId)
- FK (clinicId, serviceId) → Services(clinicId, serviceId)
- FK (clinicId, professionalId, serviceId) → ServicesPerProfessionals(clinicId, professionalId, serviceId) - solo se reserva un servicio que el profesional atiende
- FK (clinicId, cancelledBy) → Users(clinicId, userId) - quien cancela es de la misma clínica
- FK (clinicId, rescheduledFromId) → Appointments(clinicId, appointmentId) - la cita original es de la misma clínica
- UNIQUE (clinicId, appointmentId) - destino de las FKs compuestas
- UNIQUE (rescheduledFromId) - una cita solo se reprograma una vez
- CHECK ((appointmentStatusId = 4) = (cancelReason IS NOT NULL AND cancelledBy IS NOT NULL AND cancelledAt IS NOT NULL))
- EXCLUDE USING gist (professionalId WITH =, period WITH &&) WHERE (appointmentStatusId = 1) - I1
- EXCLUDE USING gist (patientId WITH =, period WITH &&) WHERE (appointmentStatusId = 1) - I2

Reprogramar (RF10) = en una sola transacción, pasar la cita original a `reprogramada` e insertar la nueva con
`rescheduledFromId`. Como la original deja de estar `reservada`, su espacio sale de la restricción `EXCLUDE` en el
mismo commit en que se ocupa el nuevo.

## ClinicalNotes [tenant] (RF15 — dato más sensible)
No guarda `professionalId`: el autor es, por definición, el profesional de la cita (`Appointments.professionalId`).
Guardarlo otra vez sería una copia que podría dejar de coincidir. El backend verifica que la cita esté `atendida` y
que el usuario del token sea su profesional antes de insertar.
- clinicalNoteId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- appointmentId : BIGINT (FK compuesta) UNIQUE - una nota por cita
- noteText : TEXT
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK → Users)
- FK (clinicId, appointmentId) → Appointments(clinicId, appointmentId)

==============================================================
|        					logs              	 	         |
==============================================================
## eventTypes (read, create, update, ...)
- eventTypeId : SMALLINT (PK)
- name : VARCHAR(50) UNIQUE
- description : VARCHAR(150)

## dataObjects (clinical_note, patient_contact, ...)
- dataObjectId : SMALLINT (PK)
- name : VARCHAR(50) UNIQUE
- description : VARCHAR(100)

## severities
- severityId : SMALLINT (PK)
- name : VARCHAR(50) UNIQUE
- description : VARCHAR(100)

## auditLogs [tenant] (RF18 / RF19 / §9 — append-only protegida en el motor, I6, y con cadena de huellas SHA-256)
- logId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK compuesta)
- userId : INT (FK compuesta) - quién
- eventTypeId : SMALLINT (FK → eventTypes) - qué acción
- dataObjectId : SMALLINT (FK → dataObjects) - sobre qué tipo de dato
- objectId : BIGINT - id del registro tocado (nota o contacto); sin FK porque puede apuntar a tablas distintas según `dataObjectId`
- patientId : INT (FK compuesta) - sobre cuál paciente
- description : VARCHAR(255)
- metadata : JSONB NULL
- createdAt : TIMESTAMPTZ DEFAULT now() - cuándo
- prevHash : CHAR(64) NULL - huella SHA-256 del registro anterior de la misma clínica (`NULL` en el primero)
- rowHash : CHAR(64) - huella SHA-256 del contenido del registro encadenada con `prevHash`
- FK (clinicId, userId) → Users(clinicId, userId)
- FK (clinicId, patientId) → Patients(clinicId, patientId)

Protección: ningún rol de la aplicación tiene `UPDATE`, `DELETE` ni `TRUNCATE` sobre esta tabla, un trigger
`BEFORE UPDATE OR DELETE` lanza una excepción (`MC005`) aunque alguien conceda el permiso por error (I6), y un
trigger `BEFORE INSERT` encadena cada fila con SHA-256 por clínica para detectar cualquier manipulación hecha por
fuera de la aplicación (Módulo §9).

## systemErrorsLogs
- errorId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- severityId : SMALLINT (FK → severities)
- processUuid : UUID NULL
- processName : VARCHAR(100)
- stepName : VARCHAR(100) NULL
- inputData : JSONB NULL
- errorMessage : TEXT
- metadata : JSONB NULL
- createdAt : TIMESTAMPTZ DEFAULT now()

==============================================================
|        					ÍNDICES              	 	     |
==============================================================

Postgres crea automáticamente un índice por cada PK, `UNIQUE` y `EXCLUDE`, pero no por cada FK. Cada índice se
justifica abajo con `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)` sobre los datos semilla de `db/sql/04-seed.sql`
(`appointments`: 4 014 filas; `audit_logs`: 5 331; `clinical_notes`: 1 317; `professional_schedules`: 816;
`patient_contacts`: 407; `patients`: 240).

### Creados por restricciones (no se declaran aparte)
| Índice | Tipo | Consulta que sirve |
|---|---|---|
| `EXCLUDE` de ProfessionalSchedules `(professionalId, period)` | GiST | RF7: bloques de un profesional que tocan una fecha |
| `EXCLUDE` I1 de Appointments `(professionalId, period) WHERE reservada` | GiST parcial | RF7: citas vigentes del profesional en una fecha; además garantiza I1 |
| `EXCLUDE` I2 de Appointments `(patientId, period) WHERE reservada` | GiST parcial | Garantiza I2 |
| `UNIQUE (clinicId, identification)` de Patients | B-tree | RF14: buscar paciente por identificación |
| `UNIQUE (clinicId, userId)` de Users | B-tree | RF2: listar usuarios de una clínica |

### Declarados explícitamente
```sql
-- RF6 (citas en conflicto con un bloqueo) y RF7 (restar bloqueos a la disponibilidad)
CREATE INDEX ix_blockades_prof_period      ON Blockades USING gist (professionalId, period);

-- RF8: profesionales que atienden un servicio (el UNIQUE pone professionalId antes que serviceId)
CREATE INDEX ix_spp_clinic_service         ON ServicesPerProfessionals (clinicId, serviceId);

-- RF20 (agenda del día de la clínica) y RF21 (conteo por estado en un rango de fechas)
CREATE INDEX ix_appointments_clinic_start  ON Appointments (clinicId, lower(period));

-- RF20 (agenda del día de un profesional, en todos los estados; el índice del EXCLUDE solo tiene las reservadas)
CREATE INDEX ix_appointments_prof_start    ON Appointments (professionalId, lower(period));

-- RF16: historial de citas de un paciente
CREATE INDEX ix_appointments_patient_start ON Appointments (patientId, lower(period));

-- RF14 / RF18: contactos de un paciente
CREATE INDEX ix_patient_contacts_patient   ON PatientContacts (patientId);

-- RF19: bitácora filtrada por paciente, por usuario o solo por rango de fechas
CREATE INDEX ix_audit_clinic_patient_date  ON auditLogs (clinicId, patientId, createdAt);
CREATE INDEX ix_audit_clinic_user_date     ON auditLogs (clinicId, userId, createdAt);
CREATE INDEX ix_audit_clinic_date          ON auditLogs (clinicId, createdAt);

-- Módulo §9: último registro por clínica al encadenar y recorrido ordenado al verificar la cadena
CREATE INDEX ix_audit_clinic_log           ON auditLogs (clinicId, logId);
```
Los índices sobre `lower(period)` solo se usan si la consulta filtra con la misma expresión, por ejemplo
`WHERE clinicId = $1 AND lower(period) >= $2 AND lower(period) < $3`.

No se crea un índice aparte sobre `ProfessionalSchedules (clinicId, professionalId, period)`: el del `EXCLUDE` ya
cubre `(professionalId, period)` y anteponer `clinicId` no filtra nada más, porque cada profesional pertenece a
una sola clínica. Solo encarecería las escrituras.

### Justificación con `EXPLAIN ANALYZE` sobre los datos semilla

#### 1. Disponibilidad por profesional y día (RF7, I3, I1): `ex_schedules_overlap` y `ex_appointments_professional`
Las dos restricciones `EXCLUDE USING gist` cumplen una doble función: impiden solapamientos al escribir y sirven
como índices espaciales GiST para el operador de solapamiento de rangos (`&&`) al calcular los huecos libres de un
día (`services/agenda/src/availability.js`). Como la consulta solo proyecta `period`, PostgreSQL resuelve ambas
con **Index Only Scan**:

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT period FROM agenda.professional_schedules
 WHERE professional_id = 6
   AND period && tstzrange('2026-11-16 00:00:00-06', '2026-11-17 00:00:00-06', '[)');
```
```text
Index Only Scan using ex_schedules_overlap on professional_schedules (actual time=3.822..3.824 rows=2.00 loops=1)
  Index Cond: ((professional_id = 6) AND (period && '["2026-11-16 06:00:00+00","2026-11-17 06:00:00+00")'::tstzrange))
  Heap Fetches: 2
  Index Searches: 1
```

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT period FROM agenda.appointments
 WHERE professional_id = 6
   AND appointment_status_id = 1
   AND period && tstzrange('2026-11-16 00:00:00-06', '2026-11-17 00:00:00-06', '[)');
```
```text
Index Only Scan using ex_appointments_professional on appointments (actual time=0.501..0.503 rows=6.00 loops=1)
  Index Cond: ((professional_id = 6) AND (period && '["2026-11-16 06:00:00+00","2026-11-17 06:00:00+00")'::tstzrange))
  Heap Fetches: 0
  Index Searches: 1
  Buffers: shared hit=1 read=2
```

#### 2. Agenda de la clínica y reportes por rango de fechas (RF20, RF21): `ix_appointments_clinic_start`
Filtra por `clinic_id` y por la expresión funcional `lower(period)`. Sobre las 4 014 citas del seed, lee únicamente
9 bloques del heap en lugar de recorrer toda la tabla:

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT appointment_id, appointment_status_id, period
  FROM agenda.appointments
 WHERE clinic_id = 1
   AND lower(period) >= '2026-11-01 00:00:00-06'
   AND lower(period) <  '2026-11-08 00:00:00-06';
```
```text
Bitmap Heap Scan on appointments (actual time=0.719..1.887 rows=112.00 loops=1)
  Recheck Cond: ((clinic_id = 1) AND (lower(period) >= '2026-11-01 06:00:00+00'::timestamptz) AND (lower(period) < '2026-11-08 06:00:00+00'::timestamptz))
  Heap Blocks: exact=9
  Buffers: shared hit=1 read=11
  ->  Bitmap Index Scan on ix_appointments_clinic_start (actual time=0.682..0.682 rows=112.00 loops=1)
        Index Cond: ((clinic_id = 1) AND (lower(period) >= '2026-11-01 06:00:00+00'::timestamptz) AND (lower(period) < '2026-11-08 06:00:00+00'::timestamptz))
```

#### 3. Agenda de un profesional en todos los estados (RF20): `ix_appointments_prof_start`
El índice parcial `ex_appointments_professional` solo indexa citas `reservada` (`appointment_status_id = 1`). Para
ver la agenda completa de un profesional incluyendo citas atendidas, ausentes y canceladas (RF20), el planificador
usa `ix_appointments_prof_start`:

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT appointment_id, appointment_status_id, period
  FROM agenda.appointments
 WHERE professional_id = 6
   AND lower(period) >= '2026-11-01 00:00:00-06'
   AND lower(period) <  '2026-11-08 00:00:00-06';
```
```text
Bitmap Heap Scan on appointments (actual time=0.386..0.394 rows=50.00 loops=1)
  Recheck Cond: ((professional_id = 6) AND (lower(period) >= '2026-11-01 06:00:00+00'::timestamptz) AND (lower(period) < '2026-11-08 06:00:00+00'::timestamptz))
  Heap Blocks: exact=7
  Buffers: shared hit=8 read=2
  ->  Bitmap Index Scan on ix_appointments_prof_start (actual time=0.380..0.380 rows=50.00 loops=1)
        Index Cond: ((professional_id = 6) AND (lower(period) >= '2026-11-01 06:00:00+00'::timestamptz) AND (lower(period) < '2026-11-08 06:00:00+00'::timestamptz))
```

#### 4. Historial de citas de un paciente (RF16): `ix_appointments_patient_start`
Recupera las 15 citas históricas y futuras de un paciente entre las 4 014 filas sin recorrido secuencial:

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT appointment_id, professional_id, service_id, appointment_status_id, period
  FROM agenda.appointments
 WHERE clinic_id = 1 AND patient_id = 10
 ORDER BY lower(period) DESC;
```
```text
Sort (actual time=1.097..1.097 rows=15.00 loops=1)
  Sort Key: (lower(period)) DESC
  Sort Method: quicksort  Memory: 25kB
  ->  Bitmap Heap Scan on appointments (actual time=0.024..1.064 rows=15.00 loops=1)
        Recheck Cond: (patient_id = 10)
        Filter: (clinic_id = 1)
        Heap Blocks: exact=15
        ->  Bitmap Index Scan on ix_appointments_patient_start (actual time=0.016..0.016 rows=15.00 loops=1)
              Index Cond: (patient_id = 10)
```

#### 5. Contactos de un paciente (RF14, RF18): `ix_patient_contacts_patient`
```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT contact_id, contact_type_id, contact_value
  FROM clinical.patient_contacts
 WHERE clinic_id = 1 AND patient_id = 10 AND is_active;
```
```text
Bitmap Heap Scan on patient_contacts (actual time=0.041..0.042 rows=2.00 loops=1)
  Recheck Cond: (patient_id = 10)
  Filter: (is_active AND (clinic_id = 1))
  Heap Blocks: exact=2
  ->  Bitmap Index Scan on ix_patient_contacts_patient (actual time=0.036..0.036 rows=2.00 loops=1)
        Index Cond: (patient_id = 10)
```

#### 6. Consultas de la bitácora de auditoría (RF19): `ix_audit_clinic_patient_date`, `ix_audit_clinic_user_date`, `ix_audit_clinic_date`
Sobre las 5 331 entradas de `clinical.audit_logs`, cada combinación de filtros de RF19 (por paciente + fechas, por
usuario + fechas o solo por fechas de la clínica) utiliza su índice compuesto específico:

```sql
-- Por paciente y rango de fechas:
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT log_id, user_id, event_type_id, data_object_id, object_id, created_at
  FROM clinical.audit_logs
 WHERE clinic_id = 1 AND patient_id = 10 AND created_at >= now() - interval '30 days'
 ORDER BY created_at DESC;
```
```text
Sort (actual time=0.530..0.531 rows=12.00 loops=1)
  Sort Key: created_at DESC
  ->  Bitmap Heap Scan on audit_logs (actual time=0.463..0.515 rows=12.00 loops=1)
        Recheck Cond: ((clinic_id = 1) AND (patient_id = 10) AND (created_at >= (now() - '30 days'::interval)))
        ->  Bitmap Index Scan on ix_audit_clinic_patient_date (actual time=0.451..0.451 rows=12.00 loops=1)
```

```sql
-- Por usuario y rango de fechas:
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT log_id, patient_id, event_type_id, data_object_id, object_id, created_at
  FROM clinical.audit_logs
 WHERE clinic_id = 1 AND user_id = 4 AND created_at >= now() - interval '30 days'
 ORDER BY created_at DESC;
```
```text
Sort (actual time=1.317..1.342 rows=820.00 loops=1)
  Sort Key: created_at DESC
  ->  Bitmap Heap Scan on audit_logs (actual time=1.045..1.196 rows=820.00 loops=1)
        Recheck Cond: ((clinic_id = 1) AND (user_id = 4) AND (created_at >= (now() - '30 days'::interval)))
        ->  Bitmap Index Scan on ix_audit_clinic_user_date (actual time=1.029..1.029 rows=820.00 loops=1)
```

```sql
-- Solo por clínica y rango de fechas:
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT log_id, user_id, patient_id, event_type_id, created_at
  FROM clinical.audit_logs
 WHERE clinic_id = 1 AND created_at >= now() - interval '7 days'
 ORDER BY created_at DESC;
```
```text
Sort (actual time=0.704..0.720 rows=497.00 loops=1)
  Sort Key: created_at DESC
  ->  Bitmap Heap Scan on audit_logs (actual time=0.566..0.638 rows=497.00 loops=1)
        Recheck Cond: ((clinic_id = 1) AND (created_at >= (now() - '7 days'::interval)))
        ->  Bitmap Index Scan on ix_audit_clinic_date (actual time=0.557..0.557 rows=497.00 loops=1)
```

#### 7. Tablas de catálogo/configuración de una sola página en el seed (`ix_spp_clinic_service`, `ix_blockades_prof_period`, `users_keycloak_sub_key`)
En el seed, `services_per_professionals` (18 filas), `blockades` (4 filas) y `users` (20 filas) caben cada una en
**una sola página de 8 KB** (`Buffers: shared hit=1`). El optimizador de costos de PostgreSQL elige `Seq Scan`
cuando una tabla ocupa 1 página porque un `Index Scan` leería al menos 2 páginas (1 del índice + 1 de la tabla). Al
crecer el número de clínicas y profesionales, o al deshabilitar `enable_seqscan` para verificar la estructura del
índice, PostgreSQL utiliza el índice directamente:

```sql
SET LOCAL enable_seqscan = off;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT professional_id
  FROM admin.services_per_professionals
 WHERE clinic_id = 1 AND service_id = 1 AND is_active;
```
```text
Index Scan using ix_spp_clinic_service on services_per_professionals (actual time=0.270..0.271 rows=1.00 loops=1)
  Index Cond: ((clinic_id = 1) AND (service_id = 1))
  Filter: is_active
```

==============================================================
|        			   DECISIONES DE DISEÑO           	     |
==============================================================

### Estrategia de multi-tenancy

Se compararon dos estrategias:

| Criterio | Esquema por tenant (un schema de Postgres por clínica) | Columna discriminadora (`clinicId` en un esquema compartido) |
|---|---|---|
| Aislamiento | Fuerte: las tablas de cada clínica están físicamente separadas | Depende de que toda consulta filtre por `clinicId` |
| Alta de clínica (RF1) | Hay que ejecutar DDL en caliente (`CREATE SCHEMA` + todas las tablas); la aplicación necesitaría permiso `CREATE`, lo que choca con el menor privilegio | Es un `INSERT` en `Clinics` |
| Migraciones | Cada cambio de esquema se aplica N veces, una por clínica | Se aplica una vez |
| Consultas globales (admin de plataforma, analítica de la Etapa 2) | Requieren `UNION` sobre todos los schemas | Una consulta normal, agrupando por `clinicId` |
| Riesgo típico | Olvidar fijar el `search_path` de la conexión, con lo que la consulta cae en el schema de otra clínica | Olvidar el `WHERE clinicId = ...` |
| Integridad entre clínicas | Imposible referenciar otra clínica | Se garantiza con FKs compuestas `(clinicId, id)` |
| Escala | El catálogo de Postgres crece con cada clínica | Una sola copia de las tablas; se puede particionar por `clinicId` más adelante |

Se eligió la columna discriminadora. El alta de clínica no requiere DDL ni privilegios elevados, el esquema se
mantiene una sola vez y la Etapa 2 (plataforma distribuida y analítica) parte de tablas únicas.

> La base sí tiene tres schemas (`admin`, `agenda` y `clinical`), pero **son uno por servicio, no uno por
> clínica**. Todas las clínicas comparten las mismas tablas, y el tenant sigue siendo `clinicId`. Ver
> `docs/diseno-servicios.md`, sección 5. Su debilidad, que una
consulta olvide el filtro, se mitiga en tres capas:
1. El `clinicId` sale siempre de la identidad (token → `Users.keycloakSub` → `Users.clinicId`), nunca de un parámetro de la petición.
2. Las FKs compuestas hacen imposible, en el motor, que un registro de una clínica apunte a otro de otra clínica.
3. Pruebas automatizadas de fuga que manipulan el identificador de clínica en los parámetros (I5).

Row-Level Security quedaría como una capa adicional sobre esta misma columna; no se implementa en esta etapa.

### Normalización (1FN → 3FN)

- 1FN (valores atómicos, sin grupos repetidos): los contactos van en tablas propias en lugar de columnas
  `telefono1`, `telefono2`; las especialidades y los servicios de un profesional van en tablas puente en lugar de
  listas; cada bloque de horario es una fila, no una columna por día. Un `TSTZRANGE` se considera atómico: es un
  tipo escalar de Postgres que se compara y se indexa como una unidad, igual que una fecha.
- 2FN (sin dependencias parciales de una clave compuesta): todas las tablas usan una PK simple. En las tablas
  puente se revisó la clave natural: en `SpecialtiesPerProfessionals (professionalId, specialtyId)` no hay atributos
  que dependan de solo una parte; en `ServicesPerProfessionals (professionalId, serviceId)` el `clinicId` depende solo
  de `professionalId`, y es una desnormalización deliberada (ver abajo).
- 3FN (sin dependencias transitivas):
  - La especialidad dejó de estar en `Users` y en una tabla puente a la vez; vive solo en `SpecialtiesPerProfessionals`.
  - La zona horaria pasó de `States` a `Clinics`, que es de quien depende (RF1).
  - `Professionals` no repite la clínica: la toma de `Users`.
  - `ClinicalNotes` no repite el profesional: lo toma de la cita.
  - Los nombres de estados, géneros, tipos de contacto y roles viven en catálogos, no repetidos como texto en cada fila.
  - El servicio de una cita es una FK directa (relación 1 a N) en lugar de una tabla `ServicesPerAppointments`.

### Desnormalizaciones deliberadas

1. Regla del `clinicId`. Se guarda `clinicId` en toda tabla que la API consulta o modifica por su propio id
   (`ProfessionalSchedules`, `Blockades`, `PatientContacts`, `ProfessionalContacts`, `Appointments`, `ClinicalNotes`,
   `auditLogs`), aunque se pueda derivar del padre. Es la columna discriminadora: cada consulta filtra por ella sin
   joins, y las FKs compuestas la usan para impedir referencias entre clínicas. Las tablas que solo se leen a través
   de su padre (`SpecialtiesPerProfessionals`, `Professionals`) no la llevan.
2. `ServicesPerProfessionals.clinicId`. Además de lo anterior, es la columna que comparten las dos FKs
   compuestas, lo que obliga a que profesional y servicio sean de la misma clínica.
3. Fin de la cita (`upper(Appointments.period)`). Se puede derivar de `serviceId` + inicio. Se guarda porque
   (a) la restricción `EXCLUDE` solo puede usar columnas de la propia fila, no consultar `Services`; y (b) la cita
   conserva la duración con la que se reservó aunque el servicio cambie después su duración.
4. `Professionals.roleId`. Siempre vale 4; existe solo para que la FK `(userId, roleId)` garantice que el
   usuario tenga el rol `professional`.

### Concurrencia y nivel de aislamiento

Pregunta rectora: dos recepcionistas reservan el último espacio exactamente al mismo tiempo.

Se usa READ COMMITTED. Es el nivel por defecto de Postgres, pero no se deja a ese valor por omisión: toda
transacción de la API pasa por `withTransaction` (`packages/common/src/db.js`), que abre con
`BEGIN ISOLATION LEVEL READ COMMITTED` y luego hace `SET LOCAL ROLE` al rol de base de la petición. El proyecto
no usa ORM, así que no hay otra capa que pueda cambiar el nivel. Es suficiente porque la exclusión no depende
del nivel de aislamiento sino de la restricción `EXCLUDE`:

1. Las dos transacciones intentan insertar una cita del mismo profesional con periodos que se solapan.
2. La primera inserta y deja su fila en el índice del `EXCLUDE`, todavía sin confirmar.
3. La segunda, al insertar, encuentra esa fila en conflicto y espera a que la primera termine.
4. Si la primera confirma, la segunda falla con `23P01` (`exclusion_violation`) y la API responde 409 espacio ya
   tomado. Si la primera hace rollback, la segunda continúa y gana.

Siempre hay exactamente una ganadora, y no existe una ventana en la que ambas "vean libre" el espacio y ambas inserten.

Alternativas consideradas:
- Validar con un `SELECT` antes del `INSERT` en el backend: no funciona; las dos transacciones pueden leer
  "libre" al mismo tiempo y ambas insertan.
- SERIALIZABLE: también evita la doble reserva, pero aborta transacciones con `40001` (incluso falsos positivos),
  obliga a reintentar y afecta a todas las transacciones del sistema.
- `SELECT ... FOR UPDATE` sobre el profesional: funciona, pero depende de que todo camino del código recuerde
  bloquear, y serializa todas las reservas del profesional aunque no se solapen.

Reprogramación (RF10): `UPDATE` de la original a `reprogramada` y luego `INSERT` de la nueva, en la misma
transacción. Si el `INSERT` falla, el rollback deja la original intacta como `reservada`.

Deadlock: puede ocurrir si dos reprogramaciones cruzan espacios (A se mueve al espacio de B y B al de A). Postgres
lo detecta y aborta una con `40P01`. `withTransaction` repite la transacción abortada completa, hasta 3
intentos; para la otra transacción el deadlock no existe. Como la transacción puede repetirse, dentro de ella
solo va trabajo sobre la base: lo externo, como invalidar la caché de Redis, se hace después del COMMIT.
En ese cruce ninguna de las dos puede ganar, porque cada una necesita el espacio que la otra sigue ocupando: las
dos responden 409 y las dos citas originales quedan reservadas. Lo comprueba una prueba automatizada
(`tests/integration/appointment-reschedule.test.js`); sin el reintento, la transacción abortada respondía 500.

I7: como el `EXCLUDE` solo considera las citas `reservada`, al confirmar una cancelación o reprogramación el
espacio queda libre para la siguiente consulta.

### Roles de base de datos (menor privilegio)

| Rol de BD | Tipo | Uso |
|---|---|---|
| `mc_owner` | LOGIN | Dueño del esquema. Solo ejecuta `schema.sql` y el seed. La aplicación nunca lo usa: el dueño puede desactivar triggers y el superusuario ignora los permisos, lo que anularía la protección de la bitácora. |
| `mc_admin_svc`, `mc_agenda_svc`, `mc_clinical_svc` | LOGIN, sin privilegios propios | Un usuario de conexión por servicio, con su `CONNECTION LIMIT` (20, 40 y 20). En cada transacción hace `SET LOCAL ROLE` al rol que trae el token. `mc_admin_svc` puede usar los cuatro roles siguientes; `mc_agenda_svc` y `mc_clinical_svc`, todos menos `mc_platform`. Ver `docs/diseno-servicios.md`, sección 4. |
| `mc_platform`, `mc_clinic_admin`, `mc_reception`, `mc_professional` | NOLOGIN | Llevan los permisos de la tabla siguiente. |

Permisos (S = SELECT, I = INSERT, U = UPDATE, D = DELETE; — = ninguno):

| Tabla | mc_platform | mc_clinic_admin | mc_reception | mc_professional |
|---|---|---|---|---|
| Clinics | S I U | S | S | S |
| Users | S I | S I U | S | S |
| Catálogos (Roles, Specialties, Genders, ContactTypes, AppointmentStatuses...) | S | S | S | S |
| Professionals, SpecialtiesPerProfessionals, ServicesPerProfessionals | — | S I U D | S | S |
| Services | — | S I U | S | S |
| ProfessionalSchedules, Blockades | — | S I U D | S | S I U D |
| Patients, PatientContacts | — | S I U | S I U | S |
| ProfessionalContacts | — | S I U D | S | S |
| Appointments | — | S I U (columnas) | S I U (columnas) | S U (columnas) |
| ClinicalNotes | — | — | — | S I U |
| auditLogs | — | S I | I | I |

En Appointments, el `UPDATE` es solo sobre las columnas `appointmentStatusId`, `cancelReason`, `cancelledBy`, `cancelledAt`, `updatedAt` y
`updatedBy` (`GRANT UPDATE (columnas) ON Appointments`). Así nadie puede cambiar `period` ni `serviceId` (I4).

Las restricciones finas de la matriz ("solo los propios horarios", "solo notas de citas propias") las aplica el
backend filtrando por el usuario del token; los roles de BD garantizan la parte gruesa: por ejemplo, recepción no
puede leer notas clínicas aunque el backend tenga un error.

### Limitaciones
- Una misma persona en dos clínicas se registra como dos usuarios distintos, con dos cuentas de Keycloak(`keycloakSub` es UNIQUE). Es coherente con RF2, que dice que un usuario pertenece a exactamente una clínica, y con el aislamiento: ninguna clínica ve la agenda de la otra, por lo que el sistema no detecta si esa persona tiene citas solapadas en las dos.
- Los horarios se cargan por semana. Si no se cargan los bloques de una semana, ese profesional no tiene disponibilidad esa semana.

==============================================================
|        			    AUTENTICACIÓN           	         |
==============================================================

La API no maneja contraseñas ni emite tokens: eso lo hace Keycloak, configurado desde
`keycloak/medicitas-realm.json` al levantar el compose. El flujo es:

1. El cliente pide un token a Keycloak con su usuario y contraseña.
2. Llama a la API con el header `Authorization: Bearer <token>`.
3. La API valida el token con las llaves públicas del realm (`authenticate` en `packages/common/src/auth.js`).
4. Busca al usuario del token en la base para saber su clínica, su rol y sus permisos (`identify`).
5. La ruta revisa que el rol tenga el permiso que exige (`requirePermission`).

Obtener un token (por ejemplo, para recepción de la clínica San José):
```bash
curl -s -X POST http://localhost:8080/realms/medicitas/protocol/openid-connect/token \
  -d grant_type=password -d client_id=medicitas-api \
  -d username=recepcion.sanjose -d password=medicitas
```
El campo `access_token` de la respuesta es el que se manda a la API:
```bash
curl -s http://localhost:3000/me -H "Authorization: Bearer <access_token>"
```

### Qué se valida del token
- Firma: se verifica con las llaves públicas que publica Keycloak (JWKS). La librería `jose` las descarga
  la primera vez y las guarda en memoria; solo las vuelve a pedir si llega una llave desconocida.
- Algoritmo: solo `RS256`, el que usa Keycloak. Un token con `alg: none` o con otro algoritmo se rechaza.
- `iss`: que lo haya emitido el realm `medicitas`.
- `aud`: que vaya dirigido a `medicitas-api` (lo agrega un mapper del client en el realm).
- `exp`: que no haya expirado.

Las llaves se piden por la red interna de Compose (`keycloak:8080`), pero el `iss` del token es la URL
pública (`localhost:8080`), porque así lo fija `KC_HOSTNAME`. Por eso son dos variables distintas en
`docker-compose.yml`: `KEYCLOAK_JWKS_URL` y `KEYCLOAK_ISSUER`.

### Asociación de la identidad con su clínica
Keycloak no guarda la clínica. Cada usuario del realm tiene un `id` fijo (en `medicitas-realm.json`) que llega
en el token como `sub`, y el seed usa ese mismo valor en `users.keycloak_sub`. La API busca
`users.keycloak_sub = sub` y de esa fila toma `clinic_id`.

Se eligió la base y no un atributo en Keycloak por dos motivos:
- `users.clinic_id` ya tiene que existir para las FKs compuestas; guardarlo también en Keycloak serían dos
  copias del mismo dato que podrían dejar de coincidir.
- Dar de baja a un usuario o a su clínica tiene efecto en la siguiente petición, sin esperar a que su token expire.

A partir de ahí, toda consulta usa ese `clinic_id`. Un `clinicId` que venga en la URL, en el query string o
en el body se ignora; en eso se apoya el aislamiento entre clínicas (I5).

### Roles y permisos
El token trae los roles del realm en `realm_access.roles`, junto con otros que agrega Keycloak
(`offline_access`, `default-roles-medicitas`). Se toman solo los cuatro del dominio y se exige exactamente uno.
Cada uno se traduce a dos cosas:

| Rol del token | Rol de base de datos (`SET LOCAL ROLE`) | Permisos del dominio |
|---|---|---|
| `platform_admin` | `mc_platform` | los de `permissions_per_roles` para ese rol |
| `clinic_admin` | `mc_clinic_admin` | ídem |
| `reception` | `mc_reception` | ídem |
| `professional` | `mc_professional` | ídem |

Además se revisa que el rol del token sea el mismo que tiene el usuario en `users.role_id`.

Cada ruta declara el permiso que necesita, por ejemplo `requirePermission('appointments.manage')`. La
revisión es doble: el backend responde 403 si el rol no tiene el permiso, y aunque el backend tuviera un
error, el rol de base de datos no tiene los GRANT para hacer la operación.

`GET /me` devuelve la identidad resuelta (usuario, clínica, rol y permisos) y sirve para probar todo lo anterior.

### Respuestas
| Caso | Código |
|---|---|
| Sin header `Authorization`, o con un esquema distinto de `Bearer` | 401 |
| Token mal formado, firmado con otra llave, de otro emisor o para otra audiencia | 401 |
| Token expirado | 401 |
| El token no trae exactamente uno de los cuatro roles del dominio | 403 |
| El `sub` no está registrado en `users` (usuario de prueba `sinregistro`) | 403 |
| El usuario o su clínica están dados de baja (usuario de prueba `exrecepcion.sanjose`) | 403 |
| El rol del token no coincide con el registrado en la base | 403 |
| El rol no tiene el permiso que exige la ruta | 403 |
| Keycloak no responde al pedir las llaves | 500 (no es un error del cliente) |
| Todo lo anterior en orden | sigue a la ruta |

Las respuestas 401 llevan el header `WWW-Authenticate: Bearer`, como pide el estándar (RFC 6750).

### Usuarios en Keycloak y en la base
Cada usuario existe en dos lugares: en Keycloak (usuario, contraseña y rol, para iniciar sesión) y en `users`
(clínica y rol, para la API). La API mantiene las dos copias: al dar de alta, cambiar el rol o dar de baja
(RF1, RF2) actualiza ambos lados, sin pasos manuales en la consola de Keycloak.

Para eso usa la Admin API de Keycloak con el client confidencial `medicitas-user-admin`, cuyo secreto viene de
`KEYCLOAK_USER_ADMIN_SECRET`. Su service account solo tiene el rol `manage-users` de `realm-management`:
puede administrar usuarios, pero no cambiar la configuración del realm.

Keycloak y Postgres no comparten una transacción, así que el orden de los pasos está pensado para que
cualquier falla a medias deje el sistema cerrado (sin acceso) y no abierto:

| Operación | Orden | Si falla el segundo paso |
|---|---|---|
| Alta | 1. Keycloak: crear usuario y asignar rol. 2. Base: insertar en `users` | Se borra el usuario de Keycloak (compensación). Si también falla el borrado, queda un usuario en Keycloak sin fila en `users`: `identify` le responde 403 |
| Cambio de rol | 1. Base. 2. Keycloak | Los roles no coinciden y `identify` responde 403. La API responde 502; repetir la petición corrige la diferencia |
| Baja lógica | 1. Base. 2. Keycloak (`enabled: false`) | La base ya lo tiene inactivo: `identify` responde 403. Keycloak sigue entregando tokens que no sirven |
| Reactivación | 1. Base. 2. Keycloak (`enabled: true`) | Keycloak no le entrega tokens hasta repetir la petición |

Las operaciones en Keycloak son idempotentes (asignar un rol que ya tiene, deshabilitar a alguien ya
deshabilitado), por eso repetir la petición es seguro.

Keycloak importa `medicitas-realm.json` solo si el realm no existe. Después de cambiar ese archivo hay que
recrear los volúmenes: `docker compose down -v` y luego `docker compose up`.

==============================================================
|        			        API           	                 |
==============================================================

Todas las rutas, salvo `/health`, exigen `Authorization: Bearer <token>`. Los cuerpos son JSON. Un error
siempre responde `{ "error": "mensaje" }`; si es de validación (400), también trae
`"details": [{ "field": "...", "problem": "..." }]`. Un campo que la ruta no espera se rechaza con 400 (por
ejemplo, mandar `clinicId`: la clínica siempre sale del token).

Códigos comunes a todas las rutas protegidas: 401 sin token válido, 403 sin el permiso, 400 si el body o los
parámetros no son válidos o el JSON está mal formado.

- **Colección de peticiones versionada (§5 del enunciado):** `requests/medicitas.http`, compatible con REST Client
  (VS Code) y JetBrains HTTP Client, con la obtención de tokens de Keycloak, el ciclo completo de una cita
  (disponibilidad → reserva → reprogramación → cancelación/desenlace) y los casos de rechazo `400`, `401`, `403`,
  `404` y `409`.

### Errores de las reglas de negocio
Varias reglas las garantiza la base de datos. Cuando una operación las viola, la API responde así
(`packages/common/src/errors.js`):

| Situación | Error de la base | Código |
|---|---|---|
| El profesional ya tiene una cita reservada en ese horario: espacio ya tomado (I1) | `23P01` en `ex_appointments_professional` | 409 |
| El paciente ya tiene una cita reservada en ese horario, con cualquier profesional (I2) | `23P01` en `ex_appointments_patient` | 409 |
| Dos bloques de horario del mismo profesional se cruzan (RF5) | `23P01` en `ex_schedules_overlap` | 409 |
| La cita cae fuera del horario del profesional o dentro de un bloqueo (I3) | `MC001` | 400 |
| La cita ya está en un estado final y no admite cambios (RF13) | `MC002` | 409 |
| Se registra el desenlace antes de la hora de inicio (RF12) | `MC003` | 409 |
| Se borra o recorta un bloque de horario que tiene citas reservadas (I3) | `MC006` | 409 |
| Mover una cita o modificar la bitácora (I4, I6) | `42501` | 403: los permisos de la base lo frenan antes del trigger (`MC004`, `MC005`), que solo respondería 500 si los permisos estuvieran mal configurados |

En Windows con Git Bash, `curl -d '...'` no envía en UTF-8 los caracteres como tildes o ñ. Para probar con
esos datos, guarde el body en un archivo y use `curl --data-binary @body.json`.

### `GET /health`
Sin token. `200 {"status":"ok","db":"up"}` o `503` si la base no responde.

### `GET /me`
Cualquier usuario registrado. `200 {"userId", "clinicId", "role", "permissions": [...]}`.

### `POST /clinics` (RF1)
Permiso `clinics.create` (administrador de plataforma). Crea la clínica y su primer administrador.
```json
{
  "clinicCode": "heredia",
  "clinicName": "Clínica Heredia",
  "timeZone": "America/Costa_Rica",
  "admin": {
    "username": "admin.heredia",
    "email": "admin.heredia@example.com",
    "name": "Ana",
    "lastName": "Vargas",
    "password": "contraseña-inicial",
    "temporaryPassword": true
  }
}
```
- `timeZone`: nombre IANA, validado contra `pg_timezone_names`.
- `username`: 3 a 50 caracteres, minúsculas, números, `.`, `-` o `_`. `password`: mínimo 8 caracteres.
- `temporaryPassword` (por defecto `true`): Keycloak obliga a cambiarla en el primer inicio de sesión, que
  se hace desde `http://localhost:8080/realms/medicitas/account`. Mientras no la cambie, pedir un token con
  `curl` falla. Con `false` se puede usar de inmediato.

| Código | Caso |
|---|---|
| 201 | Creada. Devuelve la clínica y `admin: {userId, username, name, lastName, role}` |
| 400 | Body inválido o zona horaria desconocida |
| 409 | Ya existe una clínica con ese código, o un usuario con ese `username` o `email` |

### `GET /users` y `GET /users/{userId}` (RF2)
Permiso `users.manage` (administrador de clínica). Lista los usuarios de la clínica del token, o uno solo.
Cada usuario: `{userId, name, lastName, role, isActive, createdAt, updatedAt}`.
Un usuario de otra clínica responde 404, igual que uno que no existe.

### `POST /users` (RF2)
Permiso `users.manage`. Mismos campos que `admin` en `POST /clinics`, más `"role"`: `"clinic_admin"` o
`"reception"`. Los profesionales se dan de alta por su propia ruta (RF4), porque además llevan licencia,
especialidades y servicios.

| Código | Caso |
|---|---|
| 201 | Creado, en la clínica de quien lo crea. Devuelve el usuario y su `username` |
| 400 | Body inválido o rol no permitido |
| 409 | Ya existe un usuario con ese `username` o `email` |

### `PATCH /users/{userId}` (RF2)
Permiso `users.manage`. Body con uno o ambos campos: `{"role": "clinic_admin" | "reception", "isActive": false}`.
`isActive: false` es la baja lógica y `true` la reactivación.

| Código | Caso |
|---|---|
| 200 | Aplicado en la base y en Keycloak. Devuelve el usuario |
| 400 | Body vacío o inválido |
| 404 | El usuario no existe en la clínica del token |
| 409 | Es el propio usuario (no puede quitarse el rol ni darse de baja), o es un profesional y se pidió cambiar su rol |
| 502 | Se guardó en la base pero no en Keycloak; el usuario queda sin acceso hasta repetir la petición |

### Catálogo de servicios (`RF3`)
Permiso `services.manage` (administrador de clínica). Cada servicio pertenece a la clínica del token, tiene una
duración en minutos mayor que cero (que decide el fin de cada cita reservada, I4) y requiere una especialidad del
catálogo global.

#### `GET /services/specialties`
Devuelve el catálogo global de especialidades médicas: `[{specialtyId, specialtyName}]`.

#### `GET /services` y `GET /services/{serviceId}`
Lista los servicios de la clínica del token, o devuelve uno solo. Cada servicio:
`{serviceId, serviceName, durationMinutes, specialtyId, specialtyName, isActive, createdAt, updatedAt}`.
Un servicio de otra clínica responde 404, igual que uno que no existe (I5).

#### `POST /services` (RF3)
```json
{
  "serviceName": "Consulta cardiológica",
  "durationMinutes": 40,
  "specialtyId": 1
}
```
| Código | Caso |
|---|---|
| 201 | Creado en la clínica del token. Devuelve el servicio y el header `Location` |
| 400 | Body inválido o `durationMinutes` no positivo |
| 404 | La especialidad indicada no existe |

#### `PATCH /services/{serviceId}` (RF3)
Body con al menos uno de `{serviceName, durationMinutes, specialtyId, isActive}`. Cambiar `durationMinutes` aplica a
las citas nuevas; las ya reservadas conservan su periodo original (I4).

| Código | Caso |
|---|---|
| 200 | Actualizado. Devuelve el servicio |
| 400 | Body vacío o inválido |
| 404 | El servicio no existe en la clínica del token (I5), o la especialidad indicada no existe |

### Profesionales y servicios habilitados (`RF4`)
Permiso `professionals.manage` (administrador de clínica). Un profesional es un usuario con rol `professional` en
Keycloak y en `users`, más su fila 1:1 en `professionals` (`licenseNumber`), sus especialidades
(`specialties_per_professionals`), sus servicios habilitados (`services_per_professionals`) y sus contactos
(`professional_contacts`).

#### `GET /professionals` y `GET /professionals/{professionalId}`
Lista los profesionales de la clínica del token, o devuelve uno solo:
`{professionalId, userId, name, lastName, role: "professional", licenseNumber, isActive, specialties: [{specialtyId, specialtyName}], services: [{serviceId, serviceName, durationMinutes, specialtyId}], contacts: [{contactId, type, value}], createdAt, updatedAt}`.

#### `POST /professionals` (RF4)
Mismos campos de cuenta que `POST /users`, más `licenseNumber`, `specialtyIds` (al menos una), `serviceIds` (opcional,
servicios activos de la clínica cuya especialidad tenga el profesional) y `phone` (opcional):
```json
{
  "username": "carlos.mena",
  "email": "carlos.mena@example.com",
  "name": "Carlos",
  "lastName": "Mena",
  "password": "contraseña-inicial",
  "temporaryPassword": true,
  "licenseNumber": "MED-20400",
  "specialtyIds": [1],
  "serviceIds": [1],
  "phone": "+506 8888 1111"
}
```
| Código | Caso |
|---|---|
| 201 | Creado en Keycloak y en la clínica del token. Devuelve el profesional, su `username` y el header `Location` |
| 400 | Body inválido, o el profesional no tiene la especialidad que requiere alguno de los servicios indicados |
| 404 | Alguna especialidad no existe, o algún servicio no existe, está inactivo o pertenece a otra clínica (I5) |
| 409 | Ya existe un usuario con ese `username` o `email` |

#### `PATCH /professionals/{professionalId}` y `PUT /professionals/{professionalId}/services` (RF4)
- `PATCH /professionals/{professionalId}` recibe al menos uno de `{licenseNumber, specialtyIds, serviceIds, isActive}`.
  Si cambia `isActive`, también actualiza `users` y habilita o deshabilita la cuenta en Keycloak.
- `PUT /professionals/{professionalId}/services` recibe `{"serviceIds": [1, 2]}` y reemplaza la lista de servicios que
  el profesional está habilitado para atender.
- Quitar un servicio o especialidad usa baja lógica (`is_active = false`) sobre la tabla puente para no romper las
  llaves foráneas de citas históricas.

| Código | Caso |
|---|---|
| 200 | Actualizado. Devuelve el profesional |
| 400 | Body vacío o inválido, o el profesional no tiene la especialidad que requiere alguno de los servicios |
| 404 | El profesional, alguna especialidad o algún servicio no existe o pertenece a otra clínica (I5) |
| 502 | El cambio de `isActive` se guardó en la base pero no en Keycloak; repetir la petición corrige la diferencia |

### Horarios de atención: `/schedules` (RF5)
Permisos de escritura: `schedules.manage` (administrador de clínica: cualquier profesional de su clínica) o `schedules.manage_own` (profesional: únicamente su propio `userId`). Lectura: administrador de clínica, profesional y recepción.

Cada bloque se recibe en la fecha (`YYYY-MM-DD`) y hora (`HH:MM`, 24 h) locales de la clínica y se convierte a instantes absolutos con `clinics.time_zone`. Puede haber varios bloques en el mismo día (jornada partida), pero no pueden solaparse entre sí (`ex_schedules_overlap`).

#### `GET /schedules?professionalId=…&from=…&to=…` (RF5)
Lista los bloques de horario de la clínica del token, con filtros opcionales por profesional y rango de fechas (`YYYY-MM-DD`). Cada bloque: `{scheduleId, professionalId, date, startTime, endTime, start, end, createdAt, updatedAt}`.

#### `POST /schedules` (RF5)
```json
{
  "professionalId": 6,
  "date": "2026-11-20",
  "startTime": "08:00",
  "endTime": "12:00"
}
```

#### `PATCH /schedules/{scheduleId}` y `DELETE /schedules/{scheduleId}` (RF5, I3)
`PATCH` recibe uno o más de `{date, startTime, endTime}`. Si al recortar o eliminar un bloque quedarían citas reservadas fuera del horario del profesional, el trigger `trg_professional_schedules_guard` rechaza la operación con `MC006` (409). Tras cada `COMMIT` se incrementa la versión de agenda en Redis (`I8`).

| Código | Caso |
|---|---|
| 200 / 201 / 204 | Bloque listado, actualizado, creado o eliminado |
| 400 | Body o parámetros inválidos, o `startTime >= endTime` |
| 403 | Sin permiso, o un profesional con `schedules.manage_own` intenta gestionar el horario de otro profesional |
| 404 | El profesional o el bloque no existe o pertenece a otra clínica (I5) |
| 409 | El bloque se solapa con otro del mismo profesional (`ex_schedules_overlap`), o tiene citas reservadas que quedarían fuera del horario (`MC006`, I3) |

### Bloqueos de agenda: `/blockades` (RF6)
Mismos permisos que `/schedules`. Un bloqueo retira disponibilidad (RF7) e impide nuevas reservas en ese periodo (I3), pero **no cancela** las citas ya reservadas que caen dentro: esas citas quedan en estado `reservada` y se devuelven en `conflicts` para que recepción las reprograme (RF6, RF10).

#### `GET /blockades?professionalId=…&from=…&to=…` y `GET /blockades/conflicts?professionalId=…&blockadeId=…` (RF6)
`GET /blockades` lista los bloqueos de la clínica junto con sus citas reservadas en conflicto (`conflicts`). `GET /blockades/conflicts` devuelve directamente las citas reservadas que se cruzan con algún bloqueo vigente.

#### `POST /blockades` y `DELETE /blockades/{blockadeId}` (RF6)
Acepta `date` (bloqueo dentro de un mismo día) o el par `startDate` y `endDate` (ausencias de varios días):
```json
{
  "professionalId": 6,
  "date": "2026-11-20",
  "startTime": "09:00",
  "endTime": "11:00",
  "reason": "Capacitación extraordinaria"
}
```

| Código | Caso |
|---|---|
| 200 / 201 / 204 | Lista de bloqueos/conflictos, bloqueo creado (con `conflicts: [...]`) o bloqueo eliminado |
| 400 | Body o parámetros inválidos, o el fin del bloqueo no es posterior al inicio |
| 403 | Sin permiso, o un profesional con `schedules.manage_own` intenta gestionar bloqueos de otro profesional |
| 404 | El profesional o el bloqueo no existe o pertenece a otra clínica (I5) |

### `POST /appointments` (RF9)
Permiso `appointments.manage` (administrador de clínica y recepción). Reserva una cita en la clínica del token.
```json
{
  "patientId": 1,
  "professionalId": 6,
  "serviceId": 1,
  "start": "2026-11-12T09:00:00-06:00",
  "description": "Control"
}
```
- `start`: instante de inicio con zona horaria (`-06:00` o `Z`). Uno sin zona se rechaza, porque sería ambiguo.
- El fin no se envía: lo calcula la base con la duración del servicio (I4). Un campo `end` se rechaza con 400.
- `description` es opcional (hasta 500 caracteres).
- Dos reservas simultáneas del mismo espacio: la base deja pasar exactamente una; la otra recibe 409 (pregunta
  rectora, I1).

| Código | Caso |
|---|---|
| 201 | Concedida. Devuelve `{appointmentId, patientId, professionalId, serviceId, status: "reservada", start, end, description}` y el header `Location` |
| 400 | Solicitud inválida: body inválido, inicio en el pasado, el profesional no atiende ese servicio, o la cita cae fuera de su horario o dentro de un bloqueo (I3) |
| 404 | El paciente, el profesional o el servicio no existe, está dado de baja o es de otra clínica (I5) |
| 409 | Espacio ya tomado: el profesional ya tiene una cita que se cruza (I1); o el paciente ya tiene otra cita a esa hora (I2) |

### Cambios de estado de una cita (RF11, RF12, RF13)
Desde `reservada` se puede pasar a `cancelada`, `atendida`, `ausente` o `reprogramada`; esos cuatro estados son
finales y no admiten más cambios (RF13). Las dos rutas responden la cita con su estado nuevo:
`{appointmentId, patientId, professionalId, serviceId, status, start, end, description, cancelReason, cancelledBy, cancelledAt}`.
Al salir de `reservada`, el espacio queda libre de inmediato para otra reserva (I7).

#### `POST /appointments/{id}/cancel` (RF11)
Permiso `appointments.manage` (administrador de clínica y recepción). Body: `{"reason": "El paciente pidió cancelar"}`
(obligatorio, hasta 500 caracteres). Queda registrado quién canceló (`cancelledBy`) y cuándo (`cancelledAt`).

#### `POST /appointments/{id}/outcome` (RF12)
Permiso `appointments.outcome` (administrador de clínica, recepción y profesional, según la matriz). Body:
`{"outcome": "atendida"}` o `{"outcome": "ausente"}`. Solo se admite una vez pasada la hora de inicio.

| Código | Caso |
|---|---|
| 200 | Aplicado. Devuelve la cita con su estado nuevo |
| 400 | Body inválido (falta el motivo, desenlace distinto de `atendida` o `ausente`) o id que no es un número |
| 404 | La cita no existe o es de otra clínica (I5) |
| 409 | La cita ya está en un estado final (RF13), o se registra el desenlace antes de la hora de inicio (RF12) |

### `POST /appointments/{id}/reschedule` (RF10)
Permiso `appointments.manage` (administrador de clínica y recepción). Mueve una cita reservada a otro espacio:
```json
{
  "start": "2026-11-12T10:00:00-06:00",
  "professionalId": 7
}
```
- `start`: el nuevo inicio, con zona horaria. El fin lo sigue calculando la base (I4).
- `professionalId` es opcional: otro profesional de la clínica que atienda el mismo servicio. Si no se envía, se
  conserva el profesional. El paciente, el servicio y la descripción siempre se conservan.
- En una sola transacción, la original pasa a `reprogramada` y se crea la nueva, que apunta a ella
  (`rescheduledFromId`). Si la nueva no se puede crear, la original sigue `reservada`: nunca quedan las dos ni
  ninguna. Como la original libera su espacio primero, la nueva puede cruzarse con ella (por ejemplo, correrla
  quince minutos).
- Dos reprogramaciones simultáneas de la misma cita: gana una y la otra recibe 409.

| Código | Caso |
|---|---|
| 201 | Reprogramada. Devuelve la cita nueva, `{appointmentId, patientId, professionalId, serviceId, status: "reservada", start, end, description, rescheduledFromId}`, y el header `Location` |
| 400 | Body inválido (sin `start`, inicio sin zona horaria, un campo que no se admite como `end` o `serviceId`), id que no es un número, inicio en el pasado, el profesional no atiende ese servicio, o el nuevo espacio cae fuera del horario o dentro de un bloqueo (I3) |
| 404 | La cita, o el profesional indicado, no existe o es de otra clínica (I5) |
| 409 | La cita ya está en un estado final, por ejemplo ya reprogramada o cancelada (RF13); o el nuevo espacio está tomado (I1, I2) |

### Disponibilidad (RF7, RF8)
Permiso `availability.read` (administrador de clínica, recepción y profesional). Solo lectura. Un espacio libre sale
del horario del profesional (RF5), menos sus bloqueos (RF6) y menos sus citas `reservada`; una cita cancelada o
reprogramada ya no ocupa su espacio (I7). Los huecos libres se cortan en espacios seguidos del largo del servicio,
desde el inicio de cada hueco; lo que sobra al final de un hueco no alcanza para un espacio. Los espacios que ya
empezaron no se devuelven.

Las fechas (`date`, `from`, `to`) son días `YYYY-MM-DD` en la hora local de la clínica. Cada espacio es
`{start, end}`, dos instantes ISO 8601 en UTC, en el mismo formato que la reserva: el `start` de un espacio se puede
mandar tal cual a `POST /appointments`.

Los huecos libres de cada profesional y día se guardan en Redis durante 60 segundos (caché de RF7, ver "Decisión:
caché de disponibilidad" en `docs/comparacion-arquitecturas.md`). Toda reserva, cancelación, reprogramación o
desenlace invalida de inmediato la copia de ese día, así que la siguiente consulta ya refleja el cambio (I8). Si
Redis no está disponible, la consulta se calcula en la base y responde igual. El header `X-MediCitas-Cache` dice de
dónde salió cada respuesta:

| Valor | Significado |
|---|---|
| `hit` | Todos los huecos salieron de Redis |
| `miss` | Alguno se calculó en la base y quedó guardado |
| `off` | Redis no estaba disponible: todo se calculó en la base, sin guardar |

#### `GET /availability/professionals/{professionalId}?serviceId=…&date=…` (RF7)
Espacios libres de un profesional en una fecha, para uno de sus servicios.
```json
{
  "professionalId": 6,
  "serviceId": 2,
  "date": "2026-11-12",
  "durationMinutes": 30,
  "slots": [
    { "start": "2026-11-12T14:30:00.000Z", "end": "2026-11-12T15:00:00.000Z" },
    { "start": "2026-11-12T16:00:00.000Z", "end": "2026-11-12T16:30:00.000Z" }
  ]
}
```
Un día sin horario, ya pasado o completamente ocupado responde 200 con `slots: []`.

#### `GET /availability/services/{serviceId}?from=…&to=…` (RF8)
Profesionales que atienden el servicio y tienen al menos un espacio entre `from` y `to` (inclusive, como máximo 31
días), con los días que tienen espacios. Cada día trae los mismos espacios que daría RF7. Un profesional sin
espacios en el rango no aparece.
```json
{
  "serviceId": 2,
  "from": "2026-11-12",
  "to": "2026-11-18",
  "durationMinutes": 30,
  "professionals": [
    {
      "professionalId": 6,
      "name": "Laura Mora Jiménez",
      "days": [{ "date": "2026-11-12", "slots": [{ "start": "…", "end": "…" }] }]
    }
  ]
}
```

| Código | Caso |
|---|---|
| 200 | Devuelve los espacios, aunque la lista esté vacía |
| 400 | Parámetros inválidos (falta uno, fecha imposible como `2030-02-30`, id que no es un número, un parámetro que no se admite como `clinicId`), el profesional no atiende ese servicio (RF7), o en RF8 un rango al revés o de más de 31 días |
| 404 | El profesional o el servicio no existe, está dado de baja o es de otra clínica (I5) |

### Historial de citas de un paciente: `GET /appointments?patientId=…` (RF16)
Permiso `patient_history.read` (administrador de clínica, recepción y profesional). Devuelve todas las citas del paciente en la clínica del token, en orden cronológico y en cualquiera de los cinco estados (`reservada`, `atendida`, `ausente`, `cancelada`, `reprogramada`), incluyendo `professionalName`, `serviceName`, `cancelReason` y `rescheduledFromId`. No lee `patient_contacts` (dato sensible auditable en `clinical`, RF18).

| Código | Caso |
|---|---|
| 200 | Lista de citas del paciente (vacía si aún no tiene citas) |
| 400 | Falta `patientId`, no es un número válido o se envía un parámetro no permitido (`clinicId`) |
| 404 | El paciente no existe o pertenece a otra clínica (I5) |

### Pacientes: `/patients` (RF14, RF18)
Lectura (`GET /patients`, `GET /patients/genders`, `GET /patients/{patientId}`): permiso `patients.read` (administrador de clínica, recepción y profesional). Escritura (`POST /patients`, `PATCH /patients/{patientId}`): permiso `patients.write` (administrador de clínica y recepción).

- `GET /patients` devuelve el directorio de pacientes de la clínica sin sus datos de contacto (`{patientId, identification, name, lastName, birthDate, genderId, gender, isActive, createdAt, updatedAt}`), para no generar lecturas masivas de datos sensibles en la bitácora.
- `GET /patients/{patientId}` devuelve el paciente junto con sus contactos activos (`contacts: [{contactId, type, value}]`) y registra en `clinical.audit_logs` un evento `read` por cada contacto leído dentro de la misma transacción (RF18).
- `POST /patients` crea el paciente y sus contactos (`telefono` o `email`), registrando en `audit_logs` un evento `create` por cada contacto creado:
```json
{
  "identification": "1-1234-5678",
  "name": "María",
  "lastName": "Vargas Mora",
  "birthDate": "1992-05-14",
  "gender": "femenino",
  "contacts": [
    { "type": "telefono", "value": "+506 8888 1234" },
    { "type": "email", "value": "maria.vargas@example.com" }
  ]
}
```
- `PATCH /patients/{patientId}` actualiza los datos personales, el estado (`isActive`) y/o la lista de contactos (`contacts`). Los contactos que se retiran reciben baja lógica (`is_active = false`, evento `delete` en `audit_logs`) y los nuevos se insertan (evento `create` en `audit_logs`).

| Código | Caso |
|---|---|
| 200 / 201 | Paciente(s) consultado(s), creado o actualizado |
| 400 | Body inválido, `birthDate` en el futuro o contactos duplicados en la solicitud |
| 403 | Rol sin permiso (`professional` al intentar crear o editar pacientes) |
| 404 | El paciente no existe o pertenece a otra clínica (I5) |
| 409 | Ya existe un paciente con esa `identification` en la misma clínica (`uq_patients_clinic_identification`) |

### Notas clínicas: `/clinical-notes` (RF15, RF18)

**Quién puede usarlas.** Solo los profesionales, con el permiso `clinical_notes.write_own`, y únicamente sobre las
citas que **ellos mismos atendieron**, como pide la matriz ("solo de citas propias"). Recepción y el administrador de la
clínica reciben 403. Para otro profesional, la nota de una cita ajena responde 404, igual que una que no existe (I5).

**Bitácora (RF18).** Cada creación, lectura y corrección deja una fila en `audit_logs`, en la misma transacción. Esa
fila registra quién, sobre cuál paciente, qué hizo y cuándo, **nunca el texto de la nota**.

Cada nota se responde así:
`{clinicalNoteId, appointmentId, patientId, text, createdAt, updatedAt}`.

#### `POST /clinical-notes` (RF15)
```json
{ "appointmentId": 812, "text": "Dolor lumbar leve. Reposo y control en dos semanas." }
```
`text` lleva entre 1 y 10 000 caracteres. La cita tiene que estar **atendida**, y cada cita tiene una sola nota.

#### `GET /clinical-notes/{id}` y `GET /clinical-notes?appointmentId=…` (RF15)
Devuelven la nota por su id o por su cita. Como cada cita tiene una sola nota, buscarla por la cita sirve para abrirla
desde la agenda. Cada lectura queda registrada en la bitácora.

#### `PATCH /clinical-notes/{id}` (RF15)
Recibe `{ "text": "…" }`. Solo el autor corrige su nota, y cada corrección queda registrada en la bitácora.

| Código | Caso |
|---|---|
| 200 / 201 | Nota leída, corregida o creada; la creación devuelve el header `Location` |
| 400 | Cuerpo o parámetros inválidos: sin `text`, `text` vacío o de más de 10 000 caracteres, ids inválidos o un campo que no se admite, como `clinicId` |
| 403 | El rol no es `professional` |
| 404 | La cita o la nota no existe, es de otra clínica o es de una cita de otro profesional (I5) |
| 409 | La cita no está atendida, o ya tiene una nota |

### `GET /agenda?date=…` (RF20)
Permiso `agenda.read` (administrador de clínica, recepción y profesional). La agenda del día: las citas que empiezan
ese día en la hora local de la clínica, **en todos los estados** (también canceladas y reprogramadas), ordenadas por
hora. Con `professionalId`, solo las de ese profesional; sin él, las de toda la clínica. El profesional también puede
ver la de toda la clínica, como indica la matriz.

- `date`: día `YYYY-MM-DD` (obligatorio).
- `professionalId`: opcional.

```json
{
  "date": "2026-11-12",
  "professionalId": 6,
  "appointments": [
    {
      "appointmentId": 812,
      "start": "2026-11-12T14:00:00.000Z",
      "end": "2026-11-12T14:30:00.000Z",
      "status": "reservada",
      "description": "Control",
      "professional": { "professionalId": 6, "name": "Laura Mora Jiménez" },
      "patient": { "patientId": 1, "name": "Carlos Chaves Ramos" },
      "service": { "serviceId": 2, "name": "Consulta general" }
    }
  ]
}
```

No incluye los contactos del paciente, porque leerlos se registraría en la bitácora (RF18).

| Código | Caso |
|---|---|
| 200 | La agenda, aunque esté vacía |
| 400 | Parámetros inválidos: falta `date`, fecha imposible, `professionalId` que no es un número o un parámetro que no se admite, como `clinicId` |
| 404 | El profesional no existe o es de otra clínica (I5) |

### `GET /reports/appointments-by-status?from=…&to=…` (RF21)
Permiso `reports.read` (solo el administrador de clínica). Cuenta por estado las citas que empiezan entre `from` y
`to`, inclusive y en la hora local de la clínica, con un rango de **como máximo 366 días**. Con `professionalId`,
solo las de ese profesional. Los cinco estados aparecen siempre, aunque den cero.

```json
{
  "from": "2026-11-01",
  "to": "2026-11-30",
  "professionalId": null,
  "total": 177,
  "byStatus": { "reservada": 30, "atendida": 120, "ausente": 15, "cancelada": 8, "reprogramada": 4 }
}
```

Es una consulta agregada sobre la base transaccional, como pide el enunciado: la analítica real es de la Etapa 2.
Recorre el índice `ix_appointments_clinic_start`; un año de la clínica de San José del seed (1 444 citas) se cuenta
en ~4 ms.

| Código | Caso |
|---|---|
| 200 | Los conteos |
| 400 | Parámetros inválidos, un rango al revés o de más de 366 días |
| 403 | El rol no tiene `reports.read` (recepción, profesional) |
| 404 | El profesional no existe o es de otra clínica (I5) |

### Consulta de la bitácora de auditoría: `GET /audit` (RF19)
Permiso `audit.read`, que solo tiene el administrador de la clínica. Devuelve la bitácora de su clínica, de la entrada
más nueva a la más antigua, paginada. Todos los filtros son opcionales y se pueden combinar:

- `userId`: lo que hizo un usuario;
- `patientId`: lo que se hizo sobre un paciente;
- `from` y `to`: días `YYYY-MM-DD` en la hora local de la clínica, inclusive, igual que en RF21;
- `limit`: el tamaño de la página;
- `beforeId`: la página siguiente. Se pasa el `nextBeforeId` de la respuesta anterior.

```json
{
  "entries": [
    {
      "logId": 5120,
      "createdAt": "2026-11-12T17:40:11.512Z",
      "userId": 3,
      "userName": "Ana Rojas",
      "event": "read",
      "dataObject": "patient_contact",
      "objectId": 42,
      "patientId": 7,
      "description": "Lectura de contacto (telefono) del paciente",
      "metadata": { "type": "telefono" }
    }
  ],
  "nextBeforeId": 5120
}
```

Si `nextBeforeId` es `null`, no hay más páginas. Un filtro que apunta a un usuario o paciente de otra clínica devuelve
una lista vacía, porque todo se filtra por la clínica del token (I5).

| Código | Caso |
|---|---|
| 200 | La página, aunque esté vacía |
| 400 | Parámetros inválidos: fecha imposible, `from` posterior a `to`, `limit` fuera de rango, ids no numéricos o un parámetro que no se admite, como `clinicId` |
| 401 / 403 | Sin token, o el rol no es el administrador de la clínica |

### Verificación de la bitácora de auditoría (Módulo §9, I6)

#### `GET /audit/verify`
Permiso `audit.read` (administrador de clínica). Recorre la cadena de huellas SHA-256 de `clinical.audit_logs`
de la clínica del token mediante la función SQL `clinical.verify_audit_chain(clinic_id)` y comprueba dos cosas
en cada fila: que `prev_hash` coincida con `row_hash` del registro previo de la clínica (`NULL` en el primero),
y que `row_hash` coincida con el SHA-256 recalculado sobre las columnas del registro. Si alguien con acceso
administrativo a PostgreSQL desactivó el trigger `trg_audit_logs_append_only` y alteró o borró un registro, la
respuesta señala el primer `log_id` roto.

```json
{
  "clinicId": 1,
  "valid": true,
  "checkedCount": 312,
  "lastLogId": 934,
  "lastRowHash": "a1b2c3d4e5f6...",
  "firstBrokenLogId": null,
  "failureReason": null
}
```

| Código | Caso |
|---|---|
| 200 | Devuelve el estado de integridad de la cadena (`valid: true` o `valid: false` con `firstBrokenLogId` y `failureReason`) |
| 400 | Se enviaron parámetros no admitidos en el query string (por ejemplo, `clinicId`) |
| 401 / 403 | Sin token válido o sin el permiso `audit.read` |
