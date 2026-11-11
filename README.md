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

## auditLogs [tenant] (RF18 / RF19 — append-only protegida en el motor, I6)
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
- FK (clinicId, userId) → Users(clinicId, userId)
- FK (clinicId, patientId) → Patients(clinicId, patientId)

Protección: ningún rol de la aplicación tiene `UPDATE`, `DELETE` ni `TRUNCATE` sobre esta tabla, y un trigger
`BEFORE UPDATE OR DELETE` lanza una excepción aunque alguien conceda el permiso por error.

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
justificará con `EXPLAIN ANALYZE` de su consulta una vez cargados los datos semilla.

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
```
Los índices sobre `lower(period)` solo se usan si la consulta filtra con la misma expresión, por ejemplo
`WHERE clinicId = $1 AND lower(period) >= $2 AND lower(period) < $3`.

No se crea un índice aparte sobre `ProfessionalSchedules (clinicId, professionalId, period)`: el del `EXCLUDE` ya
cubre `(professionalId, period)` y anteponer `clinicId` no filtra nada más, porque cada profesional pertenece a
una sola clínica. Solo encarecería las escrituras.

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