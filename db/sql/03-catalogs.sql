-- =============================================================================
-- MediCitas · Catálogos fijos
--
-- Valores que el esquema y el código usan por id (los CHECK y triggers comparan
-- contra role_id = 1, appointment_status_id = 4, etc.), así que forman parte del
-- esquema y no de los datos de demostración. Los datos de demostración (clínicas,
-- profesionales, pacientes, citas) van en otro script.
-- =============================================================================

BEGIN;

-- roles y el usuario Sistema se referencian mutuamente: las FKs de updated_by son
-- DEFERRABLE INITIALLY DEFERRED y se revisan al hacer COMMIT, con ambos ya insertados.
INSERT INTO roles (role_id, role_name, description, updated_by) VALUES
    (1, 'platform_admin', 'Administrador de plataforma', 1),
    (2, 'clinic_admin',   'Administrador de clínica',    1),
    (3, 'reception',      'Recepción',                   1),
    (4, 'professional',   'Profesional de salud',        1);

-- Usuario Sistema (user_id 1): autor de los datos iniciales. No puede iniciar sesión:
-- está inactivo y su keycloak_sub es el UUID nulo, que ningún token trae.
INSERT INTO users (user_id, keycloak_sub, clinic_id, role_id, name, last_name, is_active, updated_by)
OVERRIDING SYSTEM VALUE
VALUES (1, '00000000-0000-0000-0000-000000000000', NULL, 1, 'Sistema', 'MediCitas', false, 1);

-- Se insertó el id 1 a mano; la identidad debe continuar en 2. (Con setval y no con
-- ALTER TABLE, que no se permite mientras hay revisiones de FKs diferidas pendientes.)
SELECT setval(pg_get_serial_sequence('users', 'user_id'), 1);

INSERT INTO appointment_statuses (appointment_status_id, status_name, is_final) VALUES
    (1, 'reservada',    false),
    (2, 'atendida',     true),
    (3, 'ausente',      true),
    (4, 'cancelada',    true),
    (5, 'reprogramada', true);

INSERT INTO genders (gender_id, gender_name) VALUES
    (1, 'femenino'),
    (2, 'masculino'),
    (3, 'otro'),
    (4, 'prefiere no decir');

INSERT INTO contact_types (contact_type_name, updated_by) VALUES
    ('telefono', 1),
    ('email',    1);

INSERT INTO event_types (event_type_id, name, description) VALUES
    (1, 'read',   'Lectura del dato'),
    (2, 'create', 'Creación del dato'),
    (3, 'update', 'Modificación del dato'),
    (4, 'delete', 'Baja lógica del dato');

INSERT INTO data_objects (data_object_id, name, description) VALUES
    (1, 'clinical_note',   'Nota clínica de una cita'),
    (2, 'patient_contact', 'Dato de contacto de un paciente');

INSERT INTO severities (severity_id, name, description) VALUES
    (1, 'info',     'Evento informativo'),
    (2, 'warning',  'Situación anómala que no interrumpe la operación'),
    (3, 'error',    'Falla de una operación'),
    (4, 'critical', 'Falla que compromete el servicio');

-- Permisos del dominio (RF17: el backend traduce el rol del token a estos permisos).
-- Los sufijos _own indican que el backend además filtra por el usuario del token.
INSERT INTO permissions (permission_name, description, updated_by) VALUES
    ('clinics.create',           'Dar de alta clínicas (RF1)',                                     1),
    ('users.manage',             'Gestionar los usuarios de la clínica (RF2)',                      1),
    ('services.manage',          'Mantener el catálogo de servicios (RF3)',                         1),
    ('professionals.manage',     'Registrar profesionales y asociarles servicios (RF4)',            1),
    ('schedules.manage',         'Horarios y bloqueos de cualquier profesional de la clínica (RF5, RF6)', 1),
    ('schedules.manage_own',     'Horarios y bloqueos propios (RF5, RF6)',                          1),
    ('availability.read',        'Consultar disponibilidad (RF7, RF8)',                             1),
    ('appointments.manage',      'Reservar, reprogramar y cancelar citas (RF9 a RF11)',             1),
    ('appointments.outcome',     'Registrar el desenlace de una cita (RF12)',                       1),
    ('patients.write',           'Registrar y actualizar pacientes (RF14)',                         1),
    ('patients.read',            'Consultar pacientes (RF14)',                                      1),
    ('clinical_notes.write_own', 'Redactar la nota clínica de las citas propias (RF15)',            1),
    ('patient_history.read',     'Consultar el historial de citas de un paciente (RF16)',           1),
    ('audit.read',               'Consultar la bitácora de auditoría (RF19)',                       1),
    ('agenda.read',              'Consultar la agenda del día (RF20)',                              1),
    ('reports.read',             'Contar citas por estado en un rango de fechas (RF21)',            1);

-- Matriz de permisos del enunciado. RF20 y RF21 no aparecen en ella: es una
-- ampliación del grupo (agenda para los tres roles de clínica, conteo solo para el admin).
INSERT INTO permissions_per_roles (role_id, permission_id, updated_by)
SELECT r.role_id, p.permission_id, 1
  FROM (VALUES
        ('platform_admin', 'clinics.create'),
        ('clinic_admin',   'users.manage'),
        ('clinic_admin',   'services.manage'),
        ('clinic_admin',   'professionals.manage'),
        ('clinic_admin',   'schedules.manage'),
        ('clinic_admin',   'availability.read'),
        ('clinic_admin',   'appointments.manage'),
        ('clinic_admin',   'appointments.outcome'),
        ('clinic_admin',   'patients.write'),
        ('clinic_admin',   'patients.read'),
        ('clinic_admin',   'patient_history.read'),
        ('clinic_admin',   'audit.read'),
        ('clinic_admin',   'agenda.read'),
        ('clinic_admin',   'reports.read'),
        ('reception',      'availability.read'),
        ('reception',      'appointments.manage'),
        ('reception',      'appointments.outcome'),
        ('reception',      'patients.write'),
        ('reception',      'patients.read'),
        ('reception',      'patient_history.read'),
        ('reception',      'agenda.read'),
        ('professional',   'schedules.manage_own'),
        ('professional',   'availability.read'),
        ('professional',   'appointments.outcome'),
        ('professional',   'patients.read'),
        ('professional',   'clinical_notes.write_own'),
        ('professional',   'patient_history.read'),
        ('professional',   'agenda.read')
       ) AS m (role_name, permission_name)
  JOIN roles r       ON r.role_name = m.role_name
  JOIN permissions p ON p.permission_name = m.permission_name;

COMMIT;