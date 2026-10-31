# Guía de estudio de MediCitas (Etapa 1)

Material de estudio del grupo. Explica **qué** se construyó, **cómo** funciona y **por qué** se decidió así, con
experimentos para comprobar cada cosa por cuenta propia.

Refleja el estado del proyecto al 31 de octubre de 2026: la infraestructura, la base de datos, Keycloak y Redis
están listos; la API REST todavía no (solo existe `/health`). Lo que aún no existe se marca como **pendiente**.

## Cómo usar esta guía

- **Léanla en orden.** Cada parte usa conceptos de las anteriores.
- **Niveles de profundidad:**
  - 🔴 **Imprescindible.** Tienen que poder explicarlo sin notas en la defensa y en el video.
  - 🟡 **Entender la idea.** Saber qué hace y por qué; no hace falta recordar cada línea.
  - ⚪ **Consulta.** Detalles para cuando los necesiten.
- **Regla de oro: no crean, comprueben.** Cada parte tiene experimentos (E1, E2, …). Los que modifican datos van
  dentro de `BEGIN … ROLLBACK`, así que no cambian nada. Antes de ejecutar cada uno, **predigan qué va a pasar**;
  después, **busquen la línea de código que produjo el resultado**. Si la encuentran, entendieron esa parte.
- Al final de cada parte hay preguntas de control. Las respuestas están en la [Parte 11](#parte-11-autoevaluación).

## Índice

- [Parte 0. Preparación](#parte-0-preparación)
- [Parte 1. El problema y el mapa](#parte-1-el-problema-y-el-mapa) 🔴
- [Parte 2. Arquitectura y Docker Compose](#parte-2-arquitectura-y-docker-compose) 🔴🟡
- [Parte 3. Roles de la base y permisos](#parte-3-roles-de-la-base-y-permisos) 🔴
- [Parte 4. El esquema](#parte-4-el-esquema) 🔴
- [Parte 5. Catálogos y datos de demostración](#parte-5-catálogos-y-datos-de-demostración) 🟡
- [Parte 6. Keycloak y los tokens](#parte-6-keycloak-y-los-tokens) 🔴
- [Parte 7. Redis](#parte-7-redis) 🟡
- [Parte 8. La aplicación Node](#parte-8-la-aplicación-node) 🟡
- [Parte 9. Documentación generada](#parte-9-documentación-generada) ⚪
- [Parte 10. Estado de los requisitos](#parte-10-estado-de-los-requisitos)
- [Parte 11. Autoevaluación](#parte-11-autoevaluación)
- [Parte 12. Glosario](#parte-12-glosario)
- [Parte 13. Chuleta de comandos](#parte-13-chuleta-de-comandos)
- [Plan de sesiones guiadas](#plan-de-sesiones-guiadas)

---

## Parte 0. Preparación

Levantar todo (la primera vez, copiar antes el `.env`):

```bash
cp .env.example .env                    # solo la primera vez
docker compose up -d --build --wait     # levanta los 4 servicios y espera a que estén sanos (~75 s)
docker compose ps                       # los 4 deben decir (healthy)
```

Hay dos formas de abrir una consola de la base. Dentro del contenedor `psql` no pide contraseña, porque la imagen de
Postgres confía en las conexiones locales; desde fuera (puerto 5432) sí la pide.

| Comando | Entra como | Para qué |
|---|---|---|
| `docker compose exec db psql -U mc_app -d medicitas` | el usuario de la API | experimentos con permisos (`SET LOCAL ROLE …`) |
| `docker compose exec db psql -U mc_owner -d medicitas` | el dueño del esquema | explorar: ve todo |

Comandos de `psql` que van a usar:

| Comando | Qué hace |
|---|---|
| `\d appointments` | columnas, índices, restricciones y triggers de una tabla |
| `\d+ appointments` | lo mismo, con la descripción de cada columna |
| `\du` | roles de la base |
| `\sf appointments_check_agenda` | código fuente de una función |
| `\x` | alterna la vista expandida (útil para filas anchas) |
| `\q` | salir |

**Volver al estado inicial** (borra la base y la reconstruye desde `db/`; el realm de Keycloak también):

```bash
docker compose down -v && docker compose up -d --wait
```

---

## Parte 1. El problema y el mapa

### 1.1 Qué es MediCitas 🔴

Una plataforma SaaS de citas médicas **multi-tenant**: una sola instalación sirve a muchas clínicas, y cada clínica
(el *tenant*) ve únicamente sus datos. Hay cuatro tipos de usuario: administrador de plataforma, administrador de
clínica, recepción y profesional. Los pacientes no son usuarios: no inician sesión.

### 1.2 La pregunta rectora 🔴

> Dos recepcionistas reservan el último espacio de un profesional exactamente al mismo tiempo. ¿Qué pasa?

Todo el diseño gira alrededor de responderla bien: **siempre gana exactamente una**, la otra recibe un error claro, y
eso lo garantiza el motor de base de datos, no la suerte. La respuesta completa está en la
[sección 4.6](#46-citas-el-corazón-del-sistema-).

### 1.3 El principio de diseño: la base de datos es la última línea de defensa 🔴

Las reglas importantes (invariantes) se hacen cumplir **dentro de PostgreSQL**, con restricciones, triggers y
permisos, y no solo en el código de la API. Razones:

- **Concurrencia.** Una validación en la API ("¿está libre el espacio?") puede quedar obsoleta un milisegundo
  después, cuando otra petición reserva. El motor ve todas las transacciones a la vez; la API no.
- **Errores en el código.** Si mañana alguien escribe una ruta nueva y olvida una validación, el motor igual rechaza
  el dato inválido.
- **Un solo lugar.** La regla vive en un sitio y aplica a todo el que escriba en la base: la API, los datos de
  demostración, un script, una consulta manual.

La API también validará, pero para dar **mensajes claros** (un 409 con "espacio ya tomado"), no como garantía.

### 1.4 Mapa: qué garantiza cada invariante y dónde 🔴

| Invariante | Qué dice | Lo garantiza | Dónde | Experimento |
|---|---|---|---|---|
| I1 | Un profesional nunca tiene dos citas vigentes solapadas | `EXCLUDE` `ex_appointments_professional` | `db/sql/01-schema.sql:371` | E12, E13 |
| I2 | Un paciente nunca tiene dos citas vigentes solapadas | `EXCLUDE` `ex_appointments_patient` | `db/sql/01-schema.sql:373` | pregunta 11.4 |
| I3 | Toda cita vigente cae dentro del horario y fuera de los bloqueos | triggers `trg_appointments_20_check_agenda` y `trg_professional_schedules_guard` | `db/sql/01-schema.sql:527` y `:597` | E16, E17, E21 |
| I4 | La duración la decide el servicio | trigger `trg_appointments_10_set_period` y permiso de columna | `db/sql/01-schema.sql:477`, `db/sql/02-grants.sql:56` | E8, E14, E18 |
| I5 | Ningún dato de una clínica es accesible desde otra | FKs compuestas `(clinic_id, …)` y, en la API, el `clinic_id` sale del token | `db/sql/01-schema.sql`, API **pendiente** | E10, E10b, E10c |
| I6 | La bitácora no se modifica ni se borra | sin permisos `UPDATE`/`DELETE` y triggers | `db/sql/02-grants.sql:62`, `db/sql/01-schema.sql:627` | E22 |
| I7 | Cancelar o reprogramar libera el espacio de inmediato | el `EXCLUDE` solo cuenta las citas `reservada` | `db/sql/01-schema.sql:371` | E14 |
| I8 | La caché nunca contradice a la base | Redis con invalidación | **pendiente** (paso 6) | — |

### Preguntas de control

1.1. ¿Por qué no basta con que la API revise si el espacio está libre antes de reservar?
1.2. ¿Qué invariantes dependen todavía de código que no existe?

---

## Parte 2. Arquitectura y Docker Compose

### 2.1 Los cuatro servicios 🔴

| Servicio | Imagen | Qué hace | Puerto en tu máquina |
|---|---|---|---|
| `db` | `postgres:18-alpine` | Guarda todo, en dos bases separadas: `medicitas` (la app) y `keycloak` (estado de Keycloak) | `127.0.0.1:5432` |
| `keycloak` | `quay.io/keycloak/keycloak:26.7` | Proveedor de identidad: guarda contraseñas, hace el login y emite los tokens | `127.0.0.1:8080` |
| `app` | se construye desde `./app` (`node:24-alpine`) | La API REST | `127.0.0.1:3000` |
| `redis` | `redis:8.2-alpine` | Caché de la consulta de disponibilidad | ninguno |

El diagrama está en `docs/diagramas.md`, sección 1.

### 2.2 El recorrido de una petición 🔴

1. El cliente pide un **token** a Keycloak con usuario y contraseña, y recibe un JWT firmado (Parte 6).
2. El cliente llama a la API con la cabecera `Authorization: Bearer <token>`.
3. La API verifica la firma del token con las **llaves públicas** de Keycloak (JWKS). **Pendiente.**
4. La API busca el `sub` del token en la tabla `users` y obtiene la clínica y el rol. Abre una transacción, hace
   `SET LOCAL ROLE` al rol de base de datos que corresponde y ejecuta el SQL filtrando por esa clínica.
   **Pendiente.**
5. Para la disponibilidad (RF7) consulta primero Redis; si no está, calcula en Postgres y guarda el resultado.
   **Pendiente.**

Los pasos 1 y 2 ya funcionan; los pasos 3 a 5 son lo que se programa a continuación.

### 2.3 Decisiones del `docker-compose.yml` 🟡

- **Un solo comando.** El enunciado exige que todo levante con `docker compose up`, sin configurar nada a mano. Por
  eso el esquema, los datos y el realm de Keycloak se cargan solos.
- **Secretos en `.env`.** El compose usa `${VARIABLE:?mensaje}`: si falta una variable, se detiene con ese mensaje
  en vez de arrancar con una contraseña vacía. `.env` no se sube al repositorio; `.env.example` sí, con valores de
  desarrollo.
- **Puertos solo en `127.0.0.1`.** Son accesibles desde tu máquina, no desde la red del laboratorio. Redis no
  publica ningún puerto: solo lo necesita la app.
- **Los servicios se encuentran por nombre.** Dentro de la red de Compose, la app se conecta a `db:5432`,
  `keycloak:8080` y `redis:6379`. Docker resuelve esos nombres.
- **Orden de arranque con healthchecks.** `depends_on` con `condition: service_healthy` hace que la app espere a
  que la base, Keycloak y Redis estén **sanos**, no solo encendidos. Cada servicio tiene un `healthcheck` que dice
  qué significa "sano":
  - `db`: responde por TCP **y** existe el archivo `/var/lib/postgresql/.medicitas-init-ok`, que el script de
    inicialización crea solo si todos los scripts terminaron bien. Se agregó porque en una prueba una inicialización
    falló a medias, el contenedor se reinició, Postgres no repitió la inicialización (el volumen ya tenía datos) y
    el servicio aparecía "sano" con la base incompleta.
  - `keycloak`: su endpoint `/health/ready` responde `200 OK`.
  - `redis`: responde `PONG`.
  - `app`: `/health` responde.
- **La inicialización corre una sola vez.** Postgres ejecuta `db/init/` solo cuando el volumen de datos está vacío,
  y Keycloak importa el realm solo si no existe. **Después de cambiar algo en `db/sql/` o en `keycloak/`, hay que
  recrear con `docker compose down -v`.**
- **`KC_HOSTNAME`.** El token dice quién lo emitió en el claim `iss`. Si la app pidiera el token por la red interna
  (`keycloak:8080`) y tú por `localhost:8080`, los `iss` serían distintos y la validación fallaría. Fijar
  `KC_HOSTNAME` hace que el `iss` sea siempre `http://localhost:8080/realms/medicitas`; la app descarga las llaves
  por la red interna (`KEYCLOAK_JWKS_URL`).
- **`start-dev`.** Keycloak corre en modo desarrollo (HTTP, sin TLS). En producción se usaría `start` con HTTPS.

### Experimentos

**E1. Todo está sano.**

```bash
docker compose ps
curl -s localhost:3000/health          # {"status":"ok","db":"up"}
```

**E2. Redis no es accesible desde tu máquina, pero sí desde dentro.**

```bash
timeout 1 bash -c 'echo > /dev/tcp/127.0.0.1/6379' && echo abierto || echo cerrado   # cerrado
docker compose exec redis redis-cli ping                                             # PONG
```

**E3. El realm se importó solo.** Abran http://localhost:8080, entren con `admin` / `admin_dev`, elijan el realm
`medicitas` y revisen *Users*, *Realm roles* y *Clients*.

### Preguntas de control

2.1. ¿Por qué la app no arranca hasta que Keycloak está sano?
2.2. Cambiaron una línea de `db/sql/01-schema.sql` y reiniciaron con `docker compose restart`. ¿Se aplicó el cambio?

---

## Parte 3. Roles de la base y permisos

### 3.1 Qué hace `db/init/00-init.sh` 🟡

Lo ejecuta la imagen de Postgres en el primer arranque, en tres pasos:

1. **Como superusuario** (solo él puede crear roles y bases): crea los roles y las bases `medicitas` y `keycloak`.
   Quita el acceso por defecto (`REVOKE ALL … FROM PUBLIC`): solo el dueño de cada base y quien reciba
   `CONNECT` explícitamente pueden conectarse. A `medicitas` solo se le concede a `mc_app`, y Keycloak no puede
   entrar a ella.
2. **Como `mc_owner`**: ejecuta en orden los scripts de `db/sql/` (`01-schema`, `02-grants`, `03-catalogs`,
   `04-seed`, `05-comments`). Como los ejecuta `mc_owner`, él queda como dueño de todas las tablas y funciones.
3. Crea la marca `.medicitas-init-ok` que busca el healthcheck.

Las contraseñas llegan como variables de entorno y entran al SQL como variables de `psql` (`:'owner_pw'`), que
`psql` escapa: así una comilla en una contraseña no rompe el SQL.

### 3.2 Los tres tipos de rol 🔴

| Rol | Tipo | Para qué |
|---|---|---|
| `mc_owner` | puede iniciar sesión | Dueño del esquema. Solo ejecuta los scripts de `db/sql/`. **La app nunca lo usa.** |
| `mc_app` | puede iniciar sesión, **sin permisos propios** | El usuario con el que se conecta la API |
| `mc_platform`, `mc_clinic_admin`, `mc_reception`, `mc_professional` | no inician sesión | Cada uno tiene los permisos de un rol de la aplicación |

**¿Por qué la app no se conecta como el dueño?** El dueño de una tabla puede hacer cualquier cosa con ella:
borrarla, cambiarla o desactivar sus triggers (`ALTER TABLE … DISABLE TRIGGER`). Si la API se conectara como
dueño, un error de programación o una inyección SQL podrían, por ejemplo, desactivar la protección de la bitácora.
Es el principio de **menor privilegio**: cada quien tiene solo los permisos que necesita.

**Cómo funciona `mc_app`:**

```text
mc_app  (inicia sesión, NOINHERIT: no hereda ningún permiso)
   │
   │  SET LOCAL ROLE …   (una vez por transacción, según el rol que trae el token)
   │
   ├──► mc_platform
   ├──► mc_clinic_admin
   ├──► mc_reception
   └──► mc_professional
```

- `mc_app` es miembro de los cuatro roles, pero con `NOINHERIT` y `WITH INHERIT FALSE, SET TRUE`. Eso significa:
  **puede convertirse** en cualquiera de ellos (`SET ROLE`), pero **no recibe sus permisos automáticamente**.
- Consecuencia: si el código olvida el `SET ROLE`, la consulta falla con "permission denied" en lugar de ejecutarse
  con todos los permisos. Ante un error, el sistema **falla cerrado**.
- **`SET LOCAL` y no `SET`.** La API usa un *pool* de conexiones: la misma conexión atiende una petición tras otra.
  `SET LOCAL ROLE` dura solo hasta el `COMMIT` o `ROLLBACK`, así que el rol de una petición nunca se filtra a la
  siguiente que use esa conexión.

### 3.3 La matriz de permisos (`db/sql/02-grants.sql`) 🔴

Cada rol de base de datos recibe solo lo que su matriz permite. La tabla completa está en el README, sección
"Roles de base de datos". Lo más importante:

- **Recepción no puede leer notas clínicas.** Solo `mc_professional` tiene permisos sobre `clinical_notes`.
- **Nadie puede cambiar el horario ni el servicio de una cita.** El `UPDATE` sobre `appointments` se concede solo
  sobre seis columnas (estado, datos de cancelación, `updated_at`, `updated_by`) en
  `db/sql/02-grants.sql:56`. `period` y `service_id` no están en la lista (I4).
- **Nadie tiene `UPDATE`, `DELETE` ni `TRUNCATE` sobre `audit_logs`** (I6).
- **`REVOKE EXECUTE … FROM PUBLIC`** sobre nuestras funciones: en Postgres, toda función nueva la puede ejecutar
  cualquiera. Las nuestras solo las usan los triggers, que no necesitan ese permiso, así que se quita.
- **Lo que la base no puede distinguir.** Todos los profesionales usan el mismo rol `mc_professional`, así que la
  base no sabe si la profesional Laura está tocando *su* horario o el de otro colega. Las reglas "solo lo propio"
  las aplicará la API, filtrando por el usuario del token. Hacerlo en el motor requeriría Row-Level Security; queda
  como posible mejora.

### 3.4 Dos capas de permisos 🔴

Hay dos sistemas de permisos y es fácil confundirlos:

| | Permisos del dominio | Permisos de la base |
|---|---|---|
| Dónde están | tablas `permissions` y `permissions_per_roles` (`db/sql/03-catalogs.sql`) | `GRANT` en `db/sql/02-grants.sql` |
| Quién los aplica | la API, antes de tocar la base (**pendiente**) | el motor |
| Granularidad | por operación (`appointments.manage`) | por tabla y columna |
| Si fallan | la API responde **403** | error `42501` (permission denied) |
| Para qué | cumplir la matriz de RF17 con respuestas claras | defensa en profundidad: aunque la API tenga un error, recepción no lee notas clínicas |

**Pendiente de decidir por el grupo:** la matriz del enunciado no menciona RF20 (agenda del día) ni RF21 (conteo
por estado). Se propuso `agenda.read` para admin, recepción y profesional, y `reports.read` solo para el admin.

### Experimentos

Abran la consola como `mc_app` (`docker compose exec db psql -U mc_app -d medicitas`).

**E4. Los roles.**

```sql
\du
```

**E5. `mc_app` sin rol no puede leer nada.**

```sql
SELECT count(*) FROM appointments;
-- ERROR:  permission denied for table appointments
```

**E6. `SET LOCAL ROLE` dura solo la transacción.**

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
SELECT current_user, count(*) FROM appointments;   -- mc_reception, ~4000
COMMIT;
SELECT current_user;                                -- mc_app otra vez
```

**E7. Recepción no puede leer notas clínicas.**

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
SELECT note_text FROM clinical_notes LIMIT 1;
ROLLBACK;
-- ERROR:  permission denied for table clinical_notes
```

**E8. Recepción no puede mover una cita** (permiso por columna).

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
UPDATE appointments SET period = tstzrange(now(), NULL)
 WHERE appointment_id = (SELECT min(appointment_id) FROM appointments);
ROLLBACK;
-- ERROR:  permission denied for table appointments
```

### Preguntas de control

3.1. ¿Qué pasaría si `mc_app` tuviera `INHERIT` en vez de `NOINHERIT`?
3.2. ¿Por qué `SET LOCAL ROLE` y no `SET ROLE`?
3.3. Un profesional quiere ver los horarios de otro profesional de su clínica. ¿Lo impide la base? ¿Quién debe
impedirlo, si corresponde?

---

## Parte 4. El esquema

Archivo: `db/sql/01-schema.sql`. Tengan abiertos al lado `docs/diagramas.md` (los diagramas entidad-relación) y
`docs/diccionario-datos.md` (qué es cada columna).

### 4.1 Convenciones 🟡

- **Nombres en snake_case** (`clinic_id`). El modelo del README usa camelCase (`clinicId`), pero Postgres pasa a
  minúsculas todo nombre sin comillas, y `clinicId` terminaría como `clinicid`.
- **Llaves primarias `GENERATED ALWAYS AS IDENTITY`.** El motor asigna el número y la aplicación no puede
  escribirlo. Se usa `BIGINT` en las tablas de mayor volumen (citas, notas, bitácora). Los catálogos que el código
  usa por número (roles, estados de cita) tienen ids fijos `SMALLINT`, porque el código y los triggers comparan
  contra esos números (`role_id = 1`, `appointment_status_id = 4`).
- **Instantes en `timestamptz`.** Un `timestamptz` es un momento absoluto. Las 08:00 de San José y las 09:00 de
  Bogotá son el mismo instante (14:00 UTC). La hora local se obtiene con la zona de la clínica
  (`clinics.time_zone`).
- **Intervalos en `tstzrange` de la forma `[inicio, fin)`.** Un rango es un valor con dos extremos. El corchete
  incluye el inicio y el paréntesis excluye el fin: `[09:00, 09:30)` termina justo antes de las 09:30. Así, dos
  citas seguidas (`[09:00, 09:30)` y `[09:30, 10:00)`) **no** se solapan. Postgres trae el operador `&&`
  ("se solapan") y `@>` ("contiene").
- **Columnas de control.** `is_active` (baja lógica: se desactiva en vez de borrar, para no romper el historial),
  `created_at`, `updated_at` (la mantiene un trigger) y `updated_by`.
- **FKs diferidas.** `roles.updated_by` apunta a `users`, y `users.role_id` apunta a `roles`: es una referencia
  circular. ¿Qué se inserta primero? Las FKs de `updated_by` son `DEFERRABLE INITIALLY DEFERRED`: se revisan al
  hacer `COMMIT`, no en cada `INSERT`. Por eso `03-catalogs.sql` inserta los roles y el usuario Sistema en la
  misma transacción, y al confirmar ambos existen.

**E9. Rangos que se tocan contra rangos que se cruzan.**

```sql
SET TIME ZONE 'America/Costa_Rica';
SELECT tstzrange('2026-11-02 09:00', '2026-11-02 09:30') && tstzrange('2026-11-02 09:30', '2026-11-02 10:00') AS seguidas,
       tstzrange('2026-11-02 09:00', '2026-11-02 09:30') && tstzrange('2026-11-02 09:15', '2026-11-02 09:45') AS cruzadas;
-- seguidas = f, cruzadas = t
```

### 4.2 Las tablas por área 🟡

| Área | Tablas | Notas |
|---|---|---|
| Clínicas, usuarios y permisos | `clinics`, `users`, `roles`, `professionals`, `permissions`, `permissions_per_roles` | `users` guarda el `sub` de Keycloak, no contraseñas |
| Geografía | `countries`, `states`, `cities`, `addresses`, `clinics_addresses` | Dirección de las clínicas |
| Servicios | `specialties`, `specialties_per_professionals`, `services`, `services_per_professionals` | Qué atiende cada profesional (RF3, RF4) |
| Agenda | `professional_schedules`, `blockades`, `professional_contacts` | Horarios (RF5) y ausencias (RF6) |
| Pacientes | `genders`, `patients`, `contact_types`, `patient_contacts` | Los contactos son dato sensible (RF18) |
| Citas | `appointment_statuses`, `appointments`, `clinical_notes` | El corazón del sistema |
| Bitácoras | `event_types`, `data_objects`, `audit_logs`, `severities`, `system_errors_logs` | Auditoría (RF18) y errores técnicos |

### 4.3 Multi-tenancy en el motor 🔴

**Estrategia elegida: columna discriminadora.** Todas las clínicas comparten las mismas tablas, y cada fila de una
tabla de clínica lleva `clinic_id`. El README compara esta estrategia con "un esquema por clínica" (sección
"Estrategia de multi-tenancy"); léanla, es una pregunta segura de la defensa.

**El riesgo de esta estrategia** es que una consulta olvide el `WHERE clinic_id = …`, o que un dato de una clínica
termine apuntando a un dato de otra. Hay tres capas de protección:

1. **El `clinic_id` sale del token, nunca de la petición.** La API toma la clínica de `users` a partir del `sub`
   del token. Aunque alguien mande `clinic_id=2` en la URL, se usa la suya. **Pendiente** (API).
2. **FKs compuestas.** Es la parte que ya existe y se explica abajo.
3. **Pruebas automatizadas de fuga** que intentan leer datos de otra clínica. **Pendiente.**

#### Tres conceptos de base

- **Tabla, fila y columna.** Una tabla es como una hoja de Excel: cada fila es un registro (un usuario, una cita) y
  cada columna un dato (nombre, clínica…).
- **Llave primaria (PK).** Columna cuyo valor identifica **exactamente una fila**, como una cédula. El motor no
  deja que se repita. En `users` es `user_id`: Laura es el 6 y nadie más puede ser el 6.
- **Llave foránea (FK).** Columna que dice "el valor que guardo aquí tiene que existir en otra tabla". Es como un
  formulario donde se escribe la cédula del médico: antes de aceptarlo, alguien revisa que exista en el registro.

**Ninguna tabla hereda columnas de otra.** Cuando decimos "tabla que apunta" (o "tabla hija") y "tabla destino" (o
"padre"), solo hablamos de quién tiene la FK. Cada tabla declara sus propias columnas en su `CREATE TABLE` y guarda
números en ellas; la FK no copia nada, solo compara: "el número que guardaste aquí, ¿existe allá?". (Postgres tiene
una función llamada herencia, `INHERITS`, pero no la usamos.)

Por eso `professional_id` **guarda el número de un usuario**: en las citas de Laura, `professional_id = 6`. Tiene
otro nombre porque una fila puede mencionar a varios usuarios con papeles distintos. Una cita tiene
`professional_id` (quién atiende, por ejemplo Laura, 6) y `cancelled_by` (quién canceló, por ejemplo Pablo, 4); si
las dos se llamaran `user_id` no se podrían distinguir. En `professionals` la columna sí se llama `user_id`, porque
cada fila es el mismo usuario con datos extra.

#### Por qué apuntar al par (clínica, usuario) y no solo al usuario

**"El usuario 14 existe" y "el usuario 14 trabaja en la clínica 1" son preguntas distintas**, y una FK solo revisa
que lo buscado exista. Lo que importa es **qué** se le pide buscar:

| FK | Pregunta que hace el motor | Javier (usuario 14, Cartago) en una cita de San José |
|---|---|---|
| Simple: `professional_id → users (user_id)` | ¿Existe un usuario 14? | Sí existe: **se acepta** ✘ |
| De par: `(clinic_id, professional_id) → users (clinic_id, user_id)` | ¿Existe un usuario 14 **en la clínica 1**? | No: se rechaza ✔ |

Con la FK simple, el motor nunca compara la clínica de la cita con la del profesional. Analogía: llega una
referencia firmada por el "Dr. 14". Con la FK simple, el guarda revisa el registro nacional de médicos: existe, pasa.
Con la FK de par revisa la planilla **de este hospital**: no trabaja aquí, se rechaza. La FK de par convierte
"existe" en "existe **en esta clínica**", y para eso el número de clínica de la cita viaja dentro de la búsqueda.

Lo mismo vale para pacientes: `FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, patient_id)`. Si
`clinic_id = 1` (San José) y `patient_id = 81` (Cartago), la pareja `(1, 81)` no existe y el motor rechaza la fila.

#### Por qué hace falta un `UNIQUE` que parece redundante

Una FK es una promesa: "esta fila apunta a **una** fila concreta". Si se pudiera apuntar por nombre ("médico:
Laura") y hubiera dos Lauras, ¿a cuál apunta? ¿Y si se borra una? Para que nunca sea ambiguo, **el motor solo deja
apuntar a columnas con la garantía declarada de que no se repiten: una PK o un `UNIQUE`**. Además, declararlo crea
un **índice** (como el índice alfabético de un libro) con el que el motor encuentra el destino de inmediato en cada
inserción, sin leer la tabla entera.

Con el par pasa algo curioso. La PK declara que `user_id` no se repite; nosotros podemos razonar que entonces el par
`(clinic_id, user_id)` tampoco se repite, pero **el motor no hace ese razonamiento**: busca una declaración sobre
exactamente esas columnas y, si no la hay, ni siquiera deja crear la FK:

```
ERROR:  there is no unique constraint matching given keys for referenced table "u"
```

Por eso existen `uq_users_clinic_user UNIQUE (clinic_id, user_id)` y `uq_patients_clinic_patient UNIQUE
(clinic_id, patient_id)`: no cambian ningún dato, son el trámite que le declara al motor algo obvio para que permita
la FK. Cuestan un índice extra cada uno. (El orden de las columnas del `UNIQUE` no tiene que coincidir con el de la
FK; `clinic_id` va primero para que el mismo índice sirva a consultas como "usuarios de la clínica X".)

#### Una sola columna `clinic_id` en varias FKs

Tomen una cita de ejemplo: clínica 1, paciente 59 (Diego, clínica 1), profesional 6 (Laura, clínica 1), servicio 2
(Consulta general, clínica 1). Al guardarla, el motor hace estas búsquedas; fíjense de dónde sale el `1`:

| FK | Columnas de la cita | Busca en | Busca |
|---|---|---|---|
| paciente | `(clinic_id, patient_id)` | `patients` | (**1**, 59) |
| profesional | `(clinic_id, professional_id)` | `users` | (**1**, 6) |
| servicio | `(clinic_id, service_id)` | `services` | (**1**, 2) |
| servicio que el profesional atiende | `(clinic_id, professional_id, service_id)` | `services_per_professionals` | (**1**, 6, 2) |
| quién canceló | `(clinic_id, cancelled_by)` | `users` | (vacío hasta que se cancele) |
| cita original (reprogramación) | `(clinic_id, rescheduled_from_id)` | `appointments` | (vacío si no es reprogramación) |

El `1` sale **siempre de la misma celda**. Como hay un solo valor, todas las búsquedas usan la misma clínica: paciente,
profesional, servicio, quien canceló y la cita original **tienen que ser de la misma clínica que la cita**. Si cada
FK tuviera su propia columna (`patient_clinic_id`, `professional_clinic_id`…), una fila podría tener 1, 2 y 1, cada
FK estaría satisfecha por separado y la cita mezclaría clínicas. **Compartir una sola columna es lo que obliga a que
todo coincida.** El mismo patrón aparece en `services_per_professionals`, `professional_schedules`, `blockades`,
`professional_contacts`, `patient_contacts` y `audit_logs`.

También protege en sentido contrario: no se puede cambiar la clínica de un usuario que ya tiene filas que lo
referencian. Y tiene una consecuencia que deben conocer: el administrador de plataforma tiene `clinic_id` NULL, así
que **nunca** coincide con un par `(clínica, usuario)`. No puede cancelar citas ni aparecer en la bitácora de una
clínica. Es coherente con que no opere datos clínicos, pero es una decisión que deben poder explicar.

**¿Por qué `professional_id` tiene dos FKs?** En `appointments`, `professional_id` apunta a:

- `users (clinic_id, user_id)`: el profesional es de la misma clínica (I5);
- `professionals (user_id)`: ese usuario realmente es un profesional, no un recepcionista.

**E10. Un contacto de San José para un paciente de Cartago.**

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
INSERT INTO patient_contacts (clinic_id, patient_id, contact_type_id, contact_value, updated_by)
VALUES (1, (SELECT patient_id FROM patients WHERE clinic_id = 2 LIMIT 1), 1, '8888-8888', 4);
ROLLBACK;
-- ERROR: ... violates foreign key constraint "patient_contacts_clinic_id_patient_id_fkey"
-- DETAIL: Key (clinic_id, patient_id)=(1, 81) is not present in table "patients".
```

**E10b. Una sola columna, varias FKs.** Como `mc_owner`. Normalmente un trigger rechaza antes cualquier cambio de
paciente o servicio ("Una cita no se mueve ni cambia de servicio"); para ver solo las FKs se desactivan los triggers
de la tabla dentro de la transacción, y el `ROLLBACK` los reactiva. Cada `SAVEPOINT … ROLLBACK TO` deshace un
intento para poder probar el siguiente.

Los números de cita cambian según el día en que se cargan los datos (el seed genera citas alrededor de la fecha
actual), así que la primera línea busca una cita de Laura marcada como ausente y guarda su número en la variable
`:cita` con `\gset`, un comando de `psql`. Se elige una ausente porque el `EXCLUDE` solo mira las reservadas y
porque no tiene notas clínicas que la referencien: así no interfiere ninguna otra regla.

```sql
SELECT appointment_id AS cita, patient_id AS paciente FROM appointments
WHERE professional_id = 6 AND appointment_status_id = 3 ORDER BY appointment_id LIMIT 1 \gset
BEGIN;
ALTER TABLE appointments DISABLE TRIGGER USER;
SAVEPOINT a; UPDATE appointments SET patient_id = 81      WHERE appointment_id = :cita; ROLLBACK TO a;
SAVEPOINT b; UPDATE appointments SET professional_id = 14 WHERE appointment_id = :cita; ROLLBACK TO b;
SAVEPOINT c; UPDATE appointments SET service_id = 5       WHERE appointment_id = :cita; ROLLBACK TO c;
SAVEPOINT d; UPDATE appointments SET clinic_id = 2        WHERE appointment_id = :cita; ROLLBACK TO d;
ROLLBACK;
-- a: Key (clinic_id, patient_id)=(1, 81) is not present in table "patients".
-- b: Key (clinic_id, professional_id)=(1, 14) is not present in table "users".
-- c: Key (clinic_id, service_id)=(1, 5) is not present in table "services".
-- d: Key (clinic_id, patient_id)=(2, <paciente de la cita>) is not present in table "patients".
```

El caso `d` es el más revelador: al cambiar **solo** `clinic_id` se rompen todas las búsquedas a la vez (el motor
reporta la primera).

**E10c. Lo que aceptaría una FK simple.** Como `mc_owner`: se cambia la FK de par por una simple y se le pone a
Javier (Cartago) a una cita de San José. Usa la variable `:cita` de E10b.

```sql
BEGIN;
ALTER TABLE appointments DISABLE TRIGGER USER;
ALTER TABLE appointments DROP CONSTRAINT appointments_clinic_id_professional_id_service_id_fkey;
ALTER TABLE appointments DROP CONSTRAINT appointments_clinic_id_professional_id_fkey;
ALTER TABLE appointments ADD FOREIGN KEY (professional_id) REFERENCES users (user_id);
UPDATE appointments SET professional_id = 14 WHERE appointment_id = :cita;
SELECT a.clinic_id AS clinica_cita, u.name AS profesional, u.clinic_id AS clinica_profesional
FROM appointments a JOIN users u ON u.user_id = a.professional_id WHERE a.appointment_id = :cita;
ROLLBACK;
-- clinica_cita = 1, profesional = Javier, clinica_profesional = 2: la base lo aceptó
```

#### Alternativas que se descartaron 🟡

Antes, un concepto: la **concurrencia**. La API atiende muchas peticiones a la vez y cada una trabaja en su propia
**transacción**. Mientras una transacción no confirma (`COMMIT`), las demás **no ven** sus cambios. De ahí salen los
errores más traicioneros.

**A. Validar solo en el backend.** Antes de insertar, el código consulta de qué clínica es el profesional y la
compara con la de la cita.

- Cada ruta tiene que acordarse. Serán más de 20 rutas escritas por 5 personas; basta que una lo olvide para que
  exista una cita que mezcla clínicas, y nadie se entera hasta que un paciente de Cartago aparece en un reporte de
  San José.
- Lo que no pasa por la API se salta la validación: un `psql` manual, un script de carga, un servicio futuro.
- Tiene el mismo problema de concurrencia que la alternativa B.
- **Veredicto:** el backend **sí** debe validar, para dar mensajes amables, pero como primer filtro y no como la
  garantía. La pregunta rectora es que la base garantice la regla aunque el backend se equivoque.

**B. Un trigger que compare clínicas.** Un trigger (sección 4.7) es una función que el motor ejecuta sola antes o
después de cada inserción o actualización. Antes de insertar una cita, buscaría la clínica del paciente, del
profesional y del servicio, y rechazaría la fila si alguna no coincide.

- Hay que escribirlo en cada tabla que apunta a usuarios (son 6) **y** del otro lado: si alguien cambia la clínica de
  Laura en `users`, otro trigger debe revisar que no tenga filas en otras clínicas.
- **Tiene una carrera:**

  | Momento | A: reserva una cita con Laura en la clínica 1 | B: un admin mueve a Laura a la clínica 2 |
  |---|---|---|
  | 1 | El trigger lee `users`: Laura es de la clínica 1 ✔ | |
  | 2 | Inserta la cita (sin confirmar) | |
  | 3 | | El trigger busca citas de Laura en otra clínica: la de A **todavía no es visible** ✔ |
  | 4 | | Cambia a Laura a la clínica 2 y confirma |
  | 5 | Confirma | |

  Resultado: una cita de la clínica 1 con una profesional de la clínica 2. Cada trigger vio un mundo válido y aun así
  el final es inválido.
- **Con la FK no pasa.** En el momento 2, la verificación de la FK le pone un **candado** a la fila de Laura en
  `users` ("alguien me apunta, no cambies mi llave"). En el momento 4, B tiene que **esperar** a que A termine;
  cuando A confirma, el motor revisa de nuevo y rechaza a B. Un trigger puede imitar el candado con `FOR SHARE` (lo
  hace `appointments_check_agenda`), pero hay que acordarse y hacerlo bien; la FK lo trae incluido.
- **Veredicto:** los triggers son para reglas que una FK **no puede** expresar, como "la cita cae dentro del horario"
  (ahí sí usamos uno). Para "misma clínica", la FK alcanza y es más segura.

**C. No guardar `clinic_id` en la cita y deducirlo.** La clínica de una cita se obtendría buscando la de su paciente.

- Cada FK simple revisaría que el paciente, el profesional y el servicio existan, pero **nada los compararía entre
  sí**: Diego (San José) con Javier (Cartago) se aceptaría. Haría falta un trigger, y se vuelve a la alternativa B.
- Toda consulta de "citas de la clínica 1" necesitaría unir tablas.
- **Veredicto:** guardar `clinic_id` en la cita parece redundante (sección 4.10), pero es justo lo que permite que
  las FKs comparen.

**D. Row Level Security (RLS).** Una regla pegada a la tabla: "esta sesión solo ve y modifica filas donde
`clinic_id` = la clínica del usuario conectado".

- Resuelve **otro** problema, *quién ve qué*: si una consulta olvida el `WHERE clinic_id = …`, no se filtran filas de
  otras clínicas. Es muy útil.
- No resuelve el nuestro: una cita con `clinic_id = 1` pasa la regla, que no revisa que el profesional 14 sea de otra
  clínica. Se podría escribir la regla con una subconsulta, pero sería un trigger disfrazado, con las mismas
  carreras. Además, el motor ignora RLS a propósito al verificar FKs.
- **Veredicto:** complementa, no reemplaza. La FK garantiza que los datos sean coherentes; RLS controla quién ve qué.
  Es un buen "trabajo futuro" para mencionar en la defensa.

**E. Un esquema (o una base) por clínica.** Un esquema es como una carpeta de tablas dentro de la base. Cada clínica
tendría su copia de las 30 tablas (`sanjose.appointments`, `cartago.appointments`) y mezclar sería imposible por
construcción.

- Crear una clínica (RF1) significaría crear 30 tablas con el sistema corriendo.
- Cada cambio al esquema se aplicaría N veces; con 500 clínicas, si falla en la 237, queda a medio migrar.
- Los reportes de plataforma tendrían que juntar N tablas.
- En cada petición habría que elegir la carpeta correcta; equivocarse es una fuga. El riesgo no desaparece, se muda.
- **Veredicto:** se usa con pocas clínicas grandes y exigencias legales de aislamiento. Para un SaaS con muchas
  clínicas pequeñas, lo normal son tablas compartidas con `clinic_id`. El README compara ambas estrategias.

### 4.4 Usuarios, roles y profesionales 🟡

- **`users.keycloak_sub`** es el `sub` del token (Parte 6). Es el puente entre la identidad de Keycloak y la clínica
  y el rol en nuestro sistema. Keycloak no sabe nada de clínicas.
- **`ck_users_platform_admin`: `CHECK ((role_id = 1) = (clinic_id IS NULL))`.** Compara dos verdaderos o falsos:

  | ¿Es admin de plataforma? | ¿No tiene clínica? | ¿Se acepta? |
  |---|---|---|
  | sí | sí | ✓ |
  | no | no (tiene clínica) | ✓ |
  | sí | no | ✗ |
  | no | sí | ✗ |

  Es decir: el administrador de plataforma, **y solo él**, no pertenece a ninguna clínica (RF2).
- **`professionals` es una especialización de `users`.** Un profesional es un usuario con datos extra (número de
  colegiado). Su llave primaria es el mismo `user_id`. Con una FK simple `user_id → users`, la base solo revisaría
  que el usuario exista, y una recepcionista podría tener licencia y agenda. Para garantizar que **solo un usuario
  con rol `professional` pueda estar en esta tabla** se combinan tres piezas:

  | Pieza | Qué hace |
  |---|---|
  | `uq_users_user_role UNIQUE (user_id, role_id)` en `users` | El trámite de la sección 4.3: permite que una FK apunte al par |
  | `professionals.role_id` con `DEFAULT 4` y `CHECK (role_id = 4)` | Obliga a que el par buscado sea siempre (x, **4**), es decir, "x con rol profesional" |
  | FK `fk_professionals_user_role (user_id, role_id) → users (user_id, role_id)` | La búsqueda en sí: rechaza a quien no tiene rol 4 e impide cambiarle el rol a quien ya es profesional |

  **La ganancia:** las tablas de horarios, bloqueos, servicios y contactos del profesional apuntan a
  `professionals (user_id)`. "Estar en `professionals`" ya significa "es profesional", así que todas obtienen esa
  garantía sin repetir el truco, y `appointments` también, a través de `services_per_professionals`.

#### El truco del rol, paso a paso

**Estado inicial.** En `users`:

| user_id | clinic_id | role_id | nombre |
|---|---|---|---|
| 4 | 1 | 3 (recepción) | Pablo |
| 6 | 1 | 4 (profesional) | Laura |

El `UNIQUE (user_id, role_id)` mantiene un índice ordenado con los pares `(4, 3)` y `(6, 4)`: ahí busca la FK. En
`professionals` está la fila `(6, 4, 'MED-10482')`.

| Momento | Qué se intenta | Qué revisa el motor | Resultado |
|---|---|---|---|
| 1. Así entró Laura | `INSERT INTO professionals (user_id, license_number) VALUES (6, 'MED-10482')` | El `DEFAULT` pone `role_id = 4`. CHECK: ¿es 4? ✔. FK: ¿existe `(6, 4)`? ✔ | Aceptado |
| 2. Pablo | Lo mismo con `user_id = 4` | DEFAULT 4. CHECK ✔. FK: ¿existe `(4, 4)`? La lista tiene `(4, 3)` ✘ | Rechazado por la FK |
| 3. Pablo hace trampa | Escribe `role_id = 3` a mano | FK: ¿existe `(4, 3)`? **¡Sí!** La FK sola lo dejaría pasar. CHECK: ¿es 4? ✘ | Rechazado por el CHECK |
| 4. Laura pasa a recepción | `UPDATE users SET role_id = 3 WHERE user_id = 6` | El par `(6, 4)` desaparecería, pero `professionals` lo sigue apuntando ✘ | Rechazado por la FK |

El momento 3 explica para qué existe el `CHECK`: sin él, cualquiera podría entrar declarando su propio rol. El
momento 4 es la protección del otro lado: mientras alguien sea profesional, no se le puede cambiar el rol. (Para
convertir a un profesional en recepcionista, en la práctica se le da de baja y se registra como un usuario nuevo.)

**Por qué no usamos `ON UPDATE CASCADE`.** Una versión anterior del esquema lo tenía: al cambiar el rol, el motor
intentaba arrastrar el 3 hasta `professionals` y entonces el CHECK lo rechazaba. El resultado era el mismo (el cambio
se rechaza), pero con un paso más que explicar y un mensaje menos claro; se quitó. Ahora la FK usa la acción por
defecto (`NO ACTION`): "no puedes cambiar esa llave porque alguien la está apuntando".

#### Alternativas que se descartaron 🟡

- **Solo en el backend.** Los mismos tres problemas de la sección 4.3: rutas que olvidan validar, accesos que no
  pasan por la API y concurrencia.
- **Dos triggers** (al insertar en `professionals`: "¿tiene rol 4?"; al cambiar el rol en `users`: "¿está en
  `professionals`?"). Tienen la misma carrera:

  | Momento | A: registrar a Laura como profesional | B: cambiar a Laura a recepción |
  |---|---|---|
  | 1 | El trigger lee: Laura tiene rol 4 ✔ | |
  | 2 | Inserta en `professionals` (sin confirmar) | |
  | 3 | | El trigger: ¿Laura está en `professionals`? La fila de A no es visible ✔ |
  | 4 | | Cambia el rol a 3 y confirma |
  | 5 | Confirma | |

  Resultado: una recepcionista con licencia y agenda. Con la FK, B debe esperar el candado que puso A y luego es
  rechazada: el motor hace esperar a quien cambia `role_id` porque es parte de una llave que una FK está usando.
- **Fusionar `professionals` en `users`**, con `license_number` opcional y
  `CHECK ((role_id = 4) = (license_number IS NOT NULL))` ("tiene licencia si y solo si es profesional"). Parece más
  simple, pero horarios, bloqueos, servicios y contactos apuntarían a `users (user_id)`, y esa FK solo revisa que el
  usuario exista: **un horario para Pablo se aceptaría**. Para impedirlo habría que repetir el truco del rol en cada
  una de esas tablas. Además, 3 de los 4 roles cargarían columnas siempre vacías. Con la tabla separada, el truco
  se hace **una sola vez**.
- **Columna generada:** `role_id SMALLINT GENERATED ALWAYS AS (4) STORED`. El motor calcula el valor y nadie puede
  escribir otro, así que sobra el CHECK. Funciona (se probó en Postgres 18); es una cuestión de estilo y es menos
  conocida. Las dos versiones se pueden defender.
- **Varios roles por persona** (una tabla `users_roles` con una fila por rol). Hoy cada usuario tiene **un** rol: si
  Gabriela administra la clínica y además atiende pacientes, necesita dos cuentas. Con varios roles, el truco seguiría
  funcionando (`professionals` apuntaría a `users_roles (user_id, role_id)`), pero los permisos serían la unión de
  todos los roles y la API tendría que decidir con cuál actúa el usuario en cada petición. Es una decisión de alcance,
  del mismo estilo que "un usuario pertenece a exactamente una clínica" (RF2).

**E11. El truco del rol, pieza por pieza.** Como `mc_owner`. Cada bloque es independiente.

```sql
-- Momento 2: Pablo (recepción) como profesional
BEGIN;
INSERT INTO professionals (user_id, license_number, updated_by) VALUES (4, 'MED-FALSA', 1);
ROLLBACK;
-- ERROR: ... violates foreign key constraint "fk_professionals_user_role"
-- DETAIL: Key (user_id, role_id)=(4, 4) is not present in table "users".

-- Momento 3: Pablo declara su propio rol
BEGIN;
INSERT INTO professionals (user_id, role_id, license_number, updated_by) VALUES (4, 3, 'MED-FALSA', 1);
ROLLBACK;
-- ERROR: new row for relation "professionals" violates check constraint "ck_professionals_role"

-- Momento 4: cambiar el rol de Laura
BEGIN;
UPDATE users SET role_id = 3 WHERE user_id = 6;
ROLLBACK;
-- ERROR: update or delete on table "users" violates foreign key constraint "fk_professionals_user_role" on table "professionals"
-- DETAIL: Key (user_id, role_id)=(6, 4) is still referenced from table "professionals".

-- Sin la pieza del rol en la FK (una FK simple), Pablo entra
BEGIN;
ALTER TABLE professionals DROP CONSTRAINT fk_professionals_user_role;
ALTER TABLE professionals ADD FOREIGN KEY (user_id) REFERENCES users (user_id);
INSERT INTO professionals (user_id, license_number, updated_by) VALUES (4, 'MED-FALSA', 1);
SELECT user_id, role_id, license_number FROM professionals WHERE user_id = 4;
ROLLBACK;
-- 4 | 4 | MED-FALSA: la base solo revisó que el usuario 4 existe
```

### 4.5 Agenda: horarios y bloqueos 🟡

- **`professional_schedules` guarda bloques concretos**, por ejemplo "lunes 2 de noviembre de 08:00 a 12:00", no
  una plantilla semanal ("todos los lunes de 8 a 12"). Razones: el horario puede cambiar de una semana a otra, un
  bloque concreto ya es un instante absoluto (la conversión de zona horaria se hace una vez, al crearlo), y las
  consultas de disponibilidad son más simples. La limitación (documentada en el README): si no se cargan los
  bloques de una semana, ese profesional no tiene disponibilidad esa semana.
- Puede haber **varios bloques por día** (jornada partida, RF5).
- **`ex_schedules_overlap`**: un profesional no puede tener dos bloques que se solapen.
- **`blockades`** (RF6) son ausencias: vacaciones, permisos. **Sí pueden solaparse entre sí.** Un bloqueo retira
  disponibilidad, pero **no cancela** las citas ya reservadas que caen dentro: esas quedan como **conflictos** para
  que recepción las reprograme (ver E25).

### 4.6 Citas: el corazón del sistema 🔴

Tabla `appointments`, en `db/sql/01-schema.sql:332`. Léanla completa.

**Las columnas clave:**

- `period`: el intervalo `[inicio, fin)` de la cita. **La API solo envía el inicio** (`tstzrange(inicio, NULL)`) y
  un trigger calcula el fin con la duración del servicio (I4, ver 4.7).
- `appointment_status_id`: 1 reservada, 2 atendida, 3 ausente, 4 cancelada, 5 reprogramada. Solo la reservada es
  "vigente"; las otras cuatro son estados finales.
- `cancel_reason`, `cancelled_by`, `cancelled_at`: datos de la cancelación (RF11).
- `rescheduled_from_id`: en una cita creada al reprogramar, la cita original (RF10).

#### La restricción `EXCLUDE`: la respuesta a la pregunta rectora

```sql
CONSTRAINT ex_appointments_professional
    EXCLUDE USING gist (professional_id WITH =, period WITH &&) WHERE (appointment_status_id = 1)
```

Léanla así: **"no pueden existir dos filas con el mismo `professional_id` (`=`) cuyos `period` se solapen (`&&`),
contando solo las citas reservadas (`WHERE appointment_status_id = 1`)."**

- Un `UNIQUE` es un caso particular de `EXCLUDE` en el que todos los operadores son `=`. `EXCLUDE` permite otros
  operadores, como `&&` para rangos.
- Necesita un índice **GiST**, que sabe indexar rangos. La extensión `btree_gist` permite mezclar en el mismo índice
  un entero comparado con `=`. Por eso el esquema empieza con `CREATE EXTENSION btree_gist`.
- El `WHERE` la hace **parcial**: las citas canceladas, atendidas, etc. no ocupan espacio. **Así se cumple I7**: al
  cancelar, la fila deja de contar en el mismo `COMMIT` y el espacio queda libre.
- `ex_appointments_patient` hace lo mismo con el paciente (I2).

#### Por qué no basta con revisar antes de insertar

Si la API hiciera "`SELECT` para ver si está libre; si está libre, `INSERT`":

| Momento | Recepción A | Recepción B |
|---|---|---|
| 1 | `SELECT`: ¿hay cita a las 9:00? → no | |
| 2 | | `SELECT`: ¿hay cita a las 9:00? → no |
| 3 | `INSERT` cita de las 9:00 | |
| 4 | | `INSERT` cita de las 9:00 |
| 5 | `COMMIT` | `COMMIT` → **doble reserva** ❌ |

Las dos leyeron "libre" antes de que la otra escribiera. Con la restricción `EXCLUDE`:

| Momento | Recepción A | Recepción B |
|---|---|---|
| 1 | `INSERT` 9:00 → su fila entra al índice, todavía sin confirmar | |
| 2 | | `INSERT` 9:00 → encuentra en el índice la fila de A, que choca → **espera** a que A termine |
| 3 | `COMMIT` | |
| 4 | | **ERROR `23P01`** (`exclusion_violation`) → la API responderá 409 "espacio ya tomado" |

Si en el momento 3 A hiciera `ROLLBACK`, B continuaría y ganaría. **Siempre gana exactamente una.**

**Nivel de aislamiento: `READ COMMITTED`**, el que Postgres usa por defecto, es suficiente, porque la protección no
depende de lo que cada transacción "ve", sino del índice, que es compartido. El README (sección "Concurrencia y
nivel de aislamiento") explica por qué se descartaron `SERIALIZABLE` y `SELECT … FOR UPDATE`.

#### Las otras reglas de la tabla

- **FK a `services_per_professionals (clinic_id, professional_id, service_id)`:** solo se puede reservar un servicio
  que el profesional tiene habilitado (RF4).
- **`ck_appointments_cancellation`:** si el estado es "cancelada", los tres datos de cancelación están presentes; en
  cualquier otro estado, los tres están vacíos. Usa `num_nonnulls(a, b, c)`, que cuenta cuántos no son NULL.
- **Reprogramar (RF10)** se hace en una sola transacción: la original pasa a `reprogramada` (deja de ocupar
  espacio) y se inserta la nueva con `rescheduled_from_id`. Si el `INSERT` falla, el `ROLLBACK` deja la original
  intacta. `UNIQUE (rescheduled_from_id)` impide reprogramar dos veces la misma cita.
- **Deadlock:** dos reprogramaciones que se cruzan (A se mueve al espacio de B y B al de A) pueden bloquearse
  mutuamente. Postgres lo detecta y aborta una con `40P01`; la API deberá reintentar o responder 409.

#### Experimentos

Como `mc_app`.

**E12. Reservar un espacio que ya está ocupado.**

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period, updated_by)
SELECT clinic_id, patient_id, professional_id, service_id, tstzrange(lower(period), NULL), 4
  FROM appointments
 WHERE appointment_status_id = 1 AND lower(period) > now()
 ORDER BY appointment_id LIMIT 1;
ROLLBACK;
-- ERROR: conflicting key value violates exclusion constraint "ex_appointments_professional"
```

**E13. La carrera de verdad, con dos terminales.** Es el experimento más importante: es la pregunta rectora.

*Preparación* (una sola vez, en cualquier terminal como `mc_app`): se crea un bloque de horario para Laura (usuaria
6) dentro de 40 días, de 9:00 a 10:00, donde no hay citas.

```sql
BEGIN;
SET LOCAL ROLE mc_clinic_admin;
INSERT INTO professional_schedules (clinic_id, professional_id, period, updated_by)
VALUES (1, 6, tstzrange((current_date + 40 + time '09:00') AT TIME ZONE 'America/Costa_Rica',
                        (current_date + 40 + time '10:00') AT TIME ZONE 'America/Costa_Rica'), 3);
COMMIT;
```

*Ronda 1.* Abran **dos terminales** como `mc_app`. En la **terminal 1**:

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period, updated_by)
VALUES (1, 1, 6, (SELECT min(service_id) FROM services_per_professionals WHERE professional_id = 6),
        tstzrange((current_date + 40 + time '09:00') AT TIME ZONE 'America/Costa_Rica', NULL), 4);
-- No hagan COMMIT todavía.
```

En la **terminal 2**, lo mismo pero con el paciente 2 (`VALUES (1, 2, 6, …)`). **Se queda esperando.**

Vuelvan a la terminal 1 y escriban `ROLLBACK;`. La terminal 2 se desbloquea y su `INSERT` **funciona**: como la
primera se arrepintió, la segunda gana. Escriban `ROLLBACK;` también en la terminal 2.

*Ronda 2.* Repitan, pero en la terminal 1 terminen con `COMMIT;`. La terminal 2 se desbloquea con
**`ERROR: conflicting key value violates exclusion constraint`**. Escriban `ROLLBACK;` en la terminal 2.

*Limpieza*, como `mc_owner` (o simplemente `docker compose down -v`):

```sql
DELETE FROM appointments
 WHERE professional_id = 6 AND lower(period) = (current_date + 40 + time '09:00') AT TIME ZONE 'America/Costa_Rica';
DELETE FROM professional_schedules
 WHERE professional_id = 6 AND lower(period) = (current_date + 40 + time '09:00') AT TIME ZONE 'America/Costa_Rica';
```

**E14. Cancelar libera el espacio, y el fin lo decide el servicio (I7 e I4).** Se cancela una cita futura y, en la
misma transacción, se reserva ese mismo espacio mandando un fin absurdo de 5 horas.

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
UPDATE appointments
   SET appointment_status_id = 4, cancel_reason = 'Prueba de la guía',
       cancelled_by = 4, cancelled_at = now(), updated_by = 4
 WHERE appointment_id = (SELECT min(a.appointment_id) FROM appointments a
                          WHERE a.clinic_id = 1 AND a.appointment_status_id = 1 AND lower(a.period) > now()
                            AND NOT EXISTS (SELECT 1 FROM blockades b
                                             WHERE b.professional_id = a.professional_id
                                               AND b.period && a.period))
RETURNING appointment_id, service_id, period;

INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period, updated_by)
SELECT clinic_id, patient_id, professional_id, service_id,
       tstzrange(lower(period), lower(period) + interval '5 hours'), 4
  FROM appointments WHERE cancel_reason = 'Prueba de la guía'
RETURNING appointment_id, service_id, period;
ROLLBACK;
```

Resultado: el `INSERT` funciona (el espacio quedó libre al cancelar) y el `period` nuevo **termina igual que el
original**, no 5 horas después: el trigger ignoró el fin enviado y lo calculó con la duración del servicio.

**E15. Cancelar sin motivo.**

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
UPDATE appointments SET appointment_status_id = 4, updated_by = 4
 WHERE appointment_id = (SELECT min(appointment_id) FROM appointments
                          WHERE clinic_id = 1 AND appointment_status_id = 1 AND lower(period) > now());
ROLLBACK;
-- ERROR: new row for relation "appointments" violates check constraint "ck_appointments_cancellation"
```

### 4.7 Los triggers 🔴

Un **trigger** es una función que el motor ejecuta automáticamente cuando ocurre algo en una tabla.

- **`BEFORE` o `AFTER`:** antes o después de escribir la fila. Todos los nuestros son `BEFORE`: revisan (y a veces
  corrigen) la fila antes de que se guarde.
- **`FOR EACH ROW`:** se ejecuta una vez por fila. Dentro, `NEW` es la fila nueva y `OLD` la anterior.
- **`RAISE EXCEPTION … USING ERRCODE = 'MC001'`:** aborta la operación con un código de error propio.
- **Orden:** si hay varios triggers para el mismo evento, Postgres los ejecuta en **orden alfabético de nombre**.
  Por eso los de citas se llaman `…_10_…`, `…_20_…`, `…_30_…`.

**Códigos de error propios** (los define el esquema para que la API los traduzca a respuestas HTTP):

| Código | Significado | Regla |
|---|---|---|
| `MC001` | La cita cae fuera del horario o dentro de un bloqueo | I3 |
| `MC002` | Transición de estado no permitida | RF13 |
| `MC003` | Desenlace registrado antes de la hora de inicio | RF12 |
| `MC004` | Intento de mover una cita o cambiarle el servicio | I4 |
| `MC005` | Intento de modificar o borrar la bitácora | I6 |
| `MC006` | El bloque de horario tiene citas reservadas | I3 |

#### `set_updated_at` 🟡 (`db/sql/01-schema.sql:453`)

Pone `updated_at = now()` en cada `UPDATE`. En vez de crear 22 triggers a mano, un bloque `DO` recorre todas las
tablas que tienen la columna `updated_at` y crea el trigger en cada una.

#### `trg_appointments_10_set_period`: I4 🔴 (`:477`)

- **Al insertar:** busca la duración del servicio y reescribe `period` como `[inicio, inicio + duración)`. Ignora
  cualquier fin que mande la aplicación.
- **Al actualizar:** si cambia `period`, `service_id`, `professional_id`, `patient_id` o `clinic_id`, aborta con
  `MC004`. Una cita no se mueve; **se reprograma** (se crea otra).

Esto es una segunda capa sobre el permiso por columna de la Parte 3: aunque alguien tuviera permiso para cambiar
`period` (por ejemplo, el dueño), el trigger igual lo impide.

**¿Por qué guardar el fin si se puede calcular?** Es una desnormalización deliberada (README): la restricción
`EXCLUDE` solo puede usar columnas de la propia fila, no consultar `services`; y la cita conserva la duración con la
que se reservó aunque después cambie la del servicio.

#### `trg_appointments_20_check_agenda`: I3 🔴 (`:527`)

Al insertar una cita, revisa dos cosas:

1. **La cita cabe en el horario.** Junta los bloques de horario del profesional que tocan la cita con
   `range_agg`, que une bloques contiguos (08:00–12:00 y 12:00–16:00 se vuelven 08:00–16:00), y comprueba que el
   resultado **contiene** (`@>`) la cita. Gracias a la unión, una cita de 11:45 a 12:15 se acepta aunque cruce de un
   bloque al siguiente.
2. **No cae en un bloqueo.** Si hay un bloqueo que se solapa, aborta con `MC001`.

Dos detalles avanzados 🟡:

- **`FOR SHARE`.** Sin él podría ocurrir esta carrera: recepción reserva a las 9:00 mientras el administrador borra
  el bloque de 8 a 12. El trigger de la reserva ve el bloque y acepta; el administrador no ve la cita (todavía no
  está confirmada) y borra. Ambos confirman y queda una cita fuera de horario. Con `FOR SHARE`, la reserva "sujeta"
  los bloques que usa hasta su `COMMIT`. El borrado tiene que esperar, y cuando por fin corre, su trigger
  (`professional_schedules_guard`) ya ve la cita confirmada y lo rechaza con `MC006`. Esto se probó con dos
  sesiones simultáneas: el borrado esperó 3 segundos y luego falló.
- **`SECURITY DEFINER`.** `FOR SHARE` exige permiso de `UPDATE` sobre `professional_schedules`, que recepción no
  tiene. `SECURITY DEFINER` hace que la función corra con los permisos de su dueño (`mc_owner`). Como eso es
  poderoso, se le fija `SET search_path = public, pg_temp`: así nadie puede engañarla creando un objeto con el mismo
  nombre en otro esquema.

#### `trg_appointments_30_check_status`: RF13 y RF12 🔴 (`:565`)

```text
                  ┌──► atendida      (2) ┐
                  ├──► ausente       (3) │  estados finales:
 reservada (1) ───┼──► cancelada     (4) │  no admiten ningún cambio
                  └──► reprogramada  (5) ┘
```

- Al insertar, toda cita debe nacer `reservada`; si no, `MC002`.
- Si la cita ya está en un estado final, **cualquier** cambio se rechaza con `MC002`.
- `atendida` o `ausente` solo después de la hora de inicio (`now() >= inicio`); antes, `MC003` (RF12).

#### `trg_professional_schedules_guard`: I3 desde el otro lado 🟡 (`:597`)

I3 se podría romper sin tocar la cita: borrando o recortando el bloque de horario donde está. Este trigger, al
borrar o modificar un bloque, revisa si quedarían **citas reservadas fuera**; si es así, aborta con `MC006`. La
variable `v_remaining` es lo que queda del bloque después del cambio (NULL si se borra o si se cambia de
profesional). Para las ausencias se usa un bloqueo (`blockades`), no el borrado del horario.

#### `trg_audit_logs_append_only` y `trg_audit_logs_no_truncate`: I6 🔴 (`:627`)

La función solo hace `RAISE EXCEPTION … MC005`. Se dispara antes de cualquier `UPDATE`, `DELETE` o `TRUNCATE`
sobre la bitácora. Es la segunda capa: la primera es que ningún rol tiene esos permisos. Si alguien concediera
`DELETE` por error, el trigger igual lo impediría; incluso el dueño de la tabla queda bloqueado (salvo que
desactive el trigger a propósito, y por eso la app no se conecta como dueño).

#### Experimentos

**E16. Reservar a las 3 de la mañana** (como `mc_app`).

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period, updated_by)
SELECT clinic_id, patient_id, professional_id, service_id,
       tstzrange(date_trunc('day', lower(period)) + interval '3 hours', NULL), 4
  FROM appointments
 WHERE clinic_id = 1 AND appointment_status_id = 1 AND lower(period) > now()
 ORDER BY appointment_id LIMIT 1;
ROLLBACK;
-- ERROR: La cita cae fuera del horario de atención del profesional (I3)
```

**E17. `range_agg` une bloques contiguos.**

```sql
SET TIME ZONE 'America/Costa_Rica';
SELECT range_agg(r) AS jornada,
       range_agg(r) @> tstzrange('2026-11-02 11:45', '2026-11-02 12:15') AS cita_entre_bloques_cabe
  FROM (VALUES (tstzrange('2026-11-02 08:00', '2026-11-02 12:00')),
               (tstzrange('2026-11-02 12:00', '2026-11-02 16:00'))) AS v(r);
-- jornada = {[08:00, 16:00)}, cita_entre_bloques_cabe = t
```

**E18. Ni el dueño puede mover una cita** (como `mc_owner`).

```sql
BEGIN;
UPDATE appointments SET period = tstzrange(lower(period) + interval '1 hour', NULL)
 WHERE appointment_id = (SELECT min(appointment_id) FROM appointments);
ROLLBACK;
-- ERROR: Una cita no se mueve ni cambia de servicio: se reprograma (I4, RF10)
```

**E19. Marcar como atendida una cita de mañana** (como `mc_app`).

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
UPDATE appointments SET appointment_status_id = 2, updated_by = 4
 WHERE appointment_id = (SELECT min(appointment_id) FROM appointments
                          WHERE clinic_id = 1 AND appointment_status_id = 1 AND lower(period) > now());
ROLLBACK;
-- ERROR: El desenlace solo se registra después de la hora de inicio (RF12)
```

**E20. Revivir una cita ya atendida.**

```sql
BEGIN;
SET LOCAL ROLE mc_reception;
UPDATE appointments SET appointment_status_id = 1, updated_by = 4
 WHERE appointment_id = (SELECT min(appointment_id) FROM appointments
                          WHERE clinic_id = 1 AND appointment_status_id = 2);
ROLLBACK;
-- ERROR: La cita está en un estado final y no admite cambios (RF13)
```

**E21. Borrar un bloque de horario con citas reservadas.**

```sql
BEGIN;
SET LOCAL ROLE mc_clinic_admin;
DELETE FROM professional_schedules
 WHERE schedule_id = (SELECT min(s.schedule_id) FROM professional_schedules s
                       JOIN appointments a ON a.professional_id = s.professional_id
                                          AND a.period && s.period AND a.appointment_status_id = 1
                      WHERE s.clinic_id = 1);
ROLLBACK;
-- ERROR: El bloque de horario tiene citas reservadas; reprográmelas antes (I3)
```

**E22. Atacar la bitácora, en dos capas.** Primero como `mc_app` con el rol del administrador:

```sql
BEGIN;
SET LOCAL ROLE mc_clinic_admin;
DELETE FROM audit_logs WHERE log_id = 1;
ROLLBACK;
-- ERROR: permission denied for table audit_logs        ← capa 1: permisos
```

Después como `mc_owner`, que sí tiene todos los permisos:

```sql
BEGIN;
DELETE FROM audit_logs WHERE log_id = 1;
ROLLBACK;
-- ERROR: La bitácora de auditoría no admite modificación ni borrado (I6)   ← capa 2: trigger

BEGIN;
TRUNCATE audit_logs;
ROLLBACK;
-- mismo error
```

### 4.8 Notas clínicas y bitácora 🔴

- **`clinical_notes`** (RF15) es el dato más sensible. Hay una nota por cita (`UNIQUE (appointment_id)`). **No
  guarda quién la escribió**: por definición es el profesional de la cita (`appointments.professional_id`).
  Guardarlo dos veces crearía dos copias del mismo hecho que podrían dejar de coincidir. La regla "solo la escribe
  el profesional que atendió" la aplicará la API (**pendiente**); la base garantiza que solo un profesional puede
  escribir notas.
- **`audit_logs`** (RF18, RF19) responde: **quién** (`user_id`), **qué hizo** (`event_type_id`: lectura,
  creación…), **sobre qué tipo de dato** (`data_object_id`: nota o contacto), **sobre cuál registro**
  (`object_id`), **de cuál paciente** (`patient_id`) y **cuándo** (`created_at`).
- **`object_id` no tiene FK** porque apunta a tablas distintas según `data_object_id` (a veces a una nota, a veces
  a un contacto). Es un compromiso: se pierde la verificación del motor sobre ese id, a cambio de una sola bitácora
  para todos los tipos de dato.
- **Ojo:** la base **protege** la bitácora, pero **escribir** una entrada en cada lectura o escritura de un dato
  sensible es trabajo de la API (**pendiente**). Los datos de demostración ya traen una bitácora simulada.

### 4.9 Índices 🟡

Un índice es una estructura auxiliar que permite encontrar filas sin recorrer toda la tabla. Cada uno sirve a una
consulta concreta; la lista con su justificación está en el README (sección de índices) y en el diccionario.

- **B-tree** (el normal): para `=`, `<`, `>` y ordenar. Ejemplo: `ix_appointments_clinic_start (clinic_id,
  lower(period))` sirve a "citas de la clínica 1 entre tal y tal hora" (RF20, RF21).
- **GiST**: para rangos y solapamientos (`&&`). Ejemplo: `ix_blockades_prof_period`.
- **Índice sobre una expresión** (`lower(period)`): solo se usa si la consulta filtra con **la misma expresión**,
  por ejemplo `WHERE lower(period) >= $1`.
- **Las restricciones crean su propio índice.** El `EXCLUDE` de citas ya es un índice GiST sobre
  `(professional_id, period)` de las reservadas, y sirve también para calcular disponibilidad (RF7).
- **Pendiente:** justificar cada índice con `EXPLAIN ANALYZE` (por eso los datos de demostración son grandes: con
  10 filas el planificador nunca usaría un índice).

### 4.10 Normalización y desnormalizaciones 🔴

El README las explica paso a paso (secciones "Normalización" y "Desnormalizaciones deliberadas"). Resumen: el
esquema está en 3FN, con cuatro desnormalizaciones deliberadas y justificadas:

1. `clinic_id` repetido en las tablas hijas (es la columna discriminadora y la base de las FKs compuestas);
2. `services_per_professionals.clinic_id`;
3. el fin de la cita guardado en `period`;
4. `professionals.role_id`.

### Preguntas de control

4.1. Expliquen con sus palabras qué significa `EXCLUDE USING gist (professional_id WITH =, period WITH &&)`.
4.2. ¿Por qué el `EXCLUDE` tiene `WHERE (appointment_status_id = 1)`? ¿Qué invariante se rompería sin él?
4.3. ¿Qué pasa en la base, paso a paso, cuando dos recepcionistas reservan el mismo espacio a la vez?
4.4. Un paciente tiene una cita a las 9:00 con Laura. Recepción le reserva otra a las 9:00 con Andrés, que tiene
horario libre. ¿Qué pasa?
4.5. ¿Por qué `(clinic_id, patient_id)` y no solo `patient_id` en la FK de `patient_contacts`?
4.6. ¿Para qué sirve `FOR SHARE` en `appointments_check_agenda`?
4.7. ¿Por qué hacen falta dos capas para proteger la bitácora?
4.8. Si `user_id` ya es la llave primaria, ¿para qué existe `UNIQUE (clinic_id, user_id)`?
4.9. En `professionals`, ¿qué pieza impide que Pablo entre escribiendo `role_id = 3`? ¿Y qué impide cambiarle el
rol a Laura?

---

## Parte 5. Catálogos y datos de demostración

### 5.1 Catálogos fijos (`db/sql/03-catalogs.sql`) 🟡

Son valores que el código usa por número o por nombre, así que forman parte del esquema, no de los datos de
prueba: roles (1–4), estados de cita (1–5), géneros, tipos de contacto, tipos de evento de la bitácora, tipos de
dato sensible, gravedades, los 16 permisos del dominio y la matriz rol → permiso.

**El usuario Sistema** (`user_id = 1`) es el autor (`updated_by`) de todos los datos iniciales. No puede iniciar
sesión: está inactivo y su `keycloak_sub` es el UUID de ceros, que ningún token trae. ⚪ Como se insertó con id
fijo, después se ajusta el contador (`setval`) para que el siguiente usuario reciba el 2.

### 5.2 Los datos de demostración (`db/sql/04-seed.sql`) 🟡

**Qué contiene:** 3 clínicas (San José y Cartago en Costa Rica; Bogotá en Colombia, con otra zona horaria), 11
profesionales, 240 pacientes, unos 800 bloques de horario, unas 4 000 citas en todos los estados, 1 300 notas
clínicas y 5 300 entradas de bitácora.

**Cómo está construido** (no hace falta leerlo línea por línea; sí entender estas ideas):

- **Primero los datos, después la lógica.** Arriba hay tablas temporales que se leen como una lista (clínicas,
  servicios, usuarios, horarios semanales, bloqueos). Abajo, `INSERT … SELECT` genéricos que las recorren. Para
  agregar un profesional basta una fila más.
- **Determinista.** No usa `random()`. La función `pg_temp.pick(texto, n)` calcula `abs(hashtext(texto)) % n`: el
  mismo texto da siempre el mismo número. Todos obtienen los mismos datos, y las pruebas son repetibles.
- **Relativo a la fecha.** Los horarios van de 8 semanas atrás a 4 semanas adelante **de la fecha en que se levanta
  la base**. Siempre hay "agenda de hoy" (RF20) y citas pasadas con desenlace. Cada `down -v` regenera los datos
  con fechas nuevas.
- **Zonas horarias reales.** Los horarios se escriben en hora local de cada clínica y se convierten con
  `AT TIME ZONE`: las 08:00 de San José se guardan como 14:00 UTC.
- **Las citas pasan por los mismos triggers que las de la API.** El seed recorre cada bloque en pasos de 30 minutos
  e intenta ocupar ~70 % de los espacios. Cuando un servicio largo invade el espacio siguiente, el `EXCLUDE` choca y
  `ON CONFLICT DO NOTHING` descarta esa cita. ⚪ `ON CONFLICT` solo atrapa choques de `UNIQUE`/`EXCLUDE`, no
  errores de triggers; por eso el seed filtra antes que la cita quepa en el bloque y no caiga en un bloqueo.
- **Los desenlaces respetan las reglas.** Las citas nacen reservadas y luego se actualizan (atendida, ausente,
  cancelada), pasando por el trigger de estados.
- **Las reprogramaciones** (una por clínica) se hacen igual que lo hará la API: en una transacción, la original
  pasa a `reprogramada` y se inserta la nueva. Si el espacio elegido choca, un bloque `BEGIN … EXCEPTION` deshace
  ambos cambios y prueba el siguiente.
- **Conflictos de RF6 a propósito.** La "Capacitación obligatoria" de Andrés Solís se registra **después** de
  generar las citas, así que 4 citas reservadas quedan dentro del bloqueo, listas para la futura consulta de
  conflictos.
- **Usuarios trampa para las pruebas:** `exrecepcion.sanjose` (activo en Keycloak, dado de baja en `users`) y
  `sinregistro` (existe en Keycloak, no en `users`).
- Al final, `ANALYZE` actualiza las estadísticas que usa el planificador de consultas.

### Experimentos

Como `mc_owner`.

**E23. Citas por estado** (es la consulta de RF21):

```sql
SELECT s.status_name, count(*)
  FROM appointments a JOIN appointment_statuses s USING (appointment_status_id)
 GROUP BY 1 ORDER BY 1;
```

**E24. La agenda de hoy en San José, en hora local y en UTC.** Si hoy es fin de semana puede salir vacía.

```sql
SELECT u.name || ' ' || u.last_name AS profesional,
       to_char(lower(a.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS inicio,
       to_char(upper(a.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS fin,
       to_char(lower(a.period), 'HH24:MI') AS inicio_utc,
       st.status_name
  FROM appointments a
  JOIN clinics c USING (clinic_id)
  JOIN users u ON u.user_id = a.professional_id
  JOIN appointment_statuses st USING (appointment_status_id)
 WHERE a.clinic_id = 1
   AND (lower(a.period) AT TIME ZONE c.time_zone)::date = (now() AT TIME ZONE c.time_zone)::date
 ORDER BY lower(a.period) LIMIT 10;
```

**E25. Los conflictos de RF6** (citas reservadas dentro de un bloqueo):

```sql
SELECT a.appointment_id, u.name || ' ' || u.last_name AS profesional, b.reason
  FROM appointments a
  JOIN blockades b ON b.professional_id = a.professional_id AND b.period && a.period
  JOIN users u ON u.user_id = a.professional_id
 WHERE a.appointment_status_id = 1;
-- 4 filas, todas de Andrés Solís, "Capacitación obligatoria"
```

**E26. I4 en todos los datos:** ninguna cita dura distinto de su servicio.

```sql
SELECT count(*) AS citas_con_duracion_distinta
  FROM appointments a JOIN services s USING (service_id)
 WHERE upper(a.period) - lower(a.period) <> make_interval(mins => s.duration_minutes);
-- 0
```

### Preguntas de control

5.1. ¿Por qué el seed no usa `random()`?
5.2. ¿Por qué los datos de demostración pasan por los triggers en vez de insertarse "a la fuerza"?

---

## Parte 6. Keycloak y los tokens

### 6.1 Conceptos 🔴

- **Proveedor de identidad (IdP).** Un servicio aparte que guarda usuarios y contraseñas y hace el login. Nuestra
  base nunca ve una contraseña. El enunciado lo exige.
- **OIDC (OpenID Connect).** El protocolo estándar con el que la aplicación le pide a Keycloak un token.
- **JWT (el token).** Tres partes en base64 separadas por puntos: `cabecera.contenido.firma`.
  - La **cabecera** dice con qué algoritmo se firmó (`RS256`) y con qué llave (`kid`).
  - El **contenido** trae los *claims*:

    | Claim | Significado | Ejemplo |
    |---|---|---|
    | `iss` | quién lo emitió | `http://localhost:8080/realms/medicitas` |
    | `aud` | para quién es | `medicitas-api` |
    | `sub` | quién es el usuario | `c0000001-0000-4000-8000-000000000002` |
    | `exp` | cuándo vence | (segundos desde 1970) |
    | `realm_access.roles` | sus roles | `["reception"]` |

  - La **firma** la calcula Keycloak con su **llave privada**. Cualquiera puede verificarla con la **llave
    pública**, que Keycloak publica en una URL (**JWKS**). Si alguien cambia una letra del contenido (por ejemplo,
    se pone `clinic_admin`), la firma deja de coincidir.
- **El token no está cifrado, solo firmado.** Cualquiera puede leer su contenido; lo que no puede es modificarlo.

### 6.2 El realm (`keycloak/medicitas-realm.json`) 🟡

El archivo se generó con un script y se importa solo al arrancar. Contiene:

- **Realm `medicitas`**, con los tokens válidos 15 minutos y el autorregistro desactivado.
- **4 roles de realm:** `platform_admin`, `clinic_admin`, `reception`, `professional`, con los mismos nombres que
  `roles.role_name` en la base.
- **Un client `medicitas-api`**, público y con *Direct Access Grants*: permite pedir un token con usuario y
  contraseña directamente (con `curl`, desde las pruebas). Es cómodo para desarrollo y lo pide el enunciado
  ("cliente de línea de comandos"). En producción se usaría el flujo con navegador (Authorization Code + PKCE).
- **Un *audience mapper*** que pone `aud: medicitas-api` en el token. La API rechazará tokens con otra audiencia:
  así, un token emitido para otra aplicación del mismo Keycloak no sirve contra la nuestra.
- **20 usuarios de prueba** (contraseña `medicitas`), con correo `@example.com`, un dominio reservado para ejemplos.

**Decisión clave 🔴: los ids de los usuarios están fijos y coinciden con la base.** El `id` de cada usuario en el
JSON (que se vuelve el `sub` del token) es el mismo `keycloak_sub` de `users` en `04-seed.sql`. Patrón legible:
`c0000001-…` es la clínica 1, `c0000002-…` la 2, etc. Si Keycloak generara ids aleatorios, cambiarían en cada
`down -v` y la asociación identidad → clínica se rompería. La cadena completa es:

```text
token.sub  →  users.keycloak_sub  →  users.clinic_id y users.role_id
```

### 6.3 Lo que hará la API con el token (pendiente) 🔴

1. Sin token, o con firma inválida, vencido, con otro `iss` u otro `aud` → **401**.
2. Buscar `sub` en `users`. Si no existe (`sinregistro`) o está inactivo (`exrecepcion.sanjose`) → **403**.
3. **Decisión del grupo pendiente:** el rol vive en dos lugares, el token y `users.role_id`. ¿Qué pasa si no
   coinciden? Es exactamente lo que pregunta el enunciado ("dos copias del mismo hecho"). Propuesta: 403 y
   documentarlo.
4. Traducir el rol a permisos del dominio; si no tiene el permiso de la operación → **403**.

### Experimentos

**E27. Pedir un token y leer su contenido** (en tu terminal, no en `psql`):

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/medicitas/protocol/openid-connect/token \
  -d grant_type=password -d client_id=medicitas-api \
  -d username=recepcion.sanjose -d password=medicitas | jq -r .access_token)

# Contenido
echo "$TOKEN" | jq -R 'split(".")[1] | gsub("-";"+") | gsub("_";"/") | @base64d | fromjson | {iss, aud, sub, realm_access, exp}'
# Cabecera
echo "$TOKEN" | jq -R 'split(".")[0] | gsub("-";"+") | gsub("_";"/") | @base64d | fromjson'
```

**E28. Seguir el `sub` hasta la base** (como `mc_owner`):

```sql
SELECT user_id, name, last_name, clinic_id, role_id, is_active
  FROM users WHERE keycloak_sub = 'c0000001-0000-4000-8000-000000000002';
-- clinic_id 1 (San José), role_id 3 (reception)
```

**E29. Contraseña incorrecta.**

```bash
curl -s -X POST http://localhost:8080/realms/medicitas/protocol/openid-connect/token \
  -d grant_type=password -d client_id=medicitas-api \
  -d username=recepcion.sanjose -d password=equivocada
# {"error":"invalid_grant", ...}
```

### Preguntas de control

6.1. Si alguien edita su token y cambia `reception` por `clinic_admin`, ¿qué pasa?
6.2. ¿Por qué los UUID de los usuarios están fijos en el realm?
6.3. ¿Para qué sirve el claim `aud`?

---

## Parte 7. Redis

### 7.1 Para qué está 🟡

RF7 (espacios disponibles de un profesional en una fecha) es la consulta más frecuente del sistema. El plan es el
patrón **cache-aside**: la API busca primero en Redis; si no está, la calcula en Postgres y guarda el resultado.
**Pendiente** (paso 6).

### 7.2 La configuración y por qué 🟡

| Opción | Por qué |
|---|---|
| `--save ""` y `--appendonly no` (sin disco) | El enunciado prohíbe usar Redis como almacén principal. Sin persistencia es evidente que no lo es: si se reinicia, la caché queda vacía y todo se vuelve a leer de Postgres. |
| `--maxmemory 64mb` y `allkeys-lru` | Una caché necesita un tope. Al llenarse, Redis desaloja lo menos usado recientemente (LRU) en vez de fallar. |
| `--requirepass` | Contraseña, aunque esté en una red privada. |
| Sin puerto publicado | Solo la app lo usa. |

### 7.3 I8: el problema de la invalidación (pendiente) 🔴

Una caché es una **copia**, y las copias pueden quedar viejas. I8 exige que la disponibilidad que responde la API
nunca contradiga la base. La idea: **cada operación que cambie la agenda de un profesional** (reservar, cancelar,
reprogramar, cambiar horario o bloqueos) **borra de Redis las entradas de esa agenda**, después del `COMMIT`. Los
detalles se decidirán en el paso 6, con una prueba automatizada que reserve y vuelva a consultar.

**E30. Redis por dentro.**

```bash
docker compose exec redis redis-cli CONFIG GET maxmemory-policy   # allkeys-lru
docker compose exec redis redis-cli DBSIZE                        # 0: todavía nadie lo usa
```

---

## Parte 8. La aplicación Node

Hoy es pequeña: 3 archivos en `app/src/` y un `Dockerfile`. El grueso del trabajo que falta está aquí.

### 8.1 Lo que existe 🟡

- **`app/Dockerfile`:**
  - copia primero `package.json` y `package-lock.json` y ejecuta `npm ci`: si las dependencias no cambian, Docker
    reutiliza esa capa y la reconstrucción es rápida;
  - `--omit=dev`: no instala herramientas de desarrollo en la imagen;
  - `USER node`: el proceso no corre como root.
- **`app/src/db.js`:** un *pool* de hasta 10 conexiones a Postgres. Los datos de conexión vienen de las variables
  estándar `PGHOST`, `PGUSER`, etc., que define el compose. El manejador de `error` evita que una conexión caída
  tumbe el proceso.
- **`app/src/app.js`:** Express 5 con:
  - `GET /health`, que hace `SELECT 1` y responde 200 o 503;
  - un 404 para rutas inexistentes;
  - un manejador de errores que nunca filtra detalles internos al cliente (500 "Error interno").

  Exporta la app **sin** abrir el puerto, para poder probarla con `supertest`.
- **`app/src/server.js`:** abre el puerto y hace un **apagado ordenado**: ante `SIGTERM` (lo que envía
  `docker compose stop`) deja de aceptar peticiones y cierra el pool antes de salir.

### 8.2 Lo que viene (paso 4) 🔴

1. **Middleware de autenticación:** validar el token con la librería `jose` (firma con JWKS, `iss`, `aud`, `exp`) y
   cargar el usuario desde `users`.
2. **Un ayudante de transacciones**, más o menos así:

   ```js
   // Idea, todavía no existe
   await client.query('BEGIN');
   await client.query(`SET LOCAL ROLE ${rolDeBase}`);   // mc_reception, etc. (de una lista fija, nunca del cliente)
   // … consultas parametrizadas: client.query('… WHERE clinic_id = $1', [usuario.clinicId])
   await client.query('COMMIT');
   ```

3. **Traducción de errores de la base a HTTP:**

   | Error de la base | Significado | HTTP |
   |---|---|---|
   | `23P01` | espacio ocupado (I1, I2) | 409 |
   | `MC001` | fuera de horario o en bloqueo | 409 o 422 |
   | `MC002`, `MC003`, `MC004`, `MC006` | regla de negocio | 409 o 422 |
   | `23503` | referencia inexistente o de otra clínica | 404 o 422 |
   | `23514` | `CHECK` violado | 422 |
   | `42501` | sin permiso en la base | 403 |
   | `40P01` | deadlock | reintentar o 409 |

   Los códigos exactos se decidirán y documentarán en el contrato de rutas del README.

4. **Consultas parametrizadas** siempre (`$1`, `$2`), nunca concatenando texto del usuario: así no hay inyección SQL.

---

## Parte 9. Documentación generada

- **`docs/diagramas.md`** ⚪: diagramas en Mermaid (GitHub los dibuja): arquitectura, ER general y ER por área.
- **`docs/diccionario-datos.md`** 🟡: lo genera `./db/tools/generar-diccionario.sh` a partir de la base en
  ejecución. Las descripciones son comentarios guardados en la propia base (`db/sql/05-comments.sql`); los tipos,
  llaves e índices se leen del catálogo de Postgres. Así el diccionario no puede quedar desactualizado respecto del
  esquema. Para cambiar una descripción, se edita `05-comments.sql`, se aplica y se regenera.

**E31. Las descripciones viven en la base** (como `mc_owner`):

```sql
\d+ appointments
```

---

## Parte 10. Estado de los requisitos

✔ = listo · ◐ = parcial · ✘ = pendiente

| RF | Qué | Base de datos | API |
|---|---|---|---|
| RF1 | Alta de clínica con su primer admin | ✔ tablas y permisos | ✘ |
| RF2 | Usuarios: alta, baja lógica, rol | ✔ `users`, `ck_users_platform_admin` | ✘ |
| RF3 | Catálogo de servicios | ✔ `services` | ✘ |
| RF4 | Profesionales y sus servicios | ✔ `professionals`, `services_per_professionals` | ✘ |
| RF5 | Horario semanal | ✔ `professional_schedules` con `EXCLUDE` | ✘ |
| RF6 | Bloqueos y conflictos | ✔ `blockades`; conflictos consultables (E25) | ✘ |
| RF7 | Espacios disponibles de un profesional | ◐ índices listos; falta el cálculo | ✘ (+ caché) |
| RF8 | Disponibilidad por servicio en un rango | ◐ índice listo | ✘ |
| RF9 | Reservar | ✔ `EXCLUDE` y triggers | ✘ |
| RF10 | Reprogramar | ✔ `rescheduled_from_id`; probado en el seed | ✘ |
| RF11 | Cancelar con motivo | ✔ `ck_appointments_cancellation` | ✘ |
| RF12 | Desenlace después del inicio | ✔ trigger (`MC003`) | ✘ |
| RF13 | Transiciones de estado | ✔ trigger (`MC002`) | ✘ |
| RF14 | Pacientes | ✔ `patients`, `patient_contacts` | ✘ |
| RF15 | Nota clínica del profesional que atendió | ◐ tabla y permisos; "el que atendió" lo filtra la API | ✘ |
| RF16 | Historial del paciente | ✔ índice | ✘ |
| RF17 | Autenticación y matriz de permisos | ✔ realm, roles, matriz | ✘ validar tokens |
| RF18 | Bitácora de accesos | ◐ tabla protegida; registrar cada acceso lo hace la API | ✘ |
| RF19 | Consultar la bitácora con filtros | ✔ índices | ✘ |
| RF20 | Agenda del día | ✔ índices; permiso propuesto | ✘ |
| RF21 | Conteo por estado | ✔ consulta (E23) | ✘ |

**Otros entregables:** pruebas automatizadas (unitarias, integración, carrera, fugas, una por invariante) ✘ ·
`EXPLAIN ANALYZE` de los índices ✘ · contrato de rutas en el README ✘ · reporte de pruebas ✘ · colección de
peticiones ✘ · video ✘ · `Uso_de_IA.md` actualizado ✘.

---

## Parte 11. Autoevaluación

Intenten responder sin mirar. Las respuestas están plegadas.

<details><summary><b>1.1</b> ¿Por qué no basta con que la API revise si el espacio está libre antes de reservar?</summary>

Porque entre la revisión y la inserción otra transacción puede reservar el mismo espacio: las dos leen "libre" y las
dos insertan. Solo el motor ve todas las transacciones a la vez; la restricción `EXCLUDE` hace que la segunda espere
y falle.
</details>

<details><summary><b>1.2</b> ¿Qué invariantes dependen todavía de código que no existe?</summary>

I8 completo (la caché) y una parte de I5: que el `clinic_id` salga del token y no de la petición. Las FKs
compuestas ya funcionan, pero no impiden que una consulta mal escrita *lea* datos de otra clínica.
</details>

<details><summary><b>2.1</b> ¿Por qué la app no arranca hasta que Keycloak está sano?</summary>

Por `depends_on` con `condition: service_healthy`. La app necesita las llaves públicas de Keycloak para validar
tokens; si arrancara antes, las primeras peticiones fallarían.
</details>

<details><summary><b>2.2</b> Cambiaron una línea de 01-schema.sql e hicieron docker compose restart. ¿Se aplicó?</summary>

No. Los scripts de inicialización solo corren con el volumen vacío. Hay que hacer `docker compose down -v` y
volver a levantar.
</details>

<details><summary><b>3.1</b> ¿Qué pasaría si mc_app tuviera INHERIT?</summary>

Tendría a la vez los permisos de los cuatro roles. Si el código olvidara el `SET ROLE`, la consulta se ejecutaría con
todos los permisos (por ejemplo, recepción podría leer notas clínicas). Con `NOINHERIT` falla cerrado.
</details>

<details><summary><b>3.2</b> ¿Por qué SET LOCAL ROLE y no SET ROLE?</summary>

Porque las conexiones del pool se reutilizan. `SET LOCAL` se deshace al terminar la transacción; un `SET ROLE`
quedaría pegado a la conexión y la siguiente petición, quizá de otro usuario, heredaría el rol.
</details>

<details><summary><b>3.3</b> Un profesional quiere ver los horarios de otro. ¿Lo impide la base?</summary>

No: todos los profesionales usan `mc_professional`, que puede leer horarios. Ver horarios de colegas es razonable,
pero *modificar* solo los propios (`schedules.manage_own`) lo debe filtrar la API comparando con el usuario del
token.
</details>

<details><summary><b>4.1</b> ¿Qué significa EXCLUDE USING gist (professional_id WITH =, period WITH &&)?</summary>

Que no pueden existir dos filas con el mismo profesional cuyos periodos se solapen. Usa un índice GiST porque los
rangos no se pueden indexar con un B-tree normal.
</details>

<details><summary><b>4.2</b> ¿Por qué el EXCLUDE tiene WHERE (appointment_status_id = 1)?</summary>

Para que solo las citas reservadas ocupen espacio. Sin él, una cita cancelada seguiría bloqueando su horario y se
rompería I7: cancelar no liberaría el espacio.
</details>

<details><summary><b>4.3</b> ¿Qué pasa, paso a paso, cuando dos recepcionistas reservan el mismo espacio a la vez?</summary>

La primera inserta y su fila entra al índice del `EXCLUDE`, sin confirmar. La segunda, al insertar, encuentra esa
fila en conflicto y espera. Si la primera confirma, la segunda falla con `23P01` (la API responderá 409). Si la
primera hace rollback, la segunda continúa y gana. Siempre gana exactamente una, con `READ COMMITTED`.
</details>

<details><summary><b>4.4</b> Un paciente tiene cita a las 9:00 con Laura y le reservan otra a las 9:00 con Andrés.</summary>

Falla con `23P01` en `ex_appointments_patient` (I2): el paciente no puede tener dos citas reservadas solapadas,
aunque sean con profesionales distintos.
</details>

<details><summary><b>4.5</b> ¿Por qué (clinic_id, patient_id) y no solo patient_id en la FK?</summary>

Porque `patient_id` solo garantiza que el paciente existe, no que sea de la misma clínica. La pareja garantiza las
dos cosas, así que un contacto de San José no puede apuntar a un paciente de Cartago (I5).
</details>

<details><summary><b>4.6</b> ¿Para qué sirve FOR SHARE en appointments_check_agenda?</summary>

Para que nadie borre o recorte el bloque de horario mientras la reserva no confirma. Sin él, una reserva y el
borrado de su bloque podrían confirmarse a la vez y dejar una cita fuera de horario (I3).
</details>

<details><summary><b>4.7</b> ¿Por qué dos capas para proteger la bitácora?</summary>

Los permisos impiden que la app la modifique. El trigger cubre el caso en que alguien conceda permisos por error, y
detiene incluso al dueño. Es defensa en profundidad: si una capa falla, la otra sigue.
</details>

<details><summary><b>4.8</b> Si user_id ya es la llave primaria, ¿para qué existe UNIQUE (clinic_id, user_id)?</summary>

No agrega ninguna regla: el par ya no se repite porque `user_id` no se repite. Existe porque una FK solo puede apuntar
a columnas con una PK o un `UNIQUE` declarado sobre exactamente esas columnas, y el motor no deduce que el par es
único. Es el trámite que permite las FKs `(clinic_id, …) → users (clinic_id, user_id)`, que son las que obligan a
que el usuario sea de la misma clínica (I5).
</details>

<details><summary><b>4.9</b> ¿Qué impide que Pablo entre en professionals escribiendo role_id = 3? ¿Y que se le cambie el rol a Laura?</summary>

Lo primero, el `CHECK (role_id = 4)`: el par `(4, 3)` sí existe en `users`, así que la FK sola lo dejaría pasar. Lo
segundo, la FK `(user_id, role_id)`: el par `(6, 4)` está referenciado desde `professionals` y el motor no deja que
desaparezca (acción `NO ACTION`).
</details>

<details><summary><b>5.1</b> ¿Por qué el seed no usa random()?</summary>

Para que sea determinista: todos obtienen los mismos datos, las pruebas son repetibles y "la cita X" sigue siendo la
misma cita en cada máquina.
</details>

<details><summary><b>5.2</b> ¿Por qué los datos pasan por los triggers en vez de insertarse a la fuerza?</summary>

Para que también cumplan las invariantes, garantizadas por el motor y no por el cuidado del script. Si el seed
tuviera un error, el motor lo habría rechazado.
</details>

<details><summary><b>6.1</b> Alguien edita su token y cambia reception por clinic_admin. ¿Qué pasa?</summary>

La firma deja de coincidir con el contenido. La API, al verificarla con la llave pública de Keycloak, rechazará el
token con 401. Para firmar un token válido haría falta la llave privada, que solo tiene Keycloak.
</details>

<details><summary><b>6.2</b> ¿Por qué los UUID de los usuarios están fijos en el realm?</summary>

Porque el `sub` del token es la llave que asocia la identidad con `users` (y de ahí con la clínica y el rol). Si
fueran aleatorios, cambiarían en cada `down -v` y la asociación se rompería.
</details>

<details><summary><b>6.3</b> ¿Para qué sirve el claim aud?</summary>

Dice para qué aplicación se emitió el token. La API rechazará tokens cuyo `aud` no sea `medicitas-api`, para que un
token emitido para otra aplicación del mismo Keycloak no sirva contra la nuestra.
</details>

**Preguntas abiertas para practicar la defensa** (no tienen una única respuesta correcta):

- ¿Qué ganaron y qué sacrificaron al elegir columna discriminadora en vez de un esquema por clínica?
- ¿Qué pasaría si Redis se cae? ¿Y si queda con datos viejos?
- ¿Qué cambiarían para producción? (HTTPS, flujo de login con navegador, secretos fuera del `.env`, RLS…)
- Si una clínica tuviera 100 profesionales y 1 000 citas diarias, ¿qué índice sería el más importante?

---

## Parte 12. Glosario

| Término | Significado |
|---|---|
| Tenant | Cada cliente que comparte la instalación; aquí, cada clínica |
| Multi-tenancy | Servir a varios tenants con una sola instalación, aislando sus datos |
| Columna discriminadora | Estrategia de multi-tenancy: tablas compartidas y una columna (`clinic_id`) que dice de quién es cada fila |
| Invariante | Regla que debe cumplirse siempre, en todo momento |
| Llave primaria (PK) | Columna cuyo valor identifica exactamente una fila; el motor no deja que se repita |
| Llave foránea (FK) | Columna cuyo valor tiene que existir en otra tabla; solo puede apuntar a una PK o a un `UNIQUE` |
| FK compuesta | Llave foránea de varias columnas: la combinación debe existir en la tabla destino |
| `UNIQUE` | Restricción que prohíbe valores (o combinaciones) repetidos; crea un índice |
| Índice | Estructura ordenada, como el índice de un libro, que permite encontrar filas sin leer toda la tabla |
| Tabla que apunta / tabla destino | La que tiene la FK / aquella a la que apunta. No hay herencia de columnas |
| `NO ACTION` / `ON UPDATE CASCADE` | Acción de una FK cuando cambia el destino: rechazar el cambio / arrastrarlo a las filas que apuntan |
| RLS (Row Level Security) | Reglas pegadas a una tabla que limitan qué filas ve o modifica cada sesión |
| `EXCLUDE` | Restricción que prohíbe pares de filas que cumplan una condición (por ejemplo, mismo profesional y periodos solapados) |
| GiST | Tipo de índice de Postgres que sabe manejar rangos y solapamientos |
| `btree_gist` | Extensión que permite usar `=` sobre tipos normales dentro de un índice GiST |
| `tstzrange` | Rango de instantes; `[a, b)` incluye `a` y excluye `b` |
| `&&` / `@>` | Operadores de rangos: "se solapan" / "contiene" |
| multirange, `range_agg` | Conjunto de rangos; `range_agg` une varios rangos en uno |
| `timestamptz` | Instante absoluto, independiente de la zona horaria |
| Trigger | Función que el motor ejecuta automáticamente ante un `INSERT`, `UPDATE`, `DELETE` o `TRUNCATE` |
| `NEW` / `OLD` | Dentro de un trigger: la fila nueva / la anterior |
| SQLSTATE | Código de error de 5 caracteres (`23P01`, `42501`, `MC001`) |
| `SECURITY DEFINER` | La función corre con los permisos de su dueño, no de quien la invoca |
| `search_path` | Lista de esquemas donde Postgres busca los nombres de tablas y funciones |
| `FOR SHARE` | Bloqueo de filas que impide modificarlas o borrarlas hasta que termine la transacción |
| Nivel de aislamiento | Qué ve una transacción de las demás; Postgres usa `READ COMMITTED` por defecto |
| Deadlock | Dos transacciones que se esperan mutuamente; Postgres aborta una (`40P01`) |
| Rol de base de datos | Usuario o grupo de permisos en Postgres |
| `NOINHERIT` / `SET ROLE` | No recibir automáticamente los permisos de los roles de los que se es miembro / convertirse en uno de ellos |
| Menor privilegio | Dar a cada componente solo los permisos que necesita |
| Defensa en profundidad | Varias capas de protección independientes |
| Append-only | Solo se agregan registros; nunca se modifican ni borran |
| Baja lógica | Marcar como inactivo en vez de borrar |
| `GENERATED ALWAYS AS IDENTITY` | Llave numérica que asigna el motor |
| `DEFERRABLE INITIALLY DEFERRED` | La FK se revisa al confirmar la transacción, no en cada sentencia |
| 3FN | Tercera forma normal: sin dependencias parciales ni transitivas |
| Desnormalización | Repetir un dato a propósito, por rendimiento o para poder imponer una restricción |
| IdP | Proveedor de identidad (Keycloak) |
| OIDC | OpenID Connect, protocolo de autenticación sobre OAuth 2 |
| JWT | Token firmado con cabecera, contenido (claims) y firma |
| Claim | Dato dentro del token (`sub`, `iss`, `aud`, `exp`, roles) |
| RS256 | Firma con llave privada y verificación con llave pública |
| JWKS | URL donde Keycloak publica sus llaves públicas |
| Realm | Espacio aislado de Keycloak con sus usuarios, roles y clients |
| Client | Aplicación registrada en Keycloak que puede pedir tokens |
| Cache-aside | Patrón: buscar en la caché; si no está, calcular y guardar |
| LRU | Least Recently Used: desalojar lo usado hace más tiempo |
| Invalidación | Borrar de la caché los datos que dejaron de ser ciertos |
| Healthcheck | Prueba periódica que dice si un contenedor está sano |
| Volumen | Almacenamiento de Docker que sobrevive a los contenedores; `down -v` lo borra |
| Pool de conexiones | Conjunto de conexiones a la base que se reutilizan entre peticiones |
| Determinista | Que con la misma entrada siempre produce la misma salida |

---

## Parte 13. Chuleta de comandos

```bash
# Ciclo de vida
docker compose up -d --build --wait          # levantar
docker compose ps                            # estado
docker compose logs -f app                   # logs de un servicio
docker compose down                          # apagar (conserva los datos)
docker compose down -v                       # apagar y borrar los datos (reinicio total)

# Consolas
docker compose exec db psql -U mc_app -d medicitas      # como la API
docker compose exec db psql -U mc_owner -d medicitas    # como el dueño
docker compose exec redis redis-cli                     # Redis

# API
curl -s localhost:3000/health

# Token (ver E27 para leerlo)
curl -s -X POST http://localhost:8080/realms/medicitas/protocol/openid-connect/token \
  -d grant_type=password -d client_id=medicitas-api \
  -d username=recepcion.sanjose -d password=medicitas

# Diccionario de datos
./db/tools/generar-diccionario.sh
```

---

## Plan de sesiones guiadas

| Sesión | Partes | Tema | Duración aproximada |
|---|---|---|---|
| 1 | 1 y 2 | El mapa y la arquitectura | 45 min |
| 2 | 3 | Roles de la base y permisos | 45 min |
| 3 | 4.1 a 4.5 | Esquema, multi-tenancy y agenda | 1 h 30 min |
| 4 | 4.6 | Citas y concurrencia: la pregunta rectora | 1 h |
| 5 | 4.7 a 4.10 | Triggers, bitácora, índices y normalización | 1 h |
| 6 | 5 y 6 | Datos de demostración, Keycloak y tokens | 45 min |
| 7 | 7, 8 y 11 | Redis, la app y autoevaluación completa | 45 min |

En cada sesión: leer la parte, ejecutar los experimentos prediciendo el resultado, responder las preguntas de
control y anotar dudas.
