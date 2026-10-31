-- =============================================================================
-- MediCitas · Descripciones del diccionario de datos
--
-- Las descripciones de tablas, columnas, restricciones, índices y triggers se
-- guardan en la propia base (COMMENT ON). Así las muestra \d+ en psql y
-- db/tools/generar-diccionario.sh las combina con el catálogo (tipos, nulos,
-- llaves) para escribir docs/diccionario-datos.md.
-- =============================================================================

BEGIN;

-- Columnas de control: misma descripción en todas las tablas que las tienen.
-- Las que necesitan algo más específico se sobrescriben más abajo.
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND column_name IN ('is_active', 'created_at', 'updated_at', 'updated_by')
    LOOP
        EXECUTE format('COMMENT ON COLUMN %I.%I IS %L', c.table_name, c.column_name,
            CASE c.column_name
                WHEN 'is_active'  THEN 'Baja lógica: false retira el registro sin borrarlo, para no romper las referencias históricas.'
                WHEN 'created_at' THEN 'Instante de creación del registro.'
                WHEN 'updated_at' THEN 'Instante de la última modificación; lo mantiene el trigger trg_set_updated_at.'
                WHEN 'updated_by' THEN 'Usuario que hizo la última modificación (1 = Sistema en los datos iniciales).'
            END);
    END LOOP;
END $$;


-- =============================================================================
-- USUARIOS Y CLÍNICAS
-- =============================================================================

COMMENT ON TABLE clinics IS
    'Clínicas cliente de la plataforma (RF1). Cada clínica es un tenant: su clinic_id aparece en todas las tablas de datos de la clínica.';
COMMENT ON COLUMN clinics.clinic_id   IS 'Identificador interno de la clínica.';
COMMENT ON COLUMN clinics.clinic_code IS 'Identificador de negocio de la clínica (RF1), único en la plataforma. Ej. CR-SJ-001.';
COMMENT ON COLUMN clinics.clinic_name IS 'Nombre comercial de la clínica.';
COMMENT ON COLUMN clinics.time_zone   IS 'Zona horaria IANA (ej. America/Costa_Rica). Convierte las horas locales de la clínica en instantes absolutos; el backend la valida contra pg_timezone_names.';

COMMENT ON TABLE users IS
    'Usuarios del personal (RF2). Las credenciales viven en Keycloak: aquí solo se guarda el sub del token, la clínica y el rol. Tenant: clinic_id, NULL solo para el administrador de plataforma.';
COMMENT ON COLUMN users.user_id      IS 'Identificador interno del usuario. El 1 es el usuario Sistema, autor de los datos iniciales, que no puede iniciar sesión.';
COMMENT ON COLUMN users.keycloak_sub IS 'Claim sub del token de Keycloak. Es la llave con que el backend asocia cada identidad con su clínica y su rol.';
COMMENT ON COLUMN users.clinic_id    IS 'Clínica a la que pertenece el usuario. NULL si y solo si es administrador de plataforma.';
COMMENT ON COLUMN users.role_id      IS 'Rol del usuario dentro de su clínica.';
COMMENT ON COLUMN users.name         IS 'Nombre o nombres.';
COMMENT ON COLUMN users.last_name    IS 'Apellidos.';
COMMENT ON COLUMN users.is_active    IS 'Baja lógica (RF2): un usuario inactivo no opera aunque Keycloak le emita un token. No se borra porque citas, notas y bitácora lo referencian.';
COMMENT ON CONSTRAINT ck_users_platform_admin ON users IS 'El administrador de plataforma, y solo él, no pertenece a ninguna clínica (RF2).';
COMMENT ON CONSTRAINT uq_users_clinic_user    ON users IS 'Destino de las FKs compuestas (clinic_id, user_id) que obligan a que el usuario sea de la misma clínica (I5).';
COMMENT ON CONSTRAINT uq_users_user_role      ON users IS 'Destino de la FK de professionals que verifica el rol.';

COMMENT ON TABLE roles IS
    'Roles de la aplicación, con ids fijos porque los CHECK y el backend los usan como constantes. Catálogo global.';
