# Diccionario de datos de MediCitas

> **Archivo generado, no se edita a mano.** Lo escribe `db/tools/generar-diccionario.sh` leyendo la base en
> ejecución. Los tipos, nulos, llaves, restricciones, índices y triggers salen del catálogo de PostgreSQL, y las
> descripciones son comentarios guardados en la propia base (`db/sql/05-comments.sql`). Así el documento no puede
> quedar desalineado con el esquema real (`db/sql/01-schema.sql`). Para cambiar una descripción se edita
> `05-comments.sql` y se vuelve a generar.

## Cómo leer este documento

- **Nombres.** Están en snake_case, tal como existen en la base. El modelo del README usa camelCase
  (`clinicId` → `clinic_id`).
- **Columnas de cada tabla.**
  - *Nulo*: `sí` si la columna admite NULL.
  - *Por omisión*: valor que pone el motor si el `INSERT` no lo trae. `identidad` significa
    `GENERATED ALWAYS AS IDENTITY`: lo asigna el motor y la aplicación no lo puede escribir.
  - *Llave*: `PK` llave primaria, `FK` forma parte de una llave foránea, `UK` es única por sí sola. Las llaves y
    restricciones de varias columnas se listan debajo de cada tabla.
- **Tenant.** El tenant es la clínica. Las tablas con datos de una clínica llevan `clinic_id`, y sus FKs hacia
  otras tablas de clínica son compuestas, `(clinic_id, id)`: así el motor rechaza cualquier relación entre
  registros de clínicas distintas (I5). Los catálogos globales no llevan `clinic_id`.
- **Instantes e intervalos.** Todo instante es `timestamptz` (un momento absoluto; la hora local se obtiene con
  `clinics.time_zone`). Todo intervalo es `tstzrange` de la forma `[inicio, fin)`: incluye el inicio y excluye el
  fin, de modo que dos citas seguidas (09:00–09:30 y 09:30–10:00) no se solapan.
- **Columnas de control.** `is_active` (baja lógica), `created_at`, `updated_at` y `updated_by` aparecen en casi
  todas las tablas. El trigger `trg_set_updated_at`, que mantiene `updated_at`, está en todas ellas y no se repite
  abajo. La FK de `updated_by` hacia `users` es `DEFERRABLE INITIALLY DEFERRED` porque `users` y `roles` se
  referencian mutuamente y se revisa al confirmar la transacción.
- **Datos sensibles.** `patient_contacts` y `clinical_notes`: toda lectura y escritura se registra en `audit_logs`
  (RF18).
- **Errores propios.** Los triggers lanzan estos códigos SQLSTATE, que la API traduce a respuestas HTTP:

| Código | Significado | Regla |
|---|---|---|
| `MC001` | La cita cae fuera del horario del profesional o dentro de un bloqueo | I3 |
| `MC002` | Transición de estado no permitida | RF13 |
| `MC003` | Desenlace registrado antes de la hora de inicio | RF12 |
| `MC004` | Intento de mover una cita o cambiarle el servicio | I4 |
| `MC005` | Intento de modificar o borrar la bitácora | I6 |
| `MC006` | El bloque de horario tiene citas reservadas | I3 |

## Tablas por área

