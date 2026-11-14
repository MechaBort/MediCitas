-- =============================================================================
-- MediCitas · Esquema relacional (Etapa 1)
--
-- Traducción del modelo del README. Los nombres pasan de camelCase a snake_case
-- (clinicId → clinic_id, ServicesPerProfessionals → services_per_professionals)
-- porque PostgreSQL convierte a minúsculas todo identificador sin comillas.
--
-- Lo ejecuta mc_owner (db/init/00-init.sh), que queda como dueño de todo.
--
-- Una sola base con un schema por servicio (docs/diseno-servicios.md, sección 5):
--   admin     clínicas, usuarios, permisos, geografía, catálogo de servicios y profesionales
--   agenda    horarios, bloqueos y citas
--   clinical  pacientes, notas clínicas y bitácora de auditoría
-- Los schemas separan servicios, no clínicas: el tenant sigue siendo la columna clinic_id.
-- Cada CREATE TABLE nombra su schema; el resto del SQL usa el search_path. Por eso los
-- nombres de tabla deben ser únicos entre los tres schemas.
--
-- Códigos de error propios (SQLSTATE) que lanzan los triggers, para que la API
-- los traduzca a códigos HTTP:
--   MC001  la cita cae fuera del horario o dentro de un bloqueo        (I3)
--   MC002  transición de estado no permitida                           (RF13)
--   MC003  desenlace registrado antes de la hora de inicio             (RF12)
--   MC004  intento de mover una cita (periodo, servicio, profesional)  (I4)
--   MC005  intento de modificar o borrar la bitácora                   (I6)
--   MC006  el bloque de horario tiene citas reservadas                 (I3)
-- =============================================================================

BEGIN;

-- Necesaria para EXCLUDE e índices GiST que combinan un entero (=) con un rango (&&).
-- Se nombra public para que no caiga en el primer schema del search_path.
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;

CREATE SCHEMA admin;
CREATE SCHEMA agenda;
CREATE SCHEMA clinical;

-- Los nombres sin schema (FKs, índices, triggers) se buscan en este orden. Los scripts
-- 02 a 05 empiezan con la misma línea.
SET search_path = admin, agenda, clinical, public;


-- =============================================================================
-- USUARIOS Y CLÍNICAS
-- roles, clinics y users se referencian en círculo (updated_by → users), así que
-- las FKs de updated_by de roles y clinics se agregan al final del archivo.
-- =============================================================================

-- Ids fijos (1 platform_admin, 2 clinic_admin, 3 reception, 4 professional):
-- los CHECK de users y professionals los usan como constantes.
CREATE TABLE admin.roles (
    role_id         SMALLINT PRIMARY KEY,
    role_name       VARCHAR(50) NOT NULL UNIQUE,      -- mismo nombre que el rol en Keycloak
    description     VARCHAR(150),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL
);

CREATE TABLE admin.clinics (
    clinic_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_code     VARCHAR(30) NOT NULL UNIQUE,      -- identificador de la clínica (RF1)
    clinic_name     VARCHAR(75) NOT NULL,
    time_zone       VARCHAR(64) NOT NULL,             -- nombre IANA; el backend lo valida contra pg_timezone_names
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL
);

CREATE TABLE admin.users (
    user_id         INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    keycloak_sub    UUID NOT NULL UNIQUE,             -- claim `sub` del token de Keycloak
    clinic_id       INT REFERENCES clinics,           -- NULL solo para el administrador de plataforma (RF2)
    role_id         SMALLINT NOT NULL REFERENCES roles,
    name            VARCHAR(50) NOT NULL,
    last_name       VARCHAR(50) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,    -- baja lógica (RF2)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT uq_users_clinic_user UNIQUE (clinic_id, user_id),   -- destino de las FKs compuestas (I5)
    CONSTRAINT uq_users_user_role   UNIQUE (user_id, role_id),     -- destino de la FK de professionals
    CONSTRAINT ck_users_platform_admin CHECK ((role_id = 1) = (clinic_id IS NULL))
);