COMMENT ON COLUMN roles.role_id     IS 'Id fijo del rol: 1 platform_admin, 2 clinic_admin, 3 reception, 4 professional.';
COMMENT ON COLUMN roles.role_name   IS 'Nombre técnico; es el mismo rol de realm que viaja en el token de Keycloak.';
COMMENT ON COLUMN roles.description IS 'Nombre legible del rol.';

COMMENT ON TABLE professionals IS
    'Datos de los usuarios con rol professional (RF4): especialización 1:1 de users. No lleva clinic_id; la clínica se toma de users.';
COMMENT ON COLUMN professionals.user_id        IS 'Usuario que es profesional. En las demás tablas esta misma llave se llama professional_id.';
COMMENT ON COLUMN professionals.role_id        IS 'Siempre 4. Existe solo para la FK (user_id, role_id) que garantiza que el usuario tiene rol professional.';
COMMENT ON COLUMN professionals.license_number IS 'Número de colegiado o código profesional.';
COMMENT ON CONSTRAINT ck_professionals_role      ON professionals IS 'role_id siempre vale 4 (professional).';
COMMENT ON CONSTRAINT fk_professionals_user_role ON professionals IS 'Solo un usuario con rol professional puede estar aquí. Mientras lo sea, tampoco se le puede cambiar el rol en users: el par (user_id, 4) sigue referenciado.';

COMMENT ON TABLE permissions IS
    'Permisos del dominio (RF17). El backend traduce el rol del token a estos permisos. Catálogo global.';
COMMENT ON COLUMN permissions.permission_id   IS 'Identificador del permiso.';
COMMENT ON COLUMN permissions.permission_name IS 'Nombre técnico que usa el código, con forma recurso.acción. El sufijo _own indica que además se filtra por el usuario del token.';
COMMENT ON COLUMN permissions.description     IS 'Qué permite y a qué requisito funcional corresponde.';

COMMENT ON TABLE permissions_per_roles IS
    'Matriz de permisos: qué permisos tiene cada rol (RF17). Catálogo global.';
COMMENT ON COLUMN permissions_per_roles.permission_per_role_id IS 'Identificador de la asignación.';
COMMENT ON COLUMN permissions_per_roles.role_id                IS 'Rol que recibe el permiso.';
COMMENT ON COLUMN permissions_per_roles.permission_id          IS 'Permiso otorgado.';


-- =============================================================================
-- GEOGRAFÍA
-- =============================================================================

COMMENT ON TABLE countries IS 'Países de las direcciones de las clínicas. Catálogo global.';
COMMENT ON COLUMN countries.country_id   IS 'Identificador del país.';
COMMENT ON COLUMN countries.iso_code     IS 'Código ISO 3166-1 alfa-3 (ej. CRI, COL).';
COMMENT ON COLUMN countries.country_name IS 'Nombre del país.';

COMMENT ON TABLE states IS 'Primera división administrativa de un país (provincia, departamento, estado). Catálogo global.';
COMMENT ON COLUMN states.state_id   IS 'Identificador de la provincia o estado.';
COMMENT ON COLUMN states.country_id IS 'País al que pertenece.';
COMMENT ON COLUMN states.state_name IS 'Nombre de la provincia o estado.';

COMMENT ON TABLE cities IS 'Ciudades o cantones. Catálogo global.';
COMMENT ON COLUMN cities.city_id   IS 'Identificador de la ciudad.';
COMMENT ON COLUMN cities.state_id  IS 'Provincia o estado al que pertenece.';
COMMENT ON COLUMN cities.city_name IS 'Nombre de la ciudad.';

COMMENT ON TABLE addresses IS 'Direcciones físicas.';
COMMENT ON COLUMN addresses.address_id IS 'Identificador de la dirección.';
COMMENT ON COLUMN addresses.city_id    IS 'Ciudad de la dirección.';
COMMENT ON COLUMN addresses.address    IS 'Señas o línea de dirección.';
COMMENT ON COLUMN addresses.zip_code   IS 'Código postal; NULL donde no se usa.';