| Área | Tablas |
|---|---|
| Clínicas, usuarios y permisos | [clinics](#clinics), [users](#users), [roles](#roles), [professionals](#professionals), [permissions](#permissions), [permissions_per_roles](#permissions_per_roles) |
| Geografía | [countries](#countries), [states](#states), [cities](#cities), [addresses](#addresses), [clinics_addresses](#clinics_addresses) |
| Especialidades y servicios | [specialties](#specialties), [specialties_per_professionals](#specialties_per_professionals), [services](#services), [services_per_professionals](#services_per_professionals) |
| Agenda | [professional_schedules](#professional_schedules), [blockades](#blockades), [professional_contacts](#professional_contacts) |
| Pacientes | [genders](#genders), [patients](#patients), [contact_types](#contact_types), [patient_contacts](#patient_contacts) |
| Citas y notas clínicas | [appointment_statuses](#appointment_statuses), [appointments](#appointments), [clinical_notes](#clinical_notes) |
| Bitácoras | [event_types](#event_types), [data_objects](#data_objects), [audit_logs](#audit_logs), [severities](#severities), [system_errors_logs](#system_errors_logs) |

## Clínicas, usuarios y permisos

### clinics

Clínicas cliente de la plataforma (RF1). Cada clínica es un tenant: su clinic_id aparece en todas las tablas de datos de la clínica.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `clinic_id` | integer | no | identidad | PK | Identificador interno de la clínica. |
| `clinic_code` | varchar(30) | no |  | UK | Identificador de negocio de la clínica (RF1), único en la plataforma. Ej. CR-SJ-001. |
| `clinic_name` | varchar(75) | no |  |  | Nombre comercial de la clínica. |
| `time_zone` | varchar(64) | no |  |  | Zona horaria IANA (ej. America/Costa_Rica). Convierte las horas locales de la clínica en instantes absolutos; el backend la valida contra pg_timezone_names. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### users

Usuarios del personal (RF2). Las credenciales viven en Keycloak: aquí solo se guarda el sub del token, la clínica y el rol. Tenant: clinic_id, NULL solo para el administrador de plataforma.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `user_id` | integer | no | identidad | PK | Identificador interno del usuario. El 1 es el usuario Sistema, autor de los datos iniciales, que no puede iniciar sesión. |
| `keycloak_sub` | uuid | no |  | UK | Claim sub del token de Keycloak. Es la llave con que el backend asocia cada identidad con su clínica y su rol. |
| `clinic_id` | integer | sí |  | FK → clinics | Clínica a la que pertenece el usuario. NULL si y solo si es administrador de plataforma. |
| `role_id` | smallint | no |  | FK → roles | Rol del usuario dentro de su clínica. |
| `name` | varchar(50) | no |  |  | Nombre o nombres. |
| `last_name` | varchar(50) | no |  |  | Apellidos. |
| `is_active` | boolean | no | `true` |  | Baja lógica (RF2): un usuario inactivo no opera aunque Keycloak le emita un token. No se borra porque citas, notas y bitácora lo referencian. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `uq_users_clinic_user` (UNIQUE): `UNIQUE (clinic_id, user_id)` — Destino de las FKs compuestas (clinic_id, user_id) que obligan a que el usuario sea de la misma clínica (I5).
- `uq_users_user_role` (UNIQUE): `UNIQUE (user_id, role_id)` — Destino de la FK de professionals que verifica el rol.
- `ck_users_platform_admin` (CHECK): `CHECK (((role_id = 1) = (clinic_id IS NULL)))` — El administrador de plataforma, y solo él, no pertenece a ninguna clínica (RF2).

### roles

Roles de la aplicación, con ids fijos porque los CHECK y el backend los usan como constantes. Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `role_id` | smallint | no |  | PK | Id fijo del rol: 1 platform_admin, 2 clinic_admin, 3 reception, 4 professional. |
| `role_name` | varchar(50) | no |  | UK | Nombre técnico; es el mismo rol de realm que viaja en el token de Keycloak. |
| `description` | varchar(150) | sí |  |  | Nombre legible del rol. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### professionals

Datos de los usuarios con rol professional (RF4): especialización 1:1 de users. No lleva clinic_id; la clínica se toma de users.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `user_id` | integer | no |  | PK, FK compuesta | Usuario que es profesional. En las demás tablas esta misma llave se llama professional_id. |
| `role_id` | smallint | no | `4` | FK compuesta | Siempre 4. Existe solo para la FK (user_id, role_id) que garantiza que el usuario tiene rol professional. |
| `license_number` | varchar(30) | no |  |  | Número de colegiado o código profesional. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `fk_professionals_user_role` (FK): `FOREIGN KEY (user_id, role_id) REFERENCES users(user_id, role_id)` — Solo un usuario con rol professional puede estar aquí. Mientras lo sea, tampoco se le puede cambiar el rol en users: el par (user_id, 4) sigue referenciado.
- `ck_professionals_role` (CHECK): `CHECK ((role_id = 4))` — role_id siempre vale 4 (professional).

### permissions

Permisos del dominio (RF17). El backend traduce el rol del token a estos permisos. Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `permission_id` | integer | no | identidad | PK | Identificador del permiso. |
| `permission_name` | varchar(50) | no |  | UK | Nombre técnico que usa el código, con forma recurso.acción. El sufijo _own indica que además se filtra por el usuario del token. |
| `description` | varchar(200) | sí |  |  | Qué permite y a qué requisito funcional corresponde. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### permissions_per_roles

Matriz de permisos: qué permisos tiene cada rol (RF17). Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `permission_per_role_id` | integer | no | identidad | PK | Identificador de la asignación. |
| `role_id` | smallint | no |  | FK → roles | Rol que recibe el permiso. |
| `permission_id` | integer | no |  | FK → permissions | Permiso otorgado. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `permissions_per_roles_role_id_permission_id_key` (UNIQUE): `UNIQUE (role_id, permission_id)`

## Geografía

### countries

Países de las direcciones de las clínicas. Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `country_id` | integer | no | identidad | PK | Identificador del país. |
| `iso_code` | char(3) | no |  | UK | Código ISO 3166-1 alfa-3 (ej. CRI, COL). |
| `country_name` | varchar(50) | no |  |  | Nombre del país. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### states

Primera división administrativa de un país (provincia, departamento, estado). Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `state_id` | integer | no | identidad | PK | Identificador de la provincia o estado. |
| `country_id` | integer | no |  | FK → countries | País al que pertenece. |
| `state_name` | varchar(40) | no |  |  | Nombre de la provincia o estado. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### cities

Ciudades o cantones. Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `city_id` | integer | no | identidad | PK | Identificador de la ciudad. |
| `state_id` | integer | no |  | FK → states | Provincia o estado al que pertenece. |
| `city_name` | varchar(50) | no |  |  | Nombre de la ciudad. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### addresses

Direcciones físicas.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `address_id` | integer | no | identidad | PK | Identificador de la dirección. |
| `city_id` | integer | no |  | FK → cities | Ciudad de la dirección. |
| `address` | varchar(100) | no |  |  | Señas o línea de dirección. |
| `zip_code` | varchar(20) | sí |  |  | Código postal; NULL donde no se usa. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### clinics_addresses

Direcciones de cada clínica. Es una tabla aparte porque una clínica puede tener varias sedes o cambiar de dirección sin perder el historial.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `clinic_address_id` | integer | no | identidad | PK | Identificador de la asociación. |
| `clinic_id` | integer | no |  | FK → clinics | Clínica. |
| `address_id` | integer | no |  | FK → addresses | Dirección de la clínica. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

## Especialidades y servicios

### specialties

Especialidades médicas (ej. Medicina General, Pediatría). Catálogo global compartido por todas las clínicas.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `specialty_id` | integer | no | identidad | PK | Identificador de la especialidad. |
| `specialty_name` | varchar(50) | no |  | UK | Nombre de la especialidad. |

### specialties_per_professionals

Especialidades de cada profesional (RF4). Sin clinic_id: la especialidad es global y la fila solo se alcanza a través del profesional, que sí es de una clínica.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `specialty_per_professional_id` | integer | no | identidad | PK | Identificador de la asociación. |
| `professional_id` | integer | no |  | FK → professionals | Profesional. |
| `specialty_id` | integer | no |  | FK → specialties | Especialidad que tiene el profesional. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `specialties_per_professionals_professional_id_specialty_id_key` (UNIQUE): `UNIQUE (professional_id, specialty_id)`

### services

Catálogo de servicios de la clínica (RF3). La duración del servicio decide el tamaño de la cita (I4). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `service_id` | integer | no | identidad | PK | Identificador del servicio. |
| `clinic_id` | integer | no |  | FK → clinics | Clínica dueña del servicio. |
| `service_name` | varchar(63) | no |  |  | Nombre del servicio (ej. Consulta general). |
| `duration_minutes` | integer | no |  |  | Duración en minutos, mayor que 0. Con este valor el trigger de citas calcula el fin de cada cita (I4). |
| `specialty_id` | integer | no |  | FK → specialties | Especialidad que se requiere para atender el servicio. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `uq_services_clinic_service` (UNIQUE): `UNIQUE (clinic_id, service_id)` — Destino de las FKs compuestas (clinic_id, service_id) que obligan a que el servicio sea de la misma clínica (I5).
- `services_duration_minutes_check` (CHECK): `CHECK ((duration_minutes > 0))` — La duración es positiva.

### services_per_professionals

Servicios que cada profesional está habilitado para atender (RF4). Una cita solo puede reservar una combinación que esté aquí. Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `service_per_professional_id` | integer | no | identidad | PK | Identificador de la asociación. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica. La comparten las FKs al profesional y al servicio, así que ambos son de la misma clínica (I5). |
| `professional_id` | integer | no |  | FK → professionals, FK compuesta | Profesional habilitado. |
| `service_id` | integer | no |  | FK compuesta | Servicio que puede atender. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `services_per_professionals_clinic_id_professional_id_fkey` (FK): `FOREIGN KEY (clinic_id, professional_id) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `services_per_professionals_clinic_id_service_id_fkey` (FK): `FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, service_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `uq_spp_clinic_prof_service` (UNIQUE): `UNIQUE (clinic_id, professional_id, service_id)` — No se asocia dos veces el mismo servicio al mismo profesional. Es el destino de la FK desde appointments.

**Índices adicionales**

- `ix_spp_clinic_service`: `btree (clinic_id, service_id)` — RF8: profesionales que atienden un servicio.

## Agenda

### professional_schedules

Bloques concretos de atención de cada profesional (RF5); puede haber varios por día, por ejemplo mañana y tarde. Se definen en la hora local de la clínica y se guardan como instantes absolutos. Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `schedule_id` | integer | no | identidad | PK | Identificador del bloque. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica del profesional. |
| `professional_id` | integer | no |  | FK → professionals, FK compuesta | Profesional que atiende en el bloque. |
| `period` | tstzrange | no |  |  | Intervalo [inicio, fin) del bloque de atención. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `professional_schedules_clinic_id_professional_id_fkey` (FK): `FOREIGN KEY (clinic_id, professional_id) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `ck_schedules_period` (CHECK): `CHECK (((NOT isempty(period)) AND lower_inc(period) AND (NOT upper_inc(period)) AND (NOT lower_inf(period)) AND (NOT upper_inf(period))))` — El intervalo es finito, no vacío y de la forma [inicio, fin).
- `ex_schedules_overlap` (EXCLUDE): `EXCLUDE USING gist (professional_id WITH =, period WITH &&)` — Un profesional no tiene dos bloques de horario solapados.

**Triggers**

- `trg_professional_schedules_guard` (BEFORE DELETE OR UPDATE, por fila) → `professional_schedules_guard()` — I3: no se borra ni se recorta un bloque de horario que deje fuera citas reservadas (MC006).

### blockades

Bloqueos de agenda por vacaciones, permisos u otras ausencias (RF6). Retiran disponibilidad, pero no cancelan citas: las reservadas que caen dentro se listan como conflicto. Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `blockade_id` | integer | no | identidad | PK | Identificador del bloqueo. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica del profesional. |
| `professional_id` | integer | no |  | FK → professionals, FK compuesta | Profesional ausente. |
| `period` | tstzrange | no |  |  | Intervalo [inicio, fin) de la ausencia. Puede solaparse con otros bloqueos. |
| `reason` | text | sí |  |  | Motivo de la ausencia (ej. Vacaciones); opcional. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `blockades_clinic_id_professional_id_fkey` (FK): `FOREIGN KEY (clinic_id, professional_id) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `ck_blockades_period` (CHECK): `CHECK (((NOT isempty(period)) AND lower_inc(period) AND (NOT upper_inc(period)) AND (NOT lower_inf(period)) AND (NOT upper_inf(period))))` — El intervalo es finito, no vacío y de la forma [inicio, fin).

**Índices adicionales**

- `ix_blockades_prof_period`: `gist (professional_id, period)` — RF6 (citas en conflicto con un bloqueo) y RF7 (restar bloqueos a la disponibilidad).

### professional_contacts

Datos de contacto de los profesionales, para que recepción pueda ubicarlos. Separada de patient_contacts porque estos datos no van a la bitácora (RF18 solo aplica a pacientes). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `contact_id` | integer | no | identidad | PK | Identificador del contacto. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica del profesional. |
| `professional_id` | integer | no |  | FK → professionals, FK compuesta | Profesional. |
| `contact_type_id` | integer | no |  | FK → contact_types | Tipo de contacto (teléfono o correo). |
| `contact_value` | varchar(320) | no |  |  | Número de teléfono o dirección de correo. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `professional_contacts_clinic_id_professional_id_fkey` (FK): `FOREIGN KEY (clinic_id, professional_id) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `professional_contacts_professional_id_contact_type_id_conta_key` (UNIQUE): `UNIQUE (professional_id, contact_type_id, contact_value)`

## Pacientes

### genders

Géneros que puede indicar un paciente. Ids fijos.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `gender_id` | smallint | no |  | PK | Id fijo del género. |
| `gender_name` | varchar(30) | no |  | UK | Nombre del género. |

### patients

Pacientes de la clínica (RF14). No son usuarios del sistema ni tienen credenciales. Una misma persona atendida en dos clínicas son dos filas independientes, una por clínica (I5). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `patient_id` | integer | no | identidad | PK | Identificador del paciente. |
| `clinic_id` | integer | no |  | FK → clinics | Clínica que registró al paciente. |
| `identification` | varchar(30) | no |  |  | Número de identificación (cédula, pasaporte); único dentro de la clínica. |
| `name` | varchar(50) | no |  |  | Nombre o nombres. |
| `last_name` | varchar(50) | no |  |  | Apellidos. |
| `birth_date` | date | no |  |  | Fecha de nacimiento. |
| `gender_id` | smallint | sí |  | FK → genders | Género; NULL si el paciente no lo indica. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `uq_patients_clinic_identification` (UNIQUE): `UNIQUE (clinic_id, identification)` — Una identificación no se repite dentro de la clínica; en otra clínica sí puede existir.
- `uq_patients_clinic_patient` (UNIQUE): `UNIQUE (clinic_id, patient_id)` — Destino de las FKs compuestas (clinic_id, patient_id) que obligan a que el paciente sea de la misma clínica (I5).

### contact_types

Tipos de dato de contacto. Catálogo global.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `contact_type_id` | integer | no | identidad | PK | Identificador del tipo de contacto. |
| `contact_type_name` | varchar(50) | no |  | UK | Nombre del tipo de contacto. |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

### patient_contacts

Datos de contacto de los pacientes (RF14). Dato sensible: toda lectura y escritura se registra en audit_logs (RF18). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `contact_id` | integer | no | identidad | PK | Identificador del contacto. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica del paciente. |
| `patient_id` | integer | no |  | FK compuesta | Paciente. |
| `contact_type_id` | integer | no |  | FK → contact_types | Tipo de contacto (teléfono o correo). |
| `contact_value` | varchar(320) | no |  |  | Número de teléfono o dirección de correo. Hasta 320 caracteres, el máximo de un correo (RFC 5321). |
| `is_active` | boolean | no | `true` |  | Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `patient_contacts_clinic_id_patient_id_fkey` (FK): `FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, patient_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).

**Índices adicionales**

- `ix_patient_contacts_patient`: `btree (patient_id)` — RF14 y RF18: contactos de un paciente.

## Citas y notas clínicas

### appointment_statuses

Estados de una cita (RF13), con ids fijos porque los triggers y los CHECK los usan como constantes.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `appointment_status_id` | smallint | no |  | PK | Id fijo del estado: 1 reservada, 2 atendida, 3 ausente, 4 cancelada, 5 reprogramada. |
| `status_name` | varchar(12) | no |  | UK | Nombre del estado. |
| `is_final` | boolean | no |  |  | true si el estado no admite salida; lo son todos menos reservada. |

### appointments

Citas (RF9 a RF13). Solo las reservadas ocupan espacio en la agenda. Una cita no se mueve: reprogramar crea una cita nueva y deja esta como reprogramada (RF10). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `appointment_id` | bigint | no | identidad | PK | Identificador de la cita. BIGINT porque es la tabla de mayor volumen. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica de la cita. La comparten todas las FKs compuestas, así que paciente, profesional, servicio y cancelador son de esta clínica (I5). |
| `patient_id` | integer | no |  | FK compuesta | Paciente. |
| `professional_id` | integer | no |  | FK → professionals, FK compuesta | Profesional que atiende. |
| `service_id` | integer | no |  | FK compuesta | Servicio reservado; su duración define la de la cita (I4). |
| `appointment_status_id` | smallint | no | `1` | FK → appointment_statuses | Estado actual; toda cita nace reservada (1). Las transiciones las controla trg_appointments_30_check_status. |
| `period` | tstzrange | no |  |  | Intervalo [inicio, fin). La API envía solo el inicio y el trigger trg_appointments_10_set_period calcula el fin con la duración del servicio (I4). |
| `appointment_description` | text | sí |  |  | Motivo de la consulta; opcional. |
| `cancel_reason` | text | sí |  |  | Motivo de la cancelación (RF11). Presente si y solo si la cita está cancelada. |
| `cancelled_by` | integer | sí |  | FK compuesta | Usuario que canceló (RF11), de la misma clínica. Presente si y solo si la cita está cancelada. |
| `cancelled_at` | timestamptz | sí |  |  | Instante de la cancelación (RF11). Presente si y solo si la cita está cancelada. |
| `rescheduled_from_id` | bigint | sí |  | FK compuesta, UK | En una cita creada al reprogramar, la cita original que reemplaza (RF10). |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `appointments_clinic_id_cancelled_by_fkey` (FK): `FOREIGN KEY (clinic_id, cancelled_by) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `appointments_clinic_id_patient_id_fkey` (FK): `FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, patient_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `appointments_clinic_id_professional_id_fkey` (FK): `FOREIGN KEY (clinic_id, professional_id) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `appointments_clinic_id_professional_id_service_id_fkey` (FK): `FOREIGN KEY (clinic_id, professional_id, service_id) REFERENCES services_per_professionals(clinic_id, professional_id, service_id)` — Solo se reserva un servicio que el profesional tiene habilitado (RF4), en la misma clínica.
- `appointments_clinic_id_rescheduled_from_id_fkey` (FK): `FOREIGN KEY (clinic_id, rescheduled_from_id) REFERENCES appointments(clinic_id, appointment_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `appointments_clinic_id_service_id_fkey` (FK): `FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, service_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `uq_appointments_clinic_appointment` (UNIQUE): `UNIQUE (clinic_id, appointment_id)` — Destino de las FKs compuestas (clinic_id, appointment_id) que obligan a que la cita sea de la misma clínica (I5).
- `uq_appointments_rescheduled_from` (UNIQUE): `UNIQUE (rescheduled_from_id)` — Una cita se reprograma una sola vez (RF10).
- `ck_appointments_cancellation` (CHECK): `CHECK ( CASE WHEN (appointment_status_id = 4) THEN (num_nonnulls(cancel_reason, cancelled_by, cancelled_at) = 3) ELSE (num_nonnulls(cancel_reason, cancelled_by, cancelled_at) = 0) END)` — Cancelada si y solo si están los tres datos de la cancelación (RF11); en cualquier otro estado los tres van vacíos.
- `ck_appointments_period` (CHECK): `CHECK (((NOT isempty(period)) AND lower_inc(period) AND (NOT upper_inc(period)) AND (NOT lower_inf(period)) AND (NOT upper_inf(period))))` — El intervalo es finito, no vacío y de la forma [inicio, fin).
- `ex_appointments_patient` (EXCLUDE): `EXCLUDE USING gist (patient_id WITH =, period WITH &&) WHERE ((appointment_status_id = 1))` — I2: un paciente no tiene dos citas reservadas solapadas.
- `ex_appointments_professional` (EXCLUDE): `EXCLUDE USING gist (professional_id WITH =, period WITH &&) WHERE ((appointment_status_id = 1))` — I1: un profesional no tiene dos citas reservadas solapadas. El motor lo garantiza también entre transacciones concurrentes.

**Índices adicionales**

- `ix_appointments_clinic_start`: `btree (clinic_id, lower(period))` — RF20 (agenda del día de la clínica) y RF21 (conteo por estado en un rango de fechas).
- `ix_appointments_patient_start`: `btree (patient_id, lower(period))` — RF16: historial de citas de un paciente.
- `ix_appointments_prof_start`: `btree (professional_id, lower(period))` — RF20: agenda del día de un profesional, en todos los estados.

**Triggers**

- `trg_appointments_10_set_period` (BEFORE INSERT OR UPDATE, por fila) → `appointments_set_period()` — I4: al insertar, calcula el fin de la cita con la duración del servicio. Al actualizar, impide mover la cita o cambiarle servicio, profesional, paciente o clínica (MC004).
- `trg_appointments_20_check_agenda` (BEFORE INSERT, por fila) → `appointments_check_agenda()` — I3: la cita cae dentro del horario del profesional y fuera de sus bloqueos (MC001). Bloquea FOR SHARE los bloques de horario usados hasta el commit.
- `trg_appointments_30_check_status` (BEFORE INSERT OR UPDATE, por fila) → `appointments_check_status()` — RF13: toda cita nace reservada y los estados finales no admiten cambios (MC002). RF12: atendida o ausente solo después del inicio (MC003).

### clinical_notes

Notas clínicas (RF15), el dato más sensible del sistema. Una por cita atendida, escrita por el profesional de esa cita; el autor no se repite aquí porque ya es appointments.professional_id. Toda lectura y escritura se registra en audit_logs (RF18). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `clinical_note_id` | bigint | no | identidad | PK | Identificador de la nota. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica de la cita. |
| `appointment_id` | bigint | no |  | FK compuesta, UK | Cita que documenta; única porque hay una nota por cita. |
| `note_text` | text | no |  |  | Contenido clínico de la nota. |
| `created_at` | timestamptz | no | `now()` |  | Instante de creación del registro. |
| `updated_at` | timestamptz | no | `now()` |  | Instante de la última modificación; lo mantiene el trigger trg_set_updated_at. |
| `updated_by` | integer | no |  | FK → users | Usuario que hizo la última modificación (1 = Sistema en los datos iniciales). |

**Restricciones**

- `clinical_notes_clinic_id_appointment_id_fkey` (FK): `FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointments(clinic_id, appointment_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).

## Bitácoras

### event_types

Acciones que registra la bitácora de auditoría. Ids fijos.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `event_type_id` | smallint | no |  | PK | Id fijo de la acción. |
| `name` | varchar(50) | no |  | UK | Nombre técnico de la acción. |
| `description` | varchar(150) | no |  |  | Descripción legible. |

### data_objects

Tipos de dato sensible que vigila la bitácora de auditoría (RF18). Ids fijos.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `data_object_id` | smallint | no |  | PK | Id fijo del tipo de dato. |
| `name` | varchar(50) | no |  | UK | Nombre técnico del tipo de dato. |
| `description` | varchar(100) | no |  |  | Descripción legible. |

### audit_logs

Bitácora de auditoría append-only (RF18, RF19): quién leyó o escribió qué dato sensible, de cuál paciente y cuándo. Ningún rol tiene UPDATE, DELETE ni TRUNCATE, y los triggers los rechazan aunque alguien los conceda (I6). Tenant: clinic_id.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `log_id` | bigint | no | identidad | PK | Identificador del registro. |
| `clinic_id` | integer | no |  | FK compuesta | Clínica donde ocurrió el acceso. |
| `user_id` | integer | no |  | FK compuesta | Quién: usuario que hizo el acceso. |
| `event_type_id` | smallint | no |  | FK → event_types | Qué hizo: lectura, creación, modificación o baja. |
| `data_object_id` | smallint | no |  | FK → data_objects | Sobre qué tipo de dato: nota clínica o contacto del paciente. |
| `object_id` | bigint | no |  |  | Id del registro tocado. Sin FK porque apunta a una tabla distinta según data_object_id. |
| `patient_id` | integer | no |  | FK compuesta | Sobre cuál paciente. |
| `description` | varchar(255) | no |  |  | Resumen legible del evento. |
| `metadata` | jsonb | sí |  |  | Detalles adicionales del acceso (ej. ruta o id de la petición); opcional. |
| `created_at` | timestamptz | no | `now()` |  | Cuándo ocurrió el acceso. |

**Restricciones**

- `audit_logs_clinic_id_patient_id_fkey` (FK): `FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, patient_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).
- `audit_logs_clinic_id_user_id_fkey` (FK): `FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, user_id)` — Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).

**Índices adicionales**

- `ix_audit_clinic_date`: `btree (clinic_id, created_at)` — RF19: bitácora filtrada solo por fechas.
- `ix_audit_clinic_patient_date`: `btree (clinic_id, patient_id, created_at)` — RF19: bitácora filtrada por paciente y fechas.
- `ix_audit_clinic_user_date`: `btree (clinic_id, user_id, created_at)` — RF19: bitácora filtrada por usuario y fechas.

**Triggers**

- `trg_audit_logs_append_only` (BEFORE DELETE OR UPDATE, por fila) → `audit_logs_append_only()` — I6: rechaza UPDATE y DELETE (MC005).
- `trg_audit_logs_no_truncate` (BEFORE TRUNCATE, por sentencia) → `audit_logs_append_only()` — I6: rechaza TRUNCATE (MC005).

### severities

Niveles de gravedad de system_errors_logs. Ids fijos.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `severity_id` | smallint | no |  | PK | Id fijo de la gravedad. |
| `name` | varchar(50) | no |  | UK | Nombre técnico de la gravedad. |
| `description` | varchar(100) | no |  |  | Descripción legible. |

### system_errors_logs

Registro técnico de errores de la aplicación, para diagnóstico. No guarda datos de negocio ni pertenece a una clínica.

| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |
|---|---|---|---|---|---|
| `error_id` | bigint | no | identidad | PK | Identificador del error. |
| `severity_id` | smallint | no |  | FK → severities | Gravedad. |
| `process_uuid` | uuid | sí |  |  | Id de correlación de la petición o proceso; opcional. |
| `process_name` | varchar(100) | no |  |  | Proceso o ruta donde ocurrió (ej. POST /appointments). |
| `step_name` | varchar(100) | sí |  |  | Paso dentro del proceso; opcional. |
| `input_data` | jsonb | sí |  |  | Entrada que causó el error, sin datos sensibles; opcional. |
| `error_message` | text | no |  |  | Mensaje del error. |
| `metadata` | jsonb | sí |  |  | Detalles técnicos (ej. SQLSTATE); opcional. |
| `created_at` | timestamptz | no | `now()` |  | Cuándo ocurrió el error. |

## Valores de los catálogos fijos

Estos valores los inserta `db/sql/03-catalogs.sql` y forman parte del esquema: el código, los `CHECK` y los
triggers los usan por id o por nombre. Los datos de demostración (clínicas, especialidades, servicios, pacientes,
citas) están en `db/sql/04-seed.sql` y no se listan aquí.

### Valores de roles

| role_id | role_name | Descripción |
|---|---|---|
| 1 | `platform_admin` | Administrador de plataforma |
| 2 | `clinic_admin` | Administrador de clínica |
| 3 | `reception` | Recepción |
| 4 | `professional` | Profesional de salud |

### Valores de appointment_statuses

| appointment_status_id | status_name | is_final |
|---|---|---|
| 1 | `reservada` | no |
| 2 | `atendida` | sí |
| 3 | `ausente` | sí |
| 4 | `cancelada` | sí |
| 5 | `reprogramada` | sí |

### Valores de genders

| gender_id | gender_name |
|---|---|
| 1 | `femenino` |
| 2 | `masculino` |
| 3 | `otro` |
| 4 | `prefiere no decir` |

### Valores de contact_types

| contact_type_id | contact_type_name |
|---|---|
| 1 | `telefono` |
| 2 | `email` |

### Valores de event_types

| event_type_id | name | Descripción |
|---|---|---|
| 1 | `read` | Lectura del dato |
| 2 | `create` | Creación del dato |
| 3 | `update` | Modificación del dato |
| 4 | `delete` | Baja lógica del dato |

### Valores de data_objects

| data_object_id | name | Descripción |
|---|---|---|
| 1 | `clinical_note` | Nota clínica de una cita |
| 2 | `patient_contact` | Dato de contacto de un paciente |

### Valores de severities

| severity_id | name | Descripción |
|---|---|---|
| 1 | `info` | Evento informativo |
| 2 | `warning` | Situación anómala que no interrumpe la operación |
| 3 | `error` | Falla de una operación |
| 4 | `critical` | Falla que compromete el servicio |

### Matriz de permisos (permissions y permissions_per_roles, RF17)

| Permiso | Descripción | platform_admin | clinic_admin | reception | professional |
|---|---|:-:|:-:|:-:|:-:|
| `clinics.create` | Dar de alta clínicas (RF1) | ✓ |  |  |  |
| `users.manage` | Gestionar los usuarios de la clínica (RF2) |  | ✓ |  |  |
| `services.manage` | Mantener el catálogo de servicios (RF3) |  | ✓ |  |  |
| `professionals.manage` | Registrar profesionales y asociarles servicios (RF4) |  | ✓ |  |  |
| `schedules.manage` | Horarios y bloqueos de cualquier profesional de la clínica (RF5, RF6) |  | ✓ |  |  |
| `schedules.manage_own` | Horarios y bloqueos propios (RF5, RF6) |  |  |  | ✓ |
| `availability.read` | Consultar disponibilidad (RF7, RF8) |  | ✓ | ✓ | ✓ |
| `appointments.manage` | Reservar, reprogramar y cancelar citas (RF9 a RF11) |  | ✓ | ✓ |  |
| `appointments.outcome` | Registrar el desenlace de una cita (RF12) |  | ✓ | ✓ | ✓ |
| `patients.write` | Registrar y actualizar pacientes (RF14) |  | ✓ | ✓ |  |
| `patients.read` | Consultar pacientes (RF14) |  | ✓ | ✓ | ✓ |
| `clinical_notes.write_own` | Redactar la nota clínica de las citas propias (RF15) |  |  |  | ✓ |
| `patient_history.read` | Consultar el historial de citas de un paciente (RF16) |  | ✓ | ✓ | ✓ |
| `audit.read` | Consultar la bitácora de auditoría (RF19) |  | ✓ |  |  |
| `agenda.read` | Consultar la agenda del día (RF20) |  | ✓ | ✓ | ✓ |
| `reports.read` | Contar citas por estado en un rango de fechas (RF21) |  | ✓ |  |  |