-- Especialización 1:1 de users; la clínica se toma de users.
CREATE TABLE admin.professionals (
    user_id         INT PRIMARY KEY,
    role_id         SMALLINT NOT NULL DEFAULT 4,      -- existe solo para la FK que garantiza el rol
    license_number  VARCHAR(30) NOT NULL,             -- código del colegio profesional
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_professionals_role CHECK (role_id = 4),
    -- Garantiza a la vez que el usuario existe y que su rol es `professional`. Si luego
    -- se cambia el rol en users, el par (user_id, 4) sigue referenciado y el cambio se rechaza.
    CONSTRAINT fk_professionals_user_role FOREIGN KEY (user_id, role_id)
        REFERENCES users (user_id, role_id)
);

CREATE TABLE admin.permissions (
    permission_id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_name VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(200),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE admin.permissions_per_roles (
    permission_per_role_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id         SMALLINT NOT NULL REFERENCES roles,
    permission_id   INT NOT NULL REFERENCES permissions,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (role_id, permission_id)
);


-- =============================================================================
-- GEOGRAFÍA
-- =============================================================================

CREATE TABLE admin.countries (
    country_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    iso_code        CHAR(3) NOT NULL UNIQUE,
    country_name    VARCHAR(50) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE admin.states (
    state_id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    country_id      INT NOT NULL REFERENCES countries,
    state_name      VARCHAR(40) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE admin.cities (
    city_id         INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state_id        INT NOT NULL REFERENCES states,
    city_name       VARCHAR(50) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE admin.addresses (
    address_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city_id         INT NOT NULL REFERENCES cities,
    address         VARCHAR(100) NOT NULL,
    zip_code        VARCHAR(20),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE admin.clinics_addresses (
    clinic_address_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL REFERENCES clinics,
    address_id      INT NOT NULL REFERENCES addresses,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);


-- =============================================================================
-- ESPECIALIDADES Y SERVICIOS
-- =============================================================================

CREATE TABLE admin.specialties (
    specialty_id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    specialty_name  VARCHAR(50) NOT NULL UNIQUE
);

-- Sin clinic_id: las especialidades son globales y esta tabla solo se lee a través del profesional.
CREATE TABLE admin.specialties_per_professionals (
    specialty_per_professional_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_id INT NOT NULL REFERENCES professionals (user_id),
    specialty_id    INT NOT NULL REFERENCES specialties,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (professional_id, specialty_id)
);

-- RF3
CREATE TABLE admin.services (
    service_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL REFERENCES clinics,
    service_name    VARCHAR(63) NOT NULL,
    duration_minutes INT NOT NULL CHECK (duration_minutes > 0),
    specialty_id    INT NOT NULL REFERENCES specialties,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT uq_services_clinic_service UNIQUE (clinic_id, service_id)
);

-- RF4: servicios que el profesional está habilitado para atender.
CREATE TABLE admin.services_per_professionals (
    service_per_professional_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    professional_id INT NOT NULL REFERENCES professionals (user_id),
    service_id      INT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    -- clinic_id es compartido por las dos FKs: profesional y servicio son de la misma clínica.
    FOREIGN KEY (clinic_id, professional_id) REFERENCES users (clinic_id, user_id),
    FOREIGN KEY (clinic_id, service_id)      REFERENCES services (clinic_id, service_id),
    CONSTRAINT uq_spp_clinic_prof_service UNIQUE (clinic_id, professional_id, service_id)
);


-- =============================================================================
-- AGENDA
-- Todo intervalo es [inicio, fin): finito, no vacío, inicio incluido y fin excluido.
-- =============================================================================

-- RF5: cada fila es un bloque concreto de atención (p. ej. lunes 2026-11-02 08:00–12:00).
CREATE TABLE agenda.professional_schedules (
    schedule_id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    professional_id INT NOT NULL REFERENCES professionals (user_id),
    period          TSTZRANGE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (clinic_id, professional_id) REFERENCES users (clinic_id, user_id),
    CONSTRAINT ck_schedules_period CHECK (
        NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
        AND NOT lower_inf(period) AND NOT upper_inf(period)),
    -- Un profesional no tiene bloques solapados.
    CONSTRAINT ex_schedules_overlap
        EXCLUDE USING gist (professional_id WITH =, period WITH &&)
);

-- RF6: vacaciones o permisos. Pueden solaparse entre sí.
CREATE TABLE agenda.blockades (
    blockade_id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    professional_id INT NOT NULL REFERENCES professionals (user_id),
    period          TSTZRANGE NOT NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (clinic_id, professional_id) REFERENCES users (clinic_id, user_id),
    CONSTRAINT ck_blockades_period CHECK (
        NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
        AND NOT lower_inf(period) AND NOT upper_inf(period))
);


-- =============================================================================
-- PACIENTES
-- =============================================================================

CREATE TABLE clinical.genders (
    gender_id       SMALLINT PRIMARY KEY,
    gender_name     VARCHAR(30) NOT NULL UNIQUE
);

-- RF14: no son usuarios del sistema ni tienen credenciales.
CREATE TABLE clinical.patients (
    patient_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL REFERENCES clinics,
    identification  VARCHAR(30) NOT NULL,
    name            VARCHAR(50) NOT NULL,
    last_name       VARCHAR(50) NOT NULL,
    birth_date      DATE NOT NULL,
    gender_id       SMALLINT REFERENCES genders,      -- NULL si el paciente no lo indica
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT uq_patients_clinic_identification UNIQUE (clinic_id, identification),
    CONSTRAINT uq_patients_clinic_patient UNIQUE (clinic_id, patient_id)  -- destino de las FKs compuestas
);

CREATE TABLE admin.contact_types (
    contact_type_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contact_type_name VARCHAR(50) NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

-- Dato sensible: toda lectura y escritura se registra en la bitácora (RF18).
CREATE TABLE clinical.patient_contacts (
    contact_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    patient_id      INT NOT NULL,
    contact_type_id INT NOT NULL REFERENCES contact_types,
    contact_value   VARCHAR(320) NOT NULL,            -- 320: máximo de un correo (RFC 5321)
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, patient_id)
);

CREATE TABLE admin.professional_contacts (
    contact_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    professional_id INT NOT NULL REFERENCES professionals (user_id),
    contact_type_id INT NOT NULL REFERENCES contact_types,
    contact_value   VARCHAR(320) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (clinic_id, professional_id) REFERENCES users (clinic_id, user_id),
    UNIQUE (professional_id, contact_type_id, contact_value)
);


-- =============================================================================
-- CITAS
-- =============================================================================

-- 1 reservada, 2 atendida, 3 ausente, 4 cancelada, 5 reprogramada
CREATE TABLE agenda.appointment_statuses (
    appointment_status_id SMALLINT PRIMARY KEY,
    status_name     VARCHAR(12) NOT NULL UNIQUE,
    is_final        BOOLEAN NOT NULL                  -- los estados finales no admiten salida (RF13)
);

CREATE TABLE agenda.appointments (
    appointment_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    patient_id      INT NOT NULL,
    professional_id INT NOT NULL REFERENCES professionals (user_id),
    service_id      INT NOT NULL,
    appointment_status_id SMALLINT NOT NULL DEFAULT 1 REFERENCES appointment_statuses,
    -- La API envía solo el inicio, tstzrange($inicio, NULL); el trigger
    -- trg_appointments_10_set_period completa el fin con la duración del servicio (I4).
    period          TSTZRANGE NOT NULL,
    appointment_description TEXT,                     -- motivo de la consulta
    cancel_reason   TEXT,                             -- RF11
    cancelled_by    INT,                              -- RF11
    cancelled_at    TIMESTAMPTZ,
    rescheduled_from_id BIGINT,                       -- la cita nueva apunta a la que reemplaza (RF10)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT uq_appointments_clinic_appointment UNIQUE (clinic_id, appointment_id),
    CONSTRAINT uq_appointments_rescheduled_from UNIQUE (rescheduled_from_id),  -- se reprograma una sola vez
    FOREIGN KEY (clinic_id, patient_id)      REFERENCES patients (clinic_id, patient_id),
    FOREIGN KEY (clinic_id, professional_id) REFERENCES users (clinic_id, user_id),
    FOREIGN KEY (clinic_id, service_id)      REFERENCES services (clinic_id, service_id),
    -- Solo se reserva un servicio que el profesional atiende.
    FOREIGN KEY (clinic_id, professional_id, service_id)
        REFERENCES services_per_professionals (clinic_id, professional_id, service_id),
    FOREIGN KEY (clinic_id, cancelled_by)    REFERENCES users (clinic_id, user_id),
    FOREIGN KEY (clinic_id, rescheduled_from_id) REFERENCES appointments (clinic_id, appointment_id),
    CONSTRAINT ck_appointments_period CHECK (
        NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
        AND NOT lower_inf(period) AND NOT upper_inf(period)),
    -- Cancelada ⇔ los tres datos de la cancelación presentes; en otro estado, los tres vacíos.
    CONSTRAINT ck_appointments_cancellation CHECK (
        CASE WHEN appointment_status_id = 4
             THEN num_nonnulls(cancel_reason, cancelled_by, cancelled_at) = 3
             ELSE num_nonnulls(cancel_reason, cancelled_by, cancelled_at) = 0
        END),
    -- I1 e I2: solo las citas reservadas ocupan espacio. Al cancelar o reprogramar,
    -- la fila sale del índice y el espacio queda libre en el mismo commit (I7).
    CONSTRAINT ex_appointments_professional
        EXCLUDE USING gist (professional_id WITH =, period WITH &&) WHERE (appointment_status_id = 1),
    CONSTRAINT ex_appointments_patient
        EXCLUDE USING gist (patient_id WITH =, period WITH &&) WHERE (appointment_status_id = 1)
);

-- RF15: el dato más sensible. El autor es el profesional de la cita, por eso no se repite aquí.
CREATE TABLE clinical.clinical_notes (
    clinical_note_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    appointment_id  BIGINT NOT NULL UNIQUE,           -- una nota por cita
    note_text       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointments (clinic_id, appointment_id)
);


-- =============================================================================
-- BITÁCORAS
-- =============================================================================

CREATE TABLE clinical.event_types (
    event_type_id   SMALLINT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(150) NOT NULL
);

CREATE TABLE clinical.data_objects (
    data_object_id  SMALLINT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(100) NOT NULL
);

-- RF18 / RF19: append-only, protegida en el motor (I6) y con cadena de huellas SHA-256 por clínica (§9).
CREATE TABLE clinical.audit_logs (
    log_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_id       INT NOT NULL,
    user_id         INT NOT NULL,                     -- quién
    event_type_id   SMALLINT NOT NULL REFERENCES event_types,   -- qué acción
    data_object_id  SMALLINT NOT NULL REFERENCES data_objects,  -- sobre qué tipo de dato
    object_id       BIGINT NOT NULL,                  -- sin FK: apunta a tablas distintas según data_object_id
    patient_id      INT NOT NULL,                     -- sobre cuál paciente
    description     VARCHAR(255) NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- cuándo
    prev_hash       CHAR(64),                         -- huella SHA-256 del registro previo de la misma clínica (NULL en el primero)
    row_hash        CHAR(64) NOT NULL,                -- huella SHA-256 de este registro encadenada con prev_hash
    FOREIGN KEY (clinic_id, user_id)    REFERENCES users (clinic_id, user_id),
    FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, patient_id)
);


-- FKs de updated_by que no se pudieron declarar antes por la referencia circular.
ALTER TABLE roles   ADD FOREIGN KEY (updated_by) REFERENCES users DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE clinics ADD FOREIGN KEY (updated_by) REFERENCES users DEFERRABLE INITIALLY DEFERRED;


-- =============================================================================
-- TRIGGERS
-- PostgreSQL dispara los triggers del mismo evento en orden alfabético de nombre;
-- por eso los de appointments llevan número (10, 20, 30).
-- =============================================================================

-- Las funciones de los triggers van en el schema de su tabla y fijan su propio
-- search_path: así encuentran las tablas sin depender de quién dispare el trigger.

-- updated_at se mantiene solo, en toda tabla que lo tenga. Es la única función que
-- comparten los tres schemas; vive en admin y no lee ninguna tabla.
CREATE FUNCTION admin.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN
        SELECT table_schema, table_name FROM information_schema.columns
         WHERE table_schema IN ('admin', 'agenda', 'clinical') AND column_name = 'updated_at'
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I.%I
             FOR EACH ROW EXECUTE FUNCTION admin.set_updated_at()', t.table_schema, t.table_name);
    END LOOP;
END $$;


-- I4: la duración la decide el servicio. Al insertar se ignora el fin que mande la
-- aplicación y se calcula; después, la cita no se mueve (para moverla se reprograma).
CREATE FUNCTION agenda.appointments_set_period() RETURNS trigger
LANGUAGE plpgsql SET search_path = admin, agenda, clinical, pg_temp AS $$
DECLARE
    v_duration INT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.period, NEW.service_id, NEW.professional_id, NEW.patient_id, NEW.clinic_id)
           IS DISTINCT FROM
           (OLD.period, OLD.service_id, OLD.professional_id, OLD.patient_id, OLD.clinic_id) THEN
            RAISE EXCEPTION 'Una cita no se mueve ni cambia de servicio: se reprograma (I4, RF10)'
                USING ERRCODE = 'MC004';
        END IF;
        RETURN NEW;
    END IF;

    IF lower(NEW.period) IS NULL THEN
        RAISE EXCEPTION 'La cita necesita un instante de inicio'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT duration_minutes INTO v_duration
      FROM services
     WHERE service_id = NEW.service_id AND clinic_id = NEW.clinic_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El servicio % no existe en la clínica %', NEW.service_id, NEW.clinic_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.period := tstzrange(lower(NEW.period),
                            lower(NEW.period) + make_interval(mins => v_duration), '[)');
    RETURN NEW;
END $$;

CREATE TRIGGER trg_appointments_10_set_period
    BEFORE INSERT OR UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_set_period();


-- I3: la cita cae dentro del horario del profesional y fuera de sus bloqueos.
-- range_agg une los bloques contiguos (08:00–12:00 + 12:00–16:00), así una cita
-- de 11:45 a 12:15 se acepta.
--
-- Concurrencia: los bloques de horario usados se bloquean FOR NO KEY UPDATE hasta el
-- commit, por dos motivos:
-- 1. Nadie puede borrarlos ni recortarlos mientras la reserva no termine (ver
--    professional_schedules_guard).
-- 2. Las reservas del mismo profesional sobre el mismo bloque hacen fila. Sin esa fila,
--    varias reservas simultáneas al mismo espacio llegaban a la vez a la restricción
--    EXCLUDE, que hace que cada una espere a las otras que siguen en curso: se esperaban
--    en ciclo y PostgreSQL abortaba por deadlock, una por segundo (deadlock_timeout).
--    Con diez a la vez, los reintentos se agotaban. Con la fila, la primera confirma y
--    cada una de las siguientes encuentra a la ganadora ya confirmada: 23P01 al instante.
--    La garantía de una sola ganadora sigue siendo el EXCLUDE; el candado solo ordena.
--    Antes era FOR SHARE, que no hace esperar a otra reserva.
-- Un bloqueo (blockade) creado al mismo tiempo no se impide: RF6 dice que un bloqueo no
-- cancela citas, las deja como conflicto.
--
-- SECURITY DEFINER: FOR NO KEY UPDATE exige permiso UPDATE sobre la tabla, que recepción no
-- tiene; la función corre como su dueño (mc_owner) con un search_path fijo. En una
-- función SECURITY DEFINER ese search_path fijo es obligatorio: si dependiera del que
-- llama, alguien podría hacerle leer una tabla falsa con el mismo nombre.
CREATE FUNCTION agenda.appointments_check_agenda() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = admin, agenda, clinical, pg_temp AS $$
DECLARE
    v_working tstzmultirange;
BEGIN
    PERFORM 1
       FROM professional_schedules
      WHERE professional_id = NEW.professional_id
        AND period && NEW.period
        FOR NO KEY UPDATE;

    SELECT range_agg(period) INTO v_working
      FROM professional_schedules
     WHERE professional_id = NEW.professional_id
       AND period && NEW.period;

    IF v_working IS NULL OR NOT v_working @> NEW.period THEN
        RAISE EXCEPTION 'La cita cae fuera del horario de atención del profesional (I3)'
            USING ERRCODE = 'MC001';
    END IF;

    IF EXISTS (SELECT 1 FROM blockades
                WHERE professional_id = NEW.professional_id
                  AND period && NEW.period) THEN
        RAISE EXCEPTION 'La cita cae dentro de un bloqueo de agenda del profesional (I3)'
            USING ERRCODE = 'MC001';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_appointments_20_check_agenda
    BEFORE INSERT ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_check_agenda();


-- RF13: toda cita nace reservada; solo se sale de un estado no final, y una cita en
-- estado final ya no se modifica. RF12: atendida y ausente solo después del inicio.
CREATE FUNCTION agenda.appointments_check_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = admin, agenda, clinical, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.appointment_status_id <> 1 THEN
            RAISE EXCEPTION 'Una cita nueva nace en estado reservada (RF13)'
                USING ERRCODE = 'MC002';
        END IF;
        RETURN NEW;
    END IF;

    IF (SELECT is_final FROM appointment_statuses
         WHERE appointment_status_id = OLD.appointment_status_id) THEN
        RAISE EXCEPTION 'La cita está en un estado final y no admite cambios (RF13)'
            USING ERRCODE = 'MC002';
    END IF;

    IF NEW.appointment_status_id IN (2, 3) AND now() < lower(NEW.period) THEN
        RAISE EXCEPTION 'El desenlace solo se registra después de la hora de inicio (RF12)'
            USING ERRCODE = 'MC003';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_appointments_30_check_status
    BEFORE INSERT OR UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_check_status();


-- I3 desde el otro lado: no se borra ni se recorta un bloque de horario que deje
-- citas reservadas afuera. Para ausencias se usa un bloqueo (RF6), no esto.
CREATE FUNCTION agenda.professional_schedules_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = admin, agenda, clinical, pg_temp AS $$
DECLARE
    v_remaining tstzrange;  -- lo que queda del bloque después del cambio (NULL si desaparece)
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.professional_id = OLD.professional_id THEN
        v_remaining := NEW.period;
    END IF;

    IF EXISTS (SELECT 1 FROM appointments a
                WHERE a.professional_id = OLD.professional_id
                  AND a.appointment_status_id = 1
                  AND a.period && OLD.period
                  AND (v_remaining IS NULL OR NOT v_remaining @> a.period)) THEN
        RAISE EXCEPTION 'El bloque de horario tiene citas reservadas; reprográmelas antes (I3)'
            USING ERRCODE = 'MC006';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_professional_schedules_guard
    BEFORE UPDATE OR DELETE ON professional_schedules
    FOR EACH ROW EXECUTE FUNCTION professional_schedules_guard();


-- I6: la bitácora es append-only aunque alguien conceda UPDATE o DELETE por error.
CREATE FUNCTION clinical.audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'La bitácora de auditoría no admite modificación ni borrado (I6)'
        USING ERRCODE = 'MC005';
END $$;

CREATE TRIGGER trg_audit_logs_append_only
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TRIGGER trg_audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();


-- Módulo §9 (auditoría verificable): cada entrada en audit_logs calcula su huella SHA-256
-- a partir de sus columnas inmutables y de la huella del registro anterior de la misma clínica.
-- La función de cálculo es compartida entre el trigger BEFORE INSERT y la función de verificación
-- para garantizar que ambos serialicen exactamente los mismos campos en el mismo formato.
CREATE FUNCTION clinical.audit_log_compute_hash(
    p_prev_hash      CHAR(64),
    p_log_id         BIGINT,
    p_clinic_id      INT,
    p_user_id        INT,
    p_event_type_id  SMALLINT,
    p_data_object_id SMALLINT,
    p_object_id      BIGINT,
    p_patient_id     INT,
    p_description    VARCHAR,
    p_metadata       JSONB,
    p_created_at     TIMESTAMPTZ
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
    SELECT encode(
        sha256(
            convert_to(
                concat_ws(
                    '|',
                    coalesce(p_prev_hash, 'GENESIS'),
                    p_log_id::text,
                    p_clinic_id::text,
                    p_user_id::text,
                    p_event_type_id::text,
                    p_data_object_id::text,
                    p_object_id::text,
                    p_patient_id::text,
                    p_description,
                    coalesce(p_metadata::text, ''),
                    to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ),
                'UTF8'
            )
        ),
        'hex'
    )::char(64);
$$;

-- Trigger BEFORE INSERT: serializa las inserciones de una misma clínica con un candado
-- consultivo transaccional (pg_advisory_xact_lock) para evitar que dos transacciones
-- concurrentes lean el mismo predecesor y bifurquen la cadena.
-- SECURITY DEFINER: mc_reception y mc_professional tienen INSERT pero no SELECT sobre
-- audit_logs; la función corre como mc_owner con search_path fijo para leer la huella previa.
CREATE FUNCTION clinical.audit_logs_set_hash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = admin, agenda, clinical, pg_temp AS $$
DECLARE
    v_prev_id   BIGINT;
    v_prev_hash CHAR(64);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('clinical.audit_logs'), NEW.clinic_id);

    SELECT log_id, row_hash
      INTO v_prev_id, v_prev_hash
      FROM audit_logs
     WHERE clinic_id = NEW.clinic_id
     ORDER BY log_id DESC
     LIMIT 1;

    -- Si dos transacciones obtuvieron su nextval antes del candado en orden inverso al que
    -- adquirieron el candado, se adelanta log_id para que el orden por log_id coincida siempre
    -- con el orden real de encadenamiento.
    IF v_prev_id IS NOT NULL AND NEW.log_id <= v_prev_id THEN
        NEW.log_id := nextval(pg_get_serial_sequence('clinical.audit_logs', 'log_id'));
    END IF;

    NEW.prev_hash := v_prev_hash;
    NEW.row_hash  := audit_log_compute_hash(
        NEW.prev_hash,
        NEW.log_id,
        NEW.clinic_id,
        NEW.user_id,
        NEW.event_type_id,
        NEW.data_object_id,
        NEW.object_id,
        NEW.patient_id,
        NEW.description,
        NEW.metadata,
        NEW.created_at
    );
    RETURN NEW;
END $$;

CREATE TRIGGER trg_audit_logs_hash_chain
    BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_set_hash();

-- Recorre la cadena de una clínica en orden de log_id y devuelve el resultado de la verificación,
-- señalando el primer registro roto si alguien alteró una fila o borró un eslabón intermedio.
CREATE FUNCTION clinical.verify_audit_chain(p_clinic_id INT)
RETURNS TABLE (
    is_valid            BOOLEAN,
    checked_count       BIGINT,
    last_log_id         BIGINT,
    last_row_hash       CHAR(64),
    first_broken_log_id BIGINT,
    failure_reason      TEXT
)
LANGUAGE plpgsql STABLE SET search_path = admin, agenda, clinical, pg_temp AS $$
DECLARE
    v_row           audit_logs%ROWTYPE;
    v_expected_prev CHAR(64) := NULL;
    v_computed_hash CHAR(64);
    v_count         BIGINT   := 0;
    v_last_id       BIGINT   := NULL;
    v_last_hash     CHAR(64) := NULL;
BEGIN
    FOR v_row IN
        SELECT *
          FROM audit_logs
         WHERE clinic_id = p_clinic_id
         ORDER BY log_id ASC
    LOOP
        v_count := v_count + 1;

        IF v_row.prev_hash IS DISTINCT FROM v_expected_prev THEN
            RETURN QUERY SELECT
                false,
                v_count,
                v_row.log_id,
                v_row.row_hash,
                v_row.log_id,
                'La huella previa (prev_hash) no coincide con la del registro anterior'::text;
            RETURN;
        END IF;

        v_computed_hash := audit_log_compute_hash(
            v_row.prev_hash,
            v_row.log_id,
            v_row.clinic_id,
            v_row.user_id,
            v_row.event_type_id,
            v_row.data_object_id,
            v_row.object_id,
            v_row.patient_id,
            v_row.description,
            v_row.metadata,
            v_row.created_at
        );

        IF v_row.row_hash IS DISTINCT FROM v_computed_hash THEN
            RETURN QUERY SELECT
                false,
                v_count,
                v_row.log_id,
                v_row.row_hash,
                v_row.log_id,
                'La huella del registro (row_hash) no coincide con su contenido actual'::text;
            RETURN;
        END IF;

        v_expected_prev := v_row.row_hash;
        v_last_id       := v_row.log_id;
        v_last_hash     := v_row.row_hash;
    END LOOP;

    RETURN QUERY SELECT
        true,
        v_count,
        v_last_id,
        v_last_hash,
        NULL::bigint,
        NULL::text;
END $$;


-- =============================================================================
-- ÍNDICES
-- Los de PK, UNIQUE y EXCLUDE los crea PostgreSQL. Cada uno se justificará con
-- EXPLAIN ANALYZE cuando estén los datos semilla.
-- =============================================================================

-- RF6 (citas en conflicto con un bloqueo) y RF7 (restar bloqueos a la disponibilidad)
CREATE INDEX ix_blockades_prof_period      ON blockades USING gist (professional_id, period);

-- RF8: profesionales que atienden un servicio (el UNIQUE pone professional_id antes que service_id)
CREATE INDEX ix_spp_clinic_service         ON services_per_professionals (clinic_id, service_id);

-- RF20 (agenda del día de la clínica) y RF21 (conteo por estado en un rango de fechas)
CREATE INDEX ix_appointments_clinic_start  ON appointments (clinic_id, lower(period));

-- RF20: agenda del día de un profesional, en todos los estados
CREATE INDEX ix_appointments_prof_start    ON appointments (professional_id, lower(period));

-- RF16: historial de citas de un paciente
CREATE INDEX ix_appointments_patient_start ON appointments (patient_id, lower(period));

-- RF14 / RF18: contactos de un paciente
CREATE INDEX ix_patient_contacts_patient   ON patient_contacts (patient_id);

-- RF19: bitácora filtrada por paciente, por usuario o solo por rango de fechas
CREATE INDEX ix_audit_clinic_patient_date  ON audit_logs (clinic_id, patient_id, created_at);
CREATE INDEX ix_audit_clinic_user_date     ON audit_logs (clinic_id, user_id, created_at);
CREATE INDEX ix_audit_clinic_date          ON audit_logs (clinic_id, created_at);

-- Módulo §9: último registro por clínica al encadenar y recorrido ordenado al verificar la cadena
CREATE INDEX ix_audit_clinic_log           ON audit_logs (clinic_id, log_id);

COMMIT;