COMMENT ON TABLE clinics_addresses IS
    'Direcciones de cada clínica. Es una tabla aparte porque una clínica puede tener varias sedes o cambiar de dirección sin perder el historial.';
COMMENT ON COLUMN clinics_addresses.clinic_address_id IS 'Identificador de la asociación.';
COMMENT ON COLUMN clinics_addresses.clinic_id         IS 'Clínica.';
COMMENT ON COLUMN clinics_addresses.address_id        IS 'Dirección de la clínica.';


-- =============================================================================
-- ESPECIALIDADES Y SERVICIOS
-- =============================================================================

COMMENT ON TABLE specialties IS 'Especialidades médicas (ej. Medicina General, Pediatría). Catálogo global compartido por todas las clínicas.';
COMMENT ON COLUMN specialties.specialty_id   IS 'Identificador de la especialidad.';
COMMENT ON COLUMN specialties.specialty_name IS 'Nombre de la especialidad.';

COMMENT ON TABLE specialties_per_professionals IS
    'Especialidades de cada profesional (RF4). Sin clinic_id: la especialidad es global y la fila solo se alcanza a través del profesional, que sí es de una clínica.';
COMMENT ON COLUMN specialties_per_professionals.specialty_per_professional_id IS 'Identificador de la asociación.';
COMMENT ON COLUMN specialties_per_professionals.professional_id               IS 'Profesional.';
COMMENT ON COLUMN specialties_per_professionals.specialty_id                  IS 'Especialidad que tiene el profesional.';

COMMENT ON TABLE services IS
    'Catálogo de servicios de la clínica (RF3). La duración del servicio decide el tamaño de la cita (I4). Tenant: clinic_id.';
COMMENT ON COLUMN services.service_id       IS 'Identificador del servicio.';
COMMENT ON COLUMN services.clinic_id        IS 'Clínica dueña del servicio.';
COMMENT ON COLUMN services.service_name     IS 'Nombre del servicio (ej. Consulta general).';
COMMENT ON COLUMN services.duration_minutes IS 'Duración en minutos, mayor que 0. Con este valor el trigger de citas calcula el fin de cada cita (I4).';
COMMENT ON COLUMN services.specialty_id     IS 'Especialidad que se requiere para atender el servicio.';
COMMENT ON CONSTRAINT services_duration_minutes_check ON services IS 'La duración es positiva.';
COMMENT ON CONSTRAINT uq_services_clinic_service      ON services IS 'Destino de las FKs compuestas (clinic_id, service_id) que obligan a que el servicio sea de la misma clínica (I5).';

COMMENT ON TABLE services_per_professionals IS
    'Servicios que cada profesional está habilitado para atender (RF4). Una cita solo puede reservar una combinación que esté aquí. Tenant: clinic_id.';
COMMENT ON COLUMN services_per_professionals.service_per_professional_id IS 'Identificador de la asociación.';
COMMENT ON COLUMN services_per_professionals.clinic_id                   IS 'Clínica. La comparten las FKs al profesional y al servicio, así que ambos son de la misma clínica (I5).';
COMMENT ON COLUMN services_per_professionals.professional_id             IS 'Profesional habilitado.';
COMMENT ON COLUMN services_per_professionals.service_id                  IS 'Servicio que puede atender.';
COMMENT ON CONSTRAINT uq_spp_clinic_prof_service ON services_per_professionals IS 'No se asocia dos veces el mismo servicio al mismo profesional. Es el destino de la FK desde appointments.';


-- =============================================================================
-- AGENDA
-- =============================================================================

COMMENT ON TABLE professional_schedules IS
    'Bloques concretos de atención de cada profesional (RF5); puede haber varios por día, por ejemplo mañana y tarde. Se definen en la hora local de la clínica y se guardan como instantes absolutos. Tenant: clinic_id.';
