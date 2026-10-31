# Diagramas de MediCitas

Los diagramas usan [Mermaid](https://mermaid.js.org/), que GitHub dibuja directamente al ver este archivo.
Los nombres son los del esquema real (`db/sql/01-schema.sql`), en snake_case.

## 1. Arquitectura (Docker Compose)

```mermaid
flowchart LR
    cliente["Cliente<br/>curl · colección de peticiones · pruebas"]

    subgraph compose["Docker Compose · red interna"]
        app["app<br/>Node 24 + Express 5<br/>puerto 3000"]
        kc["keycloak<br/>Keycloak 26.7<br/>realm medicitas<br/>puerto 8080"]
        subgraph pg["db · PostgreSQL 18"]
            medicitas[("base medicitas<br/>dueño: mc_owner")]
            kcdb[("base keycloak<br/>dueño: keycloak")]
        end
        redis["redis<br/>Redis 8.2, solo caché<br/>sin puerto publicado"]
    end

    realm[/"keycloak/medicitas-realm.json"/]
    sql[/"db/sql/*.sql"/]

    cliente -- "1 pide un token (OIDC)" --> kc
    cliente -- "2 petición con Bearer token" --> app
    app -- "3 llaves públicas (JWKS)" --> kc
    app -- "4 SQL como mc_app + SET LOCAL ROLE" --> medicitas
    app -- "5 caché de disponibilidad (RF7)" --> redis
    kc --> kcdb
    realm -. "se importa al primer arranque" .-> kc
    sql -. "se ejecutan al primer arranque" .-> medicitas
```

El `sub` de cada token es el `keycloak_sub` de una fila de `users`: los ids de los usuarios de prueba están
fijados en `keycloak/medicitas-realm.json` y en `db/sql/04-seed.sql`, así que siempre coinciden.

## 2. Modelo entidad-relación: vista general

Para que el diagrama se pueda leer se omiten dos cosas que tienen casi todas las tablas:

- la relación `updated_by → users` (quién modificó el registro por última vez);
- las columnas de control `is_active`, `created_at`, `updated_at`, `updated_by`.

Las tablas de la clínica (agenda, contactos, citas, notas, bitácora) llevan `clinic_id`, pero no apuntan
directamente a `clinics`: lo hacen con FKs compuestas `(clinic_id, id)` hacia `users`, `patients`,
`services` o `appointments`, lo que obliga a que ambos registros sean de la misma clínica (I5).

```mermaid
erDiagram
    countries ||--o{ states : "contiene"
    states ||--o{ cities : "contiene"
    cities ||--o{ addresses : "contiene"
    clinics ||--o{ clinics_addresses : "tiene"
    addresses ||--o{ clinics_addresses : "ubica"

    roles ||--o{ users : "asigna"
    clinics |o--o{ users : "emplea"
    users ||--o| professionals : "se especializa en"
    roles ||--o{ permissions_per_roles : "tiene"
    permissions ||--o{ permissions_per_roles : "se otorga en"

    clinics ||--o{ services : "ofrece"
    specialties ||--o{ services : "requerida por"
    professionals ||--o{ specialties_per_professionals : "tiene"
    specialties ||--o{ specialties_per_professionals : "asignada en"
    professionals ||--o{ services_per_professionals : "atiende"
    services ||--o{ services_per_professionals : "atendido en"

    professionals ||--o{ professional_schedules : "trabaja en"
    professionals ||--o{ blockades : "se ausenta en"
    professionals ||--o{ professional_contacts : "tiene"

    clinics ||--o{ patients : "registra"
    genders |o--o{ patients : "describe"
    patients ||--o{ patient_contacts : "tiene"
    contact_types ||--o{ patient_contacts : "clasifica"
    contact_types ||--o{ professional_contacts : "clasifica"

    patients ||--o{ appointments : "reserva"
    professionals ||--o{ appointments : "atiende"
    services ||--o{ appointments : "define duración de"
    services_per_professionals ||--o{ appointments : "habilita"
    appointment_statuses ||--o{ appointments : "estado de"
    users |o--o{ appointments : "cancela"
    appointments |o--o| appointments : "reprograma"
    appointments ||--o| clinical_notes : "documenta"

    users ||--o{ audit_logs : "actúa en"
    patients ||--o{ audit_logs : "es objeto de"
    event_types ||--o{ audit_logs : "clasifica"
    data_objects ||--o{ audit_logs : "clasifica"
    severities ||--o{ system_errors_logs : "clasifica"
```

## 3. Detalle por área

Mismas omisiones que en la vista general. `PK` llave primaria, `FK` llave foránea, `UK` único.

### 3.1 Clínicas, usuarios y permisos

```mermaid
erDiagram
    clinics {
        int clinic_id PK
        varchar clinic_code UK "RF1"
        varchar clinic_name
        varchar time_zone "IANA, ej. America/Costa_Rica"
    }
    users {
        int user_id PK
        uuid keycloak_sub UK "claim sub del token"
        int clinic_id FK "NULL solo si role_id = 1"
        smallint role_id FK
        varchar name
        varchar last_name
    }
    roles {
        smallint role_id PK "1 a 4, fijos"
        varchar role_name UK "igual al rol de Keycloak"
        varchar description
    }
    professionals {
        int user_id PK, FK "mismo id que users"
        smallint role_id FK "siempre 4"
        varchar license_number
    }
    permissions {
        int permission_id PK
        varchar permission_name UK
        varchar description
    }
    permissions_per_roles {
        int permission_per_role_id PK
        smallint role_id FK
        int permission_id FK
    }
    countries {
        int country_id PK
        char iso_code UK
        varchar country_name
    }
    states {
        int state_id PK
        int country_id FK
        varchar state_name
    }
    cities {
        int city_id PK
        int state_id FK
        varchar city_name
    }
    addresses {
        int address_id PK
        int city_id FK
        varchar address
        varchar zip_code "NULL"
    }
    clinics_addresses {
        int clinic_address_id PK
        int clinic_id FK
        int address_id FK
    }

    clinics |o--o{ users : "emplea"
    roles ||--o{ users : "asigna"
    users ||--o| professionals : "se especializa en"
    roles ||--o{ permissions_per_roles : "tiene"
    permissions ||--o{ permissions_per_roles : "se otorga en"
    countries ||--o{ states : "contiene"
    states ||--o{ cities : "contiene"
    cities ||--o{ addresses : "contiene"
    clinics ||--o{ clinics_addresses : "tiene"
    addresses ||--o{ clinics_addresses : "ubica"
```

### 3.2 Servicios y agenda

```mermaid
erDiagram
    specialties {
        int specialty_id PK
        varchar specialty_name UK
    }
    services {
        int service_id PK
        int clinic_id FK
        varchar service_name
        int duration_minutes "mayor que 0"
        int specialty_id FK
    }
    specialties_per_professionals {
        int specialty_per_professional_id PK
        int professional_id FK
        int specialty_id FK
    }
    services_per_professionals {
        int service_per_professional_id PK
        int clinic_id FK "compartido por las dos FKs"
        int professional_id FK
        int service_id FK
    }
    professional_schedules {
        int schedule_id PK
        int clinic_id FK
        int professional_id FK
        tstzrange period "EXCLUDE: sin solapes"
    }
    blockades {
        int blockade_id PK
        int clinic_id FK
        int professional_id FK
        tstzrange period
        text reason "NULL"
    }
    professional_contacts {
        int contact_id PK
        int clinic_id FK
        int professional_id FK
        int contact_type_id FK
        varchar contact_value
    }
    professionals {
        int user_id PK, FK
    }
    contact_types {
        int contact_type_id PK
        varchar contact_type_name UK
    }

    specialties ||--o{ services : "requerida por"
    professionals ||--o{ specialties_per_professionals : "tiene"
    specialties ||--o{ specialties_per_professionals : "asignada en"
    professionals ||--o{ services_per_professionals : "atiende"
    services ||--o{ services_per_professionals : "atendido en"
    professionals ||--o{ professional_schedules : "trabaja en"
    professionals ||--o{ blockades : "se ausenta en"
    professionals ||--o{ professional_contacts : "tiene"
    contact_types ||--o{ professional_contacts : "clasifica"
```

### 3.3 Pacientes, citas y notas clínicas

```mermaid
erDiagram
    patients {
        int patient_id PK
        int clinic_id FK
        varchar identification "UK junto con clinic_id"
        varchar name
        varchar last_name
        date birth_date
        smallint gender_id FK "NULL"
    }
    genders {
        smallint gender_id PK
        varchar gender_name UK
    }
    patient_contacts {
        int contact_id PK
        int clinic_id FK
        int patient_id FK
        int contact_type_id FK
        varchar contact_value "dato sensible, RF18"
    }
    contact_types {
        int contact_type_id PK
        varchar contact_type_name UK
    }
    appointments {
        bigint appointment_id PK
        int clinic_id FK
        int patient_id FK
        int professional_id FK
        int service_id FK
        smallint appointment_status_id FK
        tstzrange period "fin calculado por trigger, I4"
        text appointment_description "NULL"
        text cancel_reason "NULL, RF11"
        int cancelled_by FK "NULL, RF11"
        timestamptz cancelled_at "NULL"
        bigint rescheduled_from_id FK "NULL, UK, RF10"
    }
    appointment_statuses {
        smallint appointment_status_id PK "1 a 5, fijos"
        varchar status_name UK
        boolean is_final
    }
    clinical_notes {
        bigint clinical_note_id PK
        int clinic_id FK
        bigint appointment_id FK, UK "una nota por cita"
        text note_text "dato más sensible, RF15"
    }
    services_per_professionals {
        int service_per_professional_id PK
    }
    users {
        int user_id PK
    }

    genders |o--o{ patients : "describe"
    patients ||--o{ patient_contacts : "tiene"
    contact_types ||--o{ patient_contacts : "clasifica"
    patients ||--o{ appointments : "reserva"
    services_per_professionals ||--o{ appointments : "habilita"
    appointment_statuses ||--o{ appointments : "estado de"
    users |o--o{ appointments : "cancela"
    appointments |o--o| appointments : "reprograma"
    appointments ||--o| clinical_notes : "documenta"
```

### 3.4 Bitácoras

```mermaid
erDiagram
    audit_logs {
        bigint log_id PK
        int clinic_id FK
        int user_id FK "quién"
        smallint event_type_id FK "qué acción"
        smallint data_object_id FK "sobre qué tipo de dato"
        bigint object_id "id del registro, sin FK"
        int patient_id FK "sobre cuál paciente"
        varchar description
        jsonb metadata "NULL"
        timestamptz created_at "cuándo"
    }
    event_types {
        smallint event_type_id PK
        varchar name UK
        varchar description
    }
    data_objects {
        smallint data_object_id PK
        varchar name UK
        varchar description
    }
    system_errors_logs {
        bigint error_id PK
        smallint severity_id FK
        uuid process_uuid "NULL"
        varchar process_name
        varchar step_name "NULL"
        jsonb input_data "NULL"
        text error_message
        jsonb metadata "NULL"
        timestamptz created_at
    }
    severities {
        smallint severity_id PK
        varchar name UK
        varchar description
    }
    users {
        int user_id PK
    }
    patients {
        int patient_id PK
    }

    users ||--o{ audit_logs : "actúa en"
    patients ||--o{ audit_logs : "es objeto de"
    event_types ||--o{ audit_logs : "clasifica"
    data_objects ||--o{ audit_logs : "clasifica"
    severities ||--o{ system_errors_logs : "clasifica"
```
