-- =============================================================================
-- MediCitas · Permisos de los roles de base de datos (menor privilegio)
--
-- Los roles mc_platform, mc_clinic_admin, mc_reception y mc_professional los crea
-- db/init/00-init.sh (crear roles exige ser superusuario). Aquí mc_owner, como
-- dueño de las tablas, les concede permisos según la matriz del README.
-- mc_app no recibe nada directo: en cada transacción hace SET LOCAL ROLE.
-- =============================================================================

BEGIN;

-- Las funciones nacen ejecutables por PUBLIC; los triggers no necesitan ese permiso.
-- (Se nombran una por una: "ALL FUNCTIONS" incluiría las de btree_gist, que no son de mc_owner.)
REVOKE EXECUTE ON FUNCTION set_updated_at(), appointments_set_period(), appointments_check_agenda(),
                           appointments_check_status(), professional_schedules_guard(), audit_logs_append_only()
   FROM PUBLIC;

-- Catálogos y geografía: lectura para todos.
GRANT SELECT ON roles, permissions, permissions_per_roles, specialties, genders,
                contact_types, appointment_statuses, event_types, data_objects, severities,
                countries, states, cities, addresses, clinics_addresses
   TO mc_platform, mc_clinic_admin, mc_reception, mc_professional;

-- RF1: el administrador de plataforma da de alta clínicas, su dirección y su primer administrador.
GRANT SELECT, INSERT, UPDATE ON clinics TO mc_platform;
GRANT INSERT, UPDATE ON addresses, clinics_addresses TO mc_platform;
GRANT SELECT ON clinics TO mc_clinic_admin, mc_reception, mc_professional;

-- RF2
GRANT SELECT, INSERT         ON users TO mc_platform;
GRANT SELECT, INSERT, UPDATE ON users TO mc_clinic_admin;
GRANT SELECT                 ON users TO mc_reception, mc_professional;

-- RF3, RF4
GRANT SELECT, INSERT, UPDATE ON services TO mc_clinic_admin;
GRANT SELECT                 ON services TO mc_reception, mc_professional;

GRANT SELECT, INSERT, UPDATE, DELETE
   ON professionals, specialties_per_professionals, services_per_professionals, professional_contacts
   TO mc_clinic_admin;
GRANT SELECT
   ON professionals, specialties_per_professionals, services_per_professionals, professional_contacts
   TO mc_reception, mc_professional;

-- RF5, RF6 ("solo los propios" para el profesional lo filtra el backend)
GRANT SELECT, INSERT, UPDATE, DELETE ON professional_schedules, blockades TO mc_clinic_admin, mc_professional;
GRANT SELECT                         ON professional_schedules, blockades TO mc_reception;

-- RF14
GRANT SELECT, INSERT, UPDATE ON patients, patient_contacts TO mc_clinic_admin, mc_reception;
GRANT SELECT                 ON patients, patient_contacts TO mc_professional;

-- RF9 a RF13. El UPDATE se limita a estas columnas: nadie puede cambiar period ni service_id (I4).
GRANT SELECT, INSERT ON appointments TO mc_clinic_admin, mc_reception;
GRANT SELECT         ON appointments TO mc_professional;
GRANT UPDATE (appointment_status_id, cancel_reason, cancelled_by, cancelled_at, updated_at, updated_by)
   ON appointments TO mc_clinic_admin, mc_reception, mc_professional;

-- RF15: solo el profesional ("solo de citas propias" lo filtra el backend).
GRANT SELECT, INSERT, UPDATE ON clinical_notes TO mc_professional;

-- RF18, RF19: nadie tiene UPDATE, DELETE ni TRUNCATE (I6).
GRANT SELECT, INSERT ON audit_logs TO mc_clinic_admin;
GRANT INSERT         ON audit_logs TO mc_reception, mc_professional;

GRANT INSERT ON system_errors_logs TO mc_platform, mc_clinic_admin, mc_reception, mc_professional;

COMMIT;