COMMENT ON COLUMN professional_schedules.schedule_id     IS 'Identificador del bloque.';
COMMENT ON COLUMN professional_schedules.clinic_id       IS 'Clínica del profesional.';
COMMENT ON COLUMN professional_schedules.professional_id IS 'Profesional que atiende en el bloque.';
COMMENT ON COLUMN professional_schedules.period          IS 'Intervalo [inicio, fin) del bloque de atención.';
COMMENT ON CONSTRAINT ck_schedules_period  ON professional_schedules IS 'El intervalo es finito, no vacío y de la forma [inicio, fin).';
COMMENT ON CONSTRAINT ex_schedules_overlap ON professional_schedules IS 'Un profesional no tiene dos bloques de horario solapados.';

COMMENT ON TABLE blockades IS
    'Bloqueos de agenda por vacaciones, permisos u otras ausencias (RF6). Retiran disponibilidad, pero no cancelan citas: las reservadas que caen dentro se listan como conflicto. Tenant: clinic_id.';
COMMENT ON COLUMN blockades.blockade_id     IS 'Identificador del bloqueo.';
COMMENT ON COLUMN blockades.clinic_id       IS 'Clínica del profesional.';
COMMENT ON COLUMN blockades.professional_id IS 'Profesional ausente.';
COMMENT ON COLUMN blockades.period          IS 'Intervalo [inicio, fin) de la ausencia. Puede solaparse con otros bloqueos.';
COMMENT ON COLUMN blockades.reason          IS 'Motivo de la ausencia (ej. Vacaciones); opcional.';
COMMENT ON CONSTRAINT ck_blockades_period ON blockades IS 'El intervalo es finito, no vacío y de la forma [inicio, fin).';

COMMENT ON TABLE professional_contacts IS
    'Datos de contacto de los profesionales, para que recepción pueda ubicarlos. Separada de patient_contacts porque estos datos no van a la bitácora (RF18 solo aplica a pacientes). Tenant: clinic_id.';
COMMENT ON COLUMN professional_contacts.contact_id      IS 'Identificador del contacto.';
COMMENT ON COLUMN professional_contacts.clinic_id       IS 'Clínica del profesional.';
COMMENT ON COLUMN professional_contacts.professional_id IS 'Profesional.';
COMMENT ON COLUMN professional_contacts.contact_type_id IS 'Tipo de contacto (teléfono o correo).';
COMMENT ON COLUMN professional_contacts.contact_value   IS 'Número de teléfono o dirección de correo.';


-- =============================================================================
-- PACIENTES
-- =============================================================================

COMMENT ON TABLE genders IS 'Géneros que puede indicar un paciente. Ids fijos.';
COMMENT ON COLUMN genders.gender_id   IS 'Id fijo del género.';
COMMENT ON COLUMN genders.gender_name IS 'Nombre del género.';

COMMENT ON TABLE patients IS
    'Pacientes de la clínica (RF14). No son usuarios del sistema ni tienen credenciales. Una misma persona atendida en dos clínicas son dos filas independientes, una por clínica (I5). Tenant: clinic_id.';
COMMENT ON COLUMN patients.patient_id     IS 'Identificador del paciente.';
COMMENT ON COLUMN patients.clinic_id      IS 'Clínica que registró al paciente.';
COMMENT ON COLUMN patients.identification IS 'Número de identificación (cédula, pasaporte); único dentro de la clínica.';
COMMENT ON COLUMN patients.name           IS 'Nombre o nombres.';
COMMENT ON COLUMN patients.last_name      IS 'Apellidos.';
COMMENT ON COLUMN patients.birth_date     IS 'Fecha de nacimiento.';
COMMENT ON COLUMN patients.gender_id      IS 'Género; NULL si el paciente no lo indica.';
COMMENT ON CONSTRAINT uq_patients_clinic_identification ON patients IS 'Una identificación no se repite dentro de la clínica; en otra clínica sí puede existir.';
COMMENT ON CONSTRAINT uq_patients_clinic_patient        ON patients IS 'Destino de las FKs compuestas (clinic_id, patient_id) que obligan a que el paciente sea de la misma clínica (I5).';

COMMENT ON TABLE contact_types IS 'Tipos de dato de contacto. Catálogo global.';
COMMENT ON COLUMN contact_types.contact_type_id   IS 'Identificador del tipo de contacto.';
COMMENT ON COLUMN contact_types.contact_type_name IS 'Nombre del tipo de contacto.';

