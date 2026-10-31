-- =============================================================================
-- MediCitas · Esquema relacional (Etapa 1)
--
-- Traducción del modelo del README. Los nombres pasan de camelCase a snake_case
-- (clinicId → clinic_id, ServicesPerProfessionals → services_per_professionals)
-- porque PostgreSQL convierte a minúsculas todo identificador sin comillas.
--
-- Lo ejecuta mc_owner (db/init/00-init.sh), que queda como dueño de todo.
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
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- =============================================================================
-- USUARIOS Y CLÍNICAS
-- roles, clinics y users se referencian en círculo (updated_by → users), así que
-- las FKs de updated_by de roles y clinics se agregan al final del archivo.
-- =============================================================================

-- Ids fijos (1 platform_admin, 2 clinic_admin, 3 reception, 4 professional):
-- los CHECK de users y professionals los usan como constantes.
CREATE TABLE roles (
    role_id         SMALLINT PRIMARY KEY,
    role_name       VARCHAR(50) NOT NULL UNIQUE,      -- mismo nombre que el rol en Keycloak
    description     VARCHAR(150),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL
);

CREATE TABLE clinics (
    clinic_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clinic_code     VARCHAR(30) NOT NULL UNIQUE,      -- identificador de la clínica (RF1)
    clinic_name     VARCHAR(75) NOT NULL,
    time_zone       VARCHAR(64) NOT NULL,             -- nombre IANA; el backend lo valida contra pg_timezone_names
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL
);

CREATE TABLE users (
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
CREATE TABLE professionals (
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

CREATE TABLE permissions (
    permission_id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_name VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(200),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE permissions_per_roles (
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

CREATE TABLE countries (
    country_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    iso_code        CHAR(3) NOT NULL UNIQUE,
    country_name    VARCHAR(50) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE states (
    state_id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    country_id      INT NOT NULL REFERENCES countries,
    state_name      VARCHAR(40) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cities (
    city_id         INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state_id        INT NOT NULL REFERENCES states,
    city_name       VARCHAR(50) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE addresses (
    address_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city_id         INT NOT NULL REFERENCES cities,
    address         VARCHAR(100) NOT NULL,
    zip_code        VARCHAR(20),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE clinics_addresses (
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

CREATE TABLE specialties (
    specialty_id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    specialty_name  VARCHAR(50) NOT NULL UNIQUE
);

-- Sin clinic_id: las especialidades son globales y esta tabla solo se lee a través del profesional.
CREATE TABLE specialties_per_professionals (
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
CREATE TABLE services (
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
CREATE TABLE services_per_professionals (
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
CREATE TABLE professional_schedules (
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
CREATE TABLE blockades (
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

CREATE TABLE genders (
    gender_id       SMALLINT PRIMARY KEY,
    gender_name     VARCHAR(30) NOT NULL UNIQUE
);

-- RF14: no son usuarios del sistema ni tienen credenciales.
CREATE TABLE patients (
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

CREATE TABLE contact_types (
    contact_type_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contact_type_name VARCHAR(50) NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

-- Dato sensible: toda lectura y escritura se registra en la bitácora (RF18).
CREATE TABLE patient_contacts (
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

CREATE TABLE professional_contacts (
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
CREATE TABLE appointment_statuses (
    appointment_status_id SMALLINT PRIMARY KEY,
    status_name     VARCHAR(12) NOT NULL UNIQUE,
    is_final        BOOLEAN NOT NULL                  -- los estados finales no admiten salida (RF13)
);

CREATE TABLE appointments (
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
CREATE TABLE clinical_notes (
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

CREATE TABLE event_types (
    event_type_id   SMALLINT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(150) NOT NULL
);

CREATE TABLE data_objects (
    data_object_id  SMALLINT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(100) NOT NULL
);

CREATE TABLE severities (
    severity_id     SMALLINT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(100) NOT NULL
);

-- RF18 / RF19: append-only, protegida en el motor (I6).
CREATE TABLE audit_logs (
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
    FOREIGN KEY (clinic_id, user_id)    REFERENCES users (clinic_id, user_id),
    FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, patient_id)
);

CREATE TABLE system_errors_logs (
    error_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    severity_id     SMALLINT NOT NULL REFERENCES severities,
    process_uuid    UUID,
    process_name    VARCHAR(100) NOT NULL,
    step_name       VARCHAR(100),
    input_data      JSONB,
    error_message   TEXT NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- FKs de updated_by que no se pudieron declarar antes por la referencia circular.
ALTER TABLE roles   ADD FOREIGN KEY (updated_by) REFERENCES users DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE clinics ADD FOREIGN KEY (updated_by) REFERENCES users DEFERRABLE INITIALLY DEFERRED;


-- =============================================================================
-- TRIGGERS
-- PostgreSQL dispara los triggers del mismo evento en orden alfabético de nombre;
-- por eso los de appointments llevan número (10, 20, 30).
-- =============================================================================

-- updated_at se mantiene solo, en toda tabla que lo tenga.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'updated_at'
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END LOOP;
END $$;


-- I4: la duración la decide el servicio. Al insertar se ignora el fin que mande la
-- aplicación y se calcula; después, la cita no se mueve (para moverla se reprograma).
CREATE FUNCTION appointments_set_period() RETURNS trigger
LANGUAGE plpgsql AS $$
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
-- Concurrencia: los bloques de horario usados se bloquean FOR SHARE hasta el commit,
-- de modo que nadie puede borrarlos ni recortarlos mientras la reserva no termine
-- (ver professional_schedules_guard). Un bloqueo (blockade) creado al mismo tiempo
-- no se impide: RF6 dice que un bloqueo no cancela citas, las deja como conflicto.
--
-- SECURITY DEFINER: FOR SHARE exige permiso UPDATE sobre la tabla, que recepción no
-- tiene; la función corre como su dueño (mc_owner) con un search_path fijo.
CREATE FUNCTION appointments_check_agenda() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_working tstzmultirange;
BEGIN
    PERFORM 1
       FROM professional_schedules
      WHERE professional_id = NEW.professional_id
        AND period && NEW.period
        FOR SHARE;

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
CREATE FUNCTION appointments_check_status() RETURNS trigger
LANGUAGE plpgsql AS $$
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
CREATE FUNCTION professional_schedules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
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
CREATE FUNCTION audit_logs_append_only() RETURNS trigger
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

COMMIT;