COMMENT ON TABLE patient_contacts IS
    'Datos de contacto de los pacientes (RF14). Dato sensible: toda lectura y escritura se registra en audit_logs (RF18). Tenant: clinic_id.';
COMMENT ON COLUMN patient_contacts.contact_id      IS 'Identificador del contacto.';
COMMENT ON COLUMN patient_contacts.clinic_id       IS 'Clínica del paciente.';
COMMENT ON COLUMN patient_contacts.patient_id      IS 'Paciente.';
COMMENT ON COLUMN patient_contacts.contact_type_id IS 'Tipo de contacto (teléfono o correo).';
COMMENT ON COLUMN patient_contacts.contact_value   IS 'Número de teléfono o dirección de correo. Hasta 320 caracteres, el máximo de un correo (RFC 5321).';


-- =============================================================================
-- CITAS
-- =============================================================================

COMMENT ON TABLE appointment_statuses IS 'Estados de una cita (RF13), con ids fijos porque los triggers y los CHECK los usan como constantes.';
COMMENT ON COLUMN appointment_statuses.appointment_status_id IS 'Id fijo del estado: 1 reservada, 2 atendida, 3 ausente, 4 cancelada, 5 reprogramada.';
COMMENT ON COLUMN appointment_statuses.status_name           IS 'Nombre del estado.';
COMMENT ON COLUMN appointment_statuses.is_final              IS 'true si el estado no admite salida; lo son todos menos reservada.';

COMMENT ON TABLE appointments IS
    'Citas (RF9 a RF13). Solo las reservadas ocupan espacio en la agenda. Una cita no se mueve: reprogramar crea una cita nueva y deja esta como reprogramada (RF10). Tenant: clinic_id.';
COMMENT ON COLUMN appointments.appointment_id          IS 'Identificador de la cita. BIGINT porque es la tabla de mayor volumen.';
COMMENT ON COLUMN appointments.clinic_id               IS 'Clínica de la cita. La comparten todas las FKs compuestas, así que paciente, profesional, servicio y cancelador son de esta clínica (I5).';
COMMENT ON COLUMN appointments.patient_id              IS 'Paciente.';
COMMENT ON COLUMN appointments.professional_id         IS 'Profesional que atiende.';
COMMENT ON COLUMN appointments.service_id              IS 'Servicio reservado; su duración define la de la cita (I4).';
COMMENT ON COLUMN appointments.appointment_status_id   IS 'Estado actual; toda cita nace reservada (1). Las transiciones las controla trg_appointments_30_check_status.';
COMMENT ON COLUMN appointments.period                  IS 'Intervalo [inicio, fin). La API envía solo el inicio y el trigger trg_appointments_10_set_period calcula el fin con la duración del servicio (I4).';
COMMENT ON COLUMN appointments.appointment_description IS 'Motivo de la consulta; opcional.';
COMMENT ON COLUMN appointments.cancel_reason           IS 'Motivo de la cancelación (RF11). Presente si y solo si la cita está cancelada.';
COMMENT ON COLUMN appointments.cancelled_by            IS 'Usuario que canceló (RF11), de la misma clínica. Presente si y solo si la cita está cancelada.';
COMMENT ON COLUMN appointments.cancelled_at            IS 'Instante de la cancelación (RF11). Presente si y solo si la cita está cancelada.';
COMMENT ON COLUMN appointments.rescheduled_from_id     IS 'En una cita creada al reprogramar, la cita original que reemplaza (RF10).';
COMMENT ON CONSTRAINT ck_appointments_period             ON appointments IS 'El intervalo es finito, no vacío y de la forma [inicio, fin).';
COMMENT ON CONSTRAINT ck_appointments_cancellation       ON appointments IS 'Cancelada si y solo si están los tres datos de la cancelación (RF11); en cualquier otro estado los tres van vacíos.';
COMMENT ON CONSTRAINT ex_appointments_professional       ON appointments IS 'I1: un profesional no tiene dos citas reservadas solapadas. El motor lo garantiza también entre transacciones concurrentes.';
COMMENT ON CONSTRAINT ex_appointments_patient            ON appointments IS 'I2: un paciente no tiene dos citas reservadas solapadas.';
COMMENT ON CONSTRAINT uq_appointments_clinic_appointment ON appointments IS 'Destino de las FKs compuestas (clinic_id, appointment_id) que obligan a que la cita sea de la misma clínica (I5).';
COMMENT ON CONSTRAINT uq_appointments_rescheduled_from   ON appointments IS 'Una cita se reprograma una sola vez (RF10).';
COMMENT ON CONSTRAINT appointments_clinic_id_professional_id_service_id_fkey ON appointments IS
    'Solo se reserva un servicio que el profesional tiene habilitado (RF4), en la misma clínica.';

COMMENT ON TABLE clinical_notes IS
    'Notas clínicas (RF15), el dato más sensible del sistema. Una por cita atendida, escrita por el profesional de esa cita; el autor no se repite aquí porque ya es appointments.professional_id. Toda lectura y escritura se registra en audit_logs (RF18). Tenant: clinic_id.';
COMMENT ON COLUMN clinical_notes.clinical_note_id IS 'Identificador de la nota.';
COMMENT ON COLUMN clinical_notes.clinic_id        IS 'Clínica de la cita.';
COMMENT ON COLUMN clinical_notes.appointment_id   IS 'Cita que documenta; única porque hay una nota por cita.';
COMMENT ON COLUMN clinical_notes.note_text        IS 'Contenido clínico de la nota.';


-- =============================================================================
-- BITÁCORAS
-- =============================================================================

COMMENT ON TABLE event_types IS 'Acciones que registra la bitácora de auditoría. Ids fijos.';
COMMENT ON COLUMN event_types.event_type_id IS 'Id fijo de la acción.';
COMMENT ON COLUMN event_types.name          IS 'Nombre técnico de la acción.';
COMMENT ON COLUMN event_types.description   IS 'Descripción legible.';

COMMENT ON TABLE data_objects IS 'Tipos de dato sensible que vigila la bitácora de auditoría (RF18). Ids fijos.';
COMMENT ON COLUMN data_objects.data_object_id IS 'Id fijo del tipo de dato.';
COMMENT ON COLUMN data_objects.name           IS 'Nombre técnico del tipo de dato.';
COMMENT ON COLUMN data_objects.description    IS 'Descripción legible.';

COMMENT ON TABLE audit_logs IS
    'Bitácora de auditoría append-only (RF18, RF19): quién leyó o escribió qué dato sensible, de cuál paciente y cuándo. Ningún rol tiene UPDATE, DELETE ni TRUNCATE, y los triggers los rechazan aunque alguien los conceda (I6). Tenant: clinic_id.';
COMMENT ON COLUMN audit_logs.log_id         IS 'Identificador del registro.';
COMMENT ON COLUMN audit_logs.clinic_id      IS 'Clínica donde ocurrió el acceso.';
COMMENT ON COLUMN audit_logs.user_id        IS 'Quién: usuario que hizo el acceso.';
COMMENT ON COLUMN audit_logs.event_type_id  IS 'Qué hizo: lectura, creación, modificación o baja.';
COMMENT ON COLUMN audit_logs.data_object_id IS 'Sobre qué tipo de dato: nota clínica o contacto del paciente.';
COMMENT ON COLUMN audit_logs.object_id      IS 'Id del registro tocado. Sin FK porque apunta a una tabla distinta según data_object_id.';
COMMENT ON COLUMN audit_logs.patient_id     IS 'Sobre cuál paciente.';
COMMENT ON COLUMN audit_logs.description    IS 'Resumen legible del evento.';
COMMENT ON COLUMN audit_logs.metadata       IS 'Detalles adicionales del acceso (ej. ruta o id de la petición); opcional.';
COMMENT ON COLUMN audit_logs.created_at     IS 'Cuándo ocurrió el acceso.';

COMMENT ON TABLE severities IS 'Niveles de gravedad de system_errors_logs. Ids fijos.';
COMMENT ON COLUMN severities.severity_id IS 'Id fijo de la gravedad.';
COMMENT ON COLUMN severities.name        IS 'Nombre técnico de la gravedad.';
COMMENT ON COLUMN severities.description IS 'Descripción legible.';

COMMENT ON TABLE system_errors_logs IS
    'Registro técnico de errores de la aplicación, para diagnóstico. No guarda datos de negocio ni pertenece a una clínica.';
COMMENT ON COLUMN system_errors_logs.error_id      IS 'Identificador del error.';
COMMENT ON COLUMN system_errors_logs.severity_id   IS 'Gravedad.';
COMMENT ON COLUMN system_errors_logs.process_uuid  IS 'Id de correlación de la petición o proceso; opcional.';
COMMENT ON COLUMN system_errors_logs.process_name  IS 'Proceso o ruta donde ocurrió (ej. POST /appointments).';
COMMENT ON COLUMN system_errors_logs.step_name     IS 'Paso dentro del proceso; opcional.';
COMMENT ON COLUMN system_errors_logs.input_data    IS 'Entrada que causó el error, sin datos sensibles; opcional.';
COMMENT ON COLUMN system_errors_logs.error_message IS 'Mensaje del error.';
COMMENT ON COLUMN system_errors_logs.metadata      IS 'Detalles técnicos (ej. SQLSTATE); opcional.';
COMMENT ON COLUMN system_errors_logs.created_at    IS 'Cuándo ocurrió el error.';


-- =============================================================================
-- TRIGGERS
-- =============================================================================

COMMENT ON TRIGGER trg_appointments_10_set_period ON appointments IS
    'I4: al insertar, calcula el fin de la cita con la duración del servicio. Al actualizar, impide mover la cita o cambiarle servicio, profesional, paciente o clínica (MC004).';
COMMENT ON TRIGGER trg_appointments_20_check_agenda ON appointments IS
    'I3: la cita cae dentro del horario del profesional y fuera de sus bloqueos (MC001). Bloquea FOR SHARE los bloques de horario usados hasta el commit.';
COMMENT ON TRIGGER trg_appointments_30_check_status ON appointments IS
    'RF13: toda cita nace reservada y los estados finales no admiten cambios (MC002). RF12: atendida o ausente solo después del inicio (MC003).';
COMMENT ON TRIGGER trg_professional_schedules_guard ON professional_schedules IS
    'I3: no se borra ni se recorta un bloque de horario que deje fuera citas reservadas (MC006).';
COMMENT ON TRIGGER trg_audit_logs_append_only ON audit_logs IS 'I6: rechaza UPDATE y DELETE (MC005).';
COMMENT ON TRIGGER trg_audit_logs_no_truncate ON audit_logs IS 'I6: rechaza TRUNCATE (MC005).';


-- =============================================================================
-- ÍNDICES (los que no nacen de una PK, UNIQUE o EXCLUDE)
-- =============================================================================

COMMENT ON INDEX ix_blockades_prof_period      IS 'RF6 (citas en conflicto con un bloqueo) y RF7 (restar bloqueos a la disponibilidad).';
COMMENT ON INDEX ix_spp_clinic_service         IS 'RF8: profesionales que atienden un servicio.';
COMMENT ON INDEX ix_appointments_clinic_start  IS 'RF20 (agenda del día de la clínica) y RF21 (conteo por estado en un rango de fechas).';
COMMENT ON INDEX ix_appointments_prof_start    IS 'RF20: agenda del día de un profesional, en todos los estados.';
COMMENT ON INDEX ix_appointments_patient_start IS 'RF16: historial de citas de un paciente.';
COMMENT ON INDEX ix_patient_contacts_patient   IS 'RF14 y RF18: contactos de un paciente.';
COMMENT ON INDEX ix_audit_clinic_patient_date  IS 'RF19: bitácora filtrada por paciente y fechas.';
COMMENT ON INDEX ix_audit_clinic_user_date     IS 'RF19: bitácora filtrada por usuario y fechas.';
COMMENT ON INDEX ix_audit_clinic_date          IS 'RF19: bitácora filtrada solo por fechas.';

COMMIT;
