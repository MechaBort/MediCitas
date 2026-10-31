-- =============================================================================
-- MediCitas · Datos de demostración (seed)
--
-- Tres clínicas (dos en Costa Rica y una en Colombia, con otra zona horaria),
-- varios profesionales por clínica, 80 pacientes por clínica y citas repartidas
-- entre 8 semanas atrás y 4 semanas adelante de la fecha en que se inicializa la base.
--
-- Determinista: en vez de random() se usa pg_temp.pick(texto, n), que da siempre el
-- mismo número para el mismo texto. Dos personas que levanten el proyecto el mismo
-- día obtienen exactamente los mismos datos.
--
-- Los keycloak_sub coinciden con los "id" de keycloak/medicitas-realm.json: así cada
-- token de Keycloak se asocia con su fila de users y, por ella, con su clínica.
-- =============================================================================

BEGIN;

-- Elección determinista: un número en [0, n) que depende solo del texto.
CREATE FUNCTION pg_temp.pick(seed TEXT, n INT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$ SELECT (abs(hashtext(seed)::bigint) % n)::int $$;


-- =============================================================================
-- DATOS DE ENTRADA (tablas temporales, se borran al terminar la sesión)
-- =============================================================================

CREATE TEMP TABLE seed_clinics (clinic_code, clinic_name, time_zone, country, state, city, address, zip_code) AS VALUES
    ('CR-SJ-001', 'Clínica Central San José', 'America/Costa_Rica', 'CRI', 'San José',    'San José', 'Avenida 2, entre calles 5 y 7',           '10101'),
    ('CR-CA-001', 'Centro Médico Cartago',    'America/Costa_Rica', 'CRI', 'Cartago',     'Cartago',  '100 m al sur de la Basílica de los Ángeles', '30101'),
    ('CO-BO-001', 'Clínica Norte Bogotá',     'America/Bogota',     'COL', 'Bogotá D.C.', 'Bogotá',   'Calle 127 # 15-40',                       '110121');

CREATE TEMP TABLE seed_services (clinic_code, service_name, duration_minutes, specialty_name) AS VALUES
    ('CR-SJ-001', 'Consulta general',        30, 'Medicina general'),
    ('CR-SJ-001', 'Control pediátrico',      30, 'Pediatría'),
    ('CR-SJ-001', 'Consulta dermatológica',  20, 'Dermatología'),
    ('CR-SJ-001', 'Consulta ginecológica',   40, 'Ginecología'),
    ('CR-CA-001', 'Consulta general',        30, 'Medicina general'),
    ('CR-CA-001', 'Valoración odontológica', 30, 'Odontología'),
    ('CR-CA-001', 'Limpieza dental',         45, 'Odontología'),
    ('CR-CA-001', 'Sesión de psicología',    60, 'Psicología'),
    ('CO-BO-001', 'Consulta general',        20, 'Medicina general'),
    ('CO-BO-001', 'Control prenatal',        40, 'Ginecología'),
    ('CO-BO-001', 'Consulta nutricional',    45, 'Nutrición'),
    ('CO-BO-001', 'Control pediátrico',      30, 'Pediatría');

-- El usuario "sinregistro" existe en Keycloak pero no aquí, a propósito: sirve para
-- probar un token válido que no corresponde a ningún usuario del sistema.
-- "exrecepcion.sanjose" está dado de baja (is_active = false) aunque en Keycloak siga habilitado.
CREATE TEMP TABLE seed_users (username, keycloak_sub, clinic_code, role_id, name, last_name, is_active, license_number, specialties, services) AS VALUES
    ('plataforma',          'c0000000-0000-4000-8000-000000000001'::uuid, NULL::text,  1, 'Ernesto',   'Vega Salas',      true,  NULL::text,    NULL::text[], NULL::text[]),
    ('admin.sanjose',       'c0000001-0000-4000-8000-000000000001',       'CR-SJ-001', 2, 'Gabriela',  'Chaves Ramírez',  true,  NULL, NULL, NULL),
    ('recepcion.sanjose',   'c0000001-0000-4000-8000-000000000002',       'CR-SJ-001', 3, 'Pablo',     'Arias Méndez',    true,  NULL, NULL, NULL),
    ('exrecepcion.sanjose', 'c0000001-0000-4000-8000-000000000003',       'CR-SJ-001', 3, 'Kevin',     'Soto Alfaro',     false, NULL, NULL, NULL),
    ('laura.mora',          'c0000001-0000-4000-8000-000000000011',       'CR-SJ-001', 4, 'Laura',     'Mora Jiménez',    true,  'MED-10482',
        ARRAY['Medicina general'],              ARRAY['Consulta general']),
    ('andres.solis',        'c0000001-0000-4000-8000-000000000012',       'CR-SJ-001', 4, 'Andrés',    'Solís Vargas',    true,  'MED-11237',
        ARRAY['Pediatría', 'Medicina general'], ARRAY['Control pediátrico', 'Consulta general']),
    ('daniela.rojas',       'c0000001-0000-4000-8000-000000000013',       'CR-SJ-001', 4, 'Daniela',   'Rojas Castro',    true,  'MED-09815',
        ARRAY['Dermatología'],                  ARRAY['Consulta dermatológica']),
    ('mariana.quesada',     'c0000001-0000-4000-8000-000000000014',       'CR-SJ-001', 4, 'Mariana',   'Quesada Araya',   true,  'MED-12054',
        ARRAY['Ginecología'],                   ARRAY['Consulta ginecológica']),
    ('admin.cartago',       'c0000002-0000-4000-8000-000000000001',       'CR-CA-001', 2, 'Rodrigo',   'Pereira Coto',    true,  NULL, NULL, NULL),
    ('recepcion.cartago',   'c0000002-0000-4000-8000-000000000002',       'CR-CA-001', 3, 'Natalia',   'Fallas Brenes',   true,  NULL, NULL, NULL),
    ('carlos.brenes',       'c0000002-0000-4000-8000-000000000011',       'CR-CA-001', 4, 'Carlos',    'Brenes Montero',  true,  'MED-08761',
        ARRAY['Medicina general'],              ARRAY['Consulta general']),
    ('sofia.aguilar',       'c0000002-0000-4000-8000-000000000012',       'CR-CA-001', 4, 'Sofía',     'Aguilar Navarro', true,  'ODO-03392',
        ARRAY['Odontología'],                   ARRAY['Valoración odontológica', 'Limpieza dental']),
    ('javier.calderon',     'c0000002-0000-4000-8000-000000000013',       'CR-CA-001', 4, 'Javier',    'Calderón Ulate',  true,  'PSI-05521',
        ARRAY['Psicología'],                    ARRAY['Sesión de psicología']),
    ('admin.bogota',        'c0000003-0000-4000-8000-000000000001',       'CO-BO-001', 2, 'Juliana',   'Martínez Rueda',  true,  NULL, NULL, NULL),
    ('recepcion.bogota',    'c0000003-0000-4000-8000-000000000002',       'CO-BO-001', 3, 'Felipe',    'Castaño Ríos',    true,  NULL, NULL, NULL),
    ('valentina.restrepo',  'c0000003-0000-4000-8000-000000000011',       'CO-BO-001', 4, 'Valentina', 'Restrepo Gómez',  true,  'RM-52814733',
        ARRAY['Medicina general'],              ARRAY['Consulta general']),
    ('santiago.ospina',     'c0000003-0000-4000-8000-000000000012',       'CO-BO-001', 4, 'Santiago',  'Ospina Rincón',   true,  'RM-79455120',
        ARRAY['Ginecología'],                   ARRAY['Control prenatal']),
    ('camila.herrera',      'c0000003-0000-4000-8000-000000000013',       'CO-BO-001', 4, 'Camila',    'Herrera Duque',   true,  'RM-10207448',
        ARRAY['Nutrición'],                     ARRAY['Consulta nutricional']),
    ('mateo.cardenas',      'c0000003-0000-4000-8000-000000000014',       'CO-BO-001', 4, 'Mateo',     'Cárdenas Lozano', true,  'RM-80233417',
        ARRAY['Pediatría'],                     ARRAY['Control pediátrico']);

-- Horario semanal de cada profesional, en hora local de su clínica (isodow: 1 lunes … 7 domingo).
CREATE TEMP TABLE seed_schedule_templates (username, isodows, starts, ends) AS VALUES
    ('laura.mora',         ARRAY[1,2,3,4,5], time '08:00', time '12:00'),
    ('laura.mora',         ARRAY[1,2,3,4,5], time '13:00', time '17:00'),
    ('andres.solis',       ARRAY[1,2,3,4,5], time '08:00', time '12:00'),
    ('andres.solis',       ARRAY[2,4],       time '13:00', time '16:00'),
    ('daniela.rojas',      ARRAY[1,3,5],     time '09:00', time '13:00'),
    ('mariana.quesada',    ARRAY[2,4],       time '08:00', time '12:00'),
    ('mariana.quesada',    ARRAY[2,4],       time '13:00', time '17:00'),
    ('mariana.quesada',    ARRAY[6],         time '08:00', time '12:00'),
    ('carlos.brenes',      ARRAY[1,2,3,4,5], time '08:00', time '12:00'),
    ('carlos.brenes',      ARRAY[1,2,3,4,5], time '13:00', time '17:00'),
    ('sofia.aguilar',      ARRAY[1,2,3,4,5], time '08:00', time '12:00'),
    ('sofia.aguilar',      ARRAY[1,3],       time '13:00', time '17:00'),
    ('javier.calderon',    ARRAY[2,4],       time '14:00', time '20:00'),
    ('javier.calderon',    ARRAY[6],         time '08:00', time '12:00'),
    ('valentina.restrepo', ARRAY[1,2,3,4,5], time '07:00', time '12:00'),
    ('valentina.restrepo', ARRAY[1,2,3,4,5], time '14:00', time '18:00'),
    ('santiago.ospina',    ARRAY[1,3,5],     time '08:00', time '12:00'),
    ('camila.herrera',     ARRAY[2,4],       time '08:00', time '12:00'),
    ('camila.herrera',     ARRAY[2,4],       time '14:00', time '18:00'),
    ('mateo.cardenas',     ARRAY[1,2,3,4,5], time '08:00', time '12:00'),
    ('mateo.cardenas',     ARRAY[3],         time '14:00', time '18:00');

-- Bloqueos (RF6), en hora local. Los de after_booking = true se registran DESPUÉS de
-- generar las citas: las citas reservadas que caen dentro quedan como conflicto para
-- que recepción las reprograme, tal como pide RF6.
CREATE TEMP TABLE seed_blockades (username, first_day, starts, last_day, ends, reason, after_booking) AS VALUES
    ('laura.mora',         current_date + 7,  time '00:00', current_date + 10, time '00:00', 'Vacaciones',                      false),
    ('carlos.brenes',      current_date - 14, time '08:00', current_date - 14, time '12:00', 'Cita médica personal',            false),
    ('valentina.restrepo', current_date + 3,  time '14:00', current_date + 3,  time '18:00', 'Congreso de medicina familiar',   false),
    ('andres.solis',
        (SELECT current_date + k FROM generate_series(10, 16) AS k
          WHERE extract(isodow FROM current_date + k) < 6 ORDER BY k LIMIT 1), time '08:00',
        (SELECT current_date + k FROM generate_series(10, 16) AS k
          WHERE extract(isodow FROM current_date + k) < 6 ORDER BY k LIMIT 1), time '12:00',
        'Capacitación obligatoria', true);


-- =============================================================================
-- GEOGRAFÍA Y CLÍNICAS
-- =============================================================================

INSERT INTO countries (iso_code, country_name, updated_by) VALUES
    ('CRI', 'Costa Rica', 1),
    ('COL', 'Colombia',   1);

INSERT INTO states (country_id, state_name, updated_by)
SELECT DISTINCT co.country_id, sc.state, 1
  FROM seed_clinics sc JOIN countries co ON co.iso_code = sc.country;

INSERT INTO cities (state_id, city_name, updated_by)
SELECT DISTINCT st.state_id, sc.city, 1
  FROM seed_clinics sc JOIN states st ON st.state_name = sc.state;

-- El orden deja San José = 1, Cartago = 2 y Bogotá = 3, como los prefijos de los sub
-- (c0000001…, c0000002…, c0000003…), para que sea fácil reconocerlos.
INSERT INTO clinics (clinic_code, clinic_name, time_zone, updated_by)
SELECT clinic_code, clinic_name, time_zone, 1 FROM seed_clinics ORDER BY clinic_code DESC;

INSERT INTO addresses (city_id, address, zip_code, updated_by)
SELECT ci.city_id, sc.address, sc.zip_code, 1
  FROM seed_clinics sc JOIN cities ci ON ci.city_name = sc.city;

INSERT INTO clinics_addresses (clinic_id, address_id, updated_by)
SELECT c.clinic_id, a.address_id, 1
  FROM seed_clinics sc
  JOIN clinics c   ON c.clinic_code = sc.clinic_code
  JOIN addresses a ON a.address = sc.address;


-- =============================================================================
-- ESPECIALIDADES, SERVICIOS, USUARIOS Y PROFESIONALES
-- =============================================================================

INSERT INTO specialties (specialty_name)
SELECT DISTINCT specialty_name FROM seed_services ORDER BY specialty_name;

INSERT INTO services (clinic_id, service_name, duration_minutes, specialty_id, updated_by)
SELECT c.clinic_id, ss.service_name, ss.duration_minutes, sp.specialty_id, 1
  FROM seed_services ss
  JOIN clinics c      ON c.clinic_code = ss.clinic_code
  JOIN specialties sp ON sp.specialty_name = ss.specialty_name
 ORDER BY c.clinic_id, ss.service_name;

INSERT INTO users (keycloak_sub, clinic_id, role_id, name, last_name, is_active, updated_by)
SELECT su.keycloak_sub, c.clinic_id, su.role_id, su.name, su.last_name, su.is_active, 1
  FROM seed_users su LEFT JOIN clinics c ON c.clinic_code = su.clinic_code
 ORDER BY su.keycloak_sub;

INSERT INTO professionals (user_id, license_number, updated_by)
SELECT u.user_id, su.license_number, 1
  FROM seed_users su JOIN users u USING (keycloak_sub)
 WHERE su.role_id = 4;

INSERT INTO specialties_per_professionals (professional_id, specialty_id, updated_by)
SELECT u.user_id, sp.specialty_id, 1
  FROM seed_users su
  JOIN users u        USING (keycloak_sub)
 CROSS JOIN LATERAL unnest(su.specialties) AS s(specialty_name)
  JOIN specialties sp ON sp.specialty_name = s.specialty_name;

INSERT INTO services_per_professionals (clinic_id, professional_id, service_id, updated_by)
SELECT u.clinic_id, u.user_id, sv.service_id, 1
  FROM seed_users su
  JOIN users u     USING (keycloak_sub)
 CROSS JOIN LATERAL unnest(su.services) AS s(service_name)
  JOIN services sv ON sv.clinic_id = u.clinic_id AND sv.service_name = s.service_name;

INSERT INTO professional_contacts (clinic_id, professional_id, contact_type_id, contact_value, updated_by)
SELECT u.clinic_id, u.user_id, ct.contact_type_id,
       CASE ct.contact_type_name
            WHEN 'email' THEN su.username || '@example.com'
            ELSE CASE WHEN su.clinic_code LIKE 'CR-%' THEN '+506 2200 ' ELSE '+57 601 555 ' END
                 || lpad(u.user_id::text, 4, '0')
       END,
       1
  FROM seed_users su
  JOIN users u USING (keycloak_sub)
 CROSS JOIN contact_types ct
 WHERE su.role_id = 4;


-- =============================================================================
-- PACIENTES (80 por clínica) Y SUS CONTACTOS
-- =============================================================================

INSERT INTO patients (clinic_id, identification, name, last_name, birth_date, gender_id, updated_by)
SELECT b.clinic_id,
       CASE WHEN b.clinic_code LIKE 'CR-%'
            -- Cédula costarricense: provincia-tomo-asiento
            THEN format('%s-%s-%s', 1 + pg_temp.pick(b.k || 'prov', 7),
                        lpad((b.clinic_id * 100 + b.i)::text, 4, '0'),
                        lpad(pg_temp.pick(b.k || 'asiento', 10000)::text, 4, '0'))
            -- Cédula de ciudadanía colombiana
            ELSE (1012000000 + b.i * 7919)::text
       END,
       CASE b.gender_id
            WHEN 1 THEN n.f[1 + pg_temp.pick(b.k || 'nombre', cardinality(n.f))]
            WHEN 2 THEN n.m[1 + pg_temp.pick(b.k || 'nombre', cardinality(n.m))]
            ELSE (n.f || n.m)[1 + pg_temp.pick(b.k || 'nombre', cardinality(n.f) + cardinality(n.m))]
       END,
       n.l[1 + pg_temp.pick(b.k || 'apellido1', cardinality(n.l))] || ' ' ||
       n.l[1 + pg_temp.pick(b.k || 'apellido2', cardinality(n.l))],
       date '1940-01-01' + pg_temp.pick(b.k || 'nacimiento', 30000),
       b.gender_id,
       1
  FROM (SELECT x.*,
               CASE WHEN x.g < 48 THEN 1 WHEN x.g < 96 THEN 2 WHEN x.g < 98 THEN 3 WHEN x.g < 99 THEN 4 END AS gender_id
          FROM (SELECT c.clinic_id, c.clinic_code, i, c.clinic_code || ':' || i || ':' AS k,
                       pg_temp.pick(c.clinic_code || ':' || i || ':genero', 100) AS g
                  FROM clinics c CROSS JOIN generate_series(1, 80) AS i) x) b
 CROSS JOIN (SELECT
        ARRAY['María','Ana','Sofía','Valeria','Camila','Daniela','Gabriela','Lucía','Isabella','Mariana',
              'Paula','Andrea','Laura','Fernanda','Carolina','Natalia','Adriana','Patricia','Rosa','Elena',
              'Silvia','Verónica','Mónica','Alejandra','Juliana'] AS f,
        ARRAY['José','Luis','Carlos','Juan','Diego','Andrés','Javier','Miguel','Alejandro','Daniel',
              'Sebastián','Mateo','Santiago','Felipe','Ricardo','Fernando','Jorge','Manuel','Pablo','Esteban',
              'Mauricio','Rodrigo','Óscar','Gustavo','Adrián'] AS m,
        ARRAY['Rodríguez','Vargas','Jiménez','Mora','Rojas','González','Hernández','Castro','Araya','Solís',
              'Chaves','Ramírez','Quesada','Brenes','Alvarado','Calderón','Méndez','Salazar','Montero','Sánchez',
              'Gómez','López','Martínez','Pérez','Díaz','Torres','Ramos','Vega','Navarro','Cordero'] AS l) n
 ORDER BY b.clinic_id, b.i;

-- Teléfono para todos; correo para el 70 %.
INSERT INTO patient_contacts (clinic_id, patient_id, contact_type_id, contact_value, updated_by)
SELECT p.clinic_id, p.patient_id, ct.contact_type_id,
       CASE WHEN c.clinic_code LIKE 'CR-%'
            THEN format('+506 %s%s %s', 6 + pg_temp.pick('tel1:' || p.patient_id, 3),
                        lpad(pg_temp.pick('tel2:' || p.patient_id, 1000)::text, 3, '0'),
                        lpad(pg_temp.pick('tel3:' || p.patient_id, 10000)::text, 4, '0'))
            ELSE format('+57 3%s %s %s', lpad(pg_temp.pick('tel1:' || p.patient_id, 100)::text, 2, '0'),
                        lpad(pg_temp.pick('tel2:' || p.patient_id, 1000)::text, 3, '0'),
                        lpad(pg_temp.pick('tel3:' || p.patient_id, 10000)::text, 4, '0'))
       END,
       1
  FROM patients p
  JOIN clinics c       USING (clinic_id)
  JOIN contact_types ct ON ct.contact_type_name = 'telefono'
 ORDER BY p.patient_id;

INSERT INTO patient_contacts (clinic_id, patient_id, contact_type_id, contact_value, updated_by)
SELECT p.clinic_id, p.patient_id, ct.contact_type_id,
       translate(lower(p.name || '.' || split_part(p.last_name, ' ', 1)), 'áéíóúüñ', 'aeiouun')
           || p.patient_id || '@example.com',
       1
  FROM patients p
  JOIN contact_types ct ON ct.contact_type_name = 'email'
 WHERE pg_temp.pick('correo:' || p.patient_id, 100) < 70
 ORDER BY p.patient_id;


-- =============================================================================
-- AGENDA: BLOQUES DE HORARIO Y BLOQUEOS
-- Los bloques se arman en hora local de la clínica y se guardan como instantes
-- absolutos: (fecha + hora) AT TIME ZONE zona.
-- =============================================================================

INSERT INTO professional_schedules (clinic_id, professional_id, period, updated_by)
SELECT u.clinic_id, u.user_id,
       tstzrange((current_date + k + t.starts) AT TIME ZONE c.time_zone,
                 (current_date + k + t.ends)   AT TIME ZONE c.time_zone),
       1
  FROM seed_schedule_templates t
  JOIN seed_users su USING (username)
  JOIN users u       ON u.keycloak_sub = su.keycloak_sub
  JOIN clinics c     ON c.clinic_id = u.clinic_id
 CROSS JOIN generate_series(-56, 27) AS k
 WHERE extract(isodow FROM current_date + k) = ANY (t.isodows)
 ORDER BY u.user_id, k, t.starts;

INSERT INTO blockades (clinic_id, professional_id, period, reason, updated_by)
SELECT u.clinic_id, u.user_id,
       tstzrange((b.first_day + b.starts) AT TIME ZONE c.time_zone,
                 (b.last_day + b.ends)    AT TIME ZONE c.time_zone),
       b.reason, 1
  FROM seed_blockades b
  JOIN seed_users su USING (username)
  JOIN users u       ON u.keycloak_sub = su.keycloak_sub
  JOIN clinics c     ON c.clinic_id = u.clinic_id
 WHERE NOT b.after_booking;


-- =============================================================================
-- CITAS
-- Se recorre cada bloque de horario en pasos de 30 minutos y se ocupa ~70 % de los
-- espacios, con un servicio del profesional y un paciente de su clínica.
-- Las citas pasan por los mismos triggers que las de la API (I3, I4, RF13), y
-- ON CONFLICT DO NOTHING descarta las que chocan con el EXCLUDE (I1, I2): por
-- ejemplo, cuando un servicio de 45 minutos invade el siguiente espacio.
-- =============================================================================

CREATE TEMP TABLE seed_patient_slots AS
SELECT clinic_id, patient_id,
       (row_number() OVER (PARTITION BY clinic_id ORDER BY patient_id) - 1)::int AS idx,
       count(*) OVER (PARTITION BY clinic_id)::int AS n
  FROM patients;

CREATE TEMP TABLE seed_professional_services AS
SELECT spp.professional_id, sv.service_id, sv.duration_minutes,
       (row_number() OVER (PARTITION BY spp.professional_id ORDER BY sv.service_id) - 1)::int AS idx,
       count(*) OVER (PARTITION BY spp.professional_id)::int AS n
  FROM services_per_professionals spp
  JOIN services sv USING (clinic_id, service_id);

-- Recepcionista activa de cada clínica: autora de cancelaciones y lecturas en la bitácora.
CREATE TEMP TABLE seed_receptions AS
SELECT clinic_id, user_id FROM users WHERE role_id = 3 AND is_active;

INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period,
                          appointment_description, created_at, updated_by)
SELECT s.clinic_id, pt.patient_id, s.professional_id, ps.service_id,
       tstzrange(slot.start, NULL),
       (ARRAY['Control de rutina', 'Primera consulta', 'Seguimiento de tratamiento',
              'Revisión de exámenes de laboratorio', 'Dolor de cabeza frecuente', 'Malestar general',
              'Control anual', 'Dolor lumbar', 'Renovación de receta', 'Molestia persistente', NULL])
           [1 + pg_temp.pick('motivo:' || s.professional_id || slot.start, 11)],
       -- Se reservó entre 1 y 21 días antes (nunca en el futuro).
       LEAST(slot.start - make_interval(days => 1 + pg_temp.pick('creada:' || s.professional_id || slot.start, 21)),
             now()),
       1
  FROM professional_schedules s
 CROSS JOIN LATERAL generate_series(lower(s.period), upper(s.period) - interval '20 minutes',
                                    interval '30 minutes') AS slot(start)
  JOIN seed_professional_services ps
    ON ps.professional_id = s.professional_id
   AND ps.idx = pg_temp.pick('servicio:' || s.professional_id || slot.start, ps.n)
  JOIN seed_patient_slots pt
    ON pt.clinic_id = s.clinic_id
   AND pt.idx = pg_temp.pick('paciente:' || s.professional_id || slot.start, pt.n)
 WHERE pg_temp.pick('ocupado:' || s.professional_id || slot.start, 100) < 70
   AND slot.start + make_interval(mins => ps.duration_minutes) <= upper(s.period)
   AND NOT EXISTS (SELECT 1 FROM blockades b
                    WHERE b.professional_id = s.professional_id
                      AND b.period && tstzrange(slot.start, slot.start + make_interval(mins => ps.duration_minutes)))
 ORDER BY slot.start, s.professional_id
ON CONFLICT DO NOTHING;

-- Desenlaces del pasado (RF12): 80 % atendidas, 10 % ausentes; el 10 % restante se cancela abajo.
UPDATE appointments
   SET appointment_status_id = CASE WHEN pg_temp.pick('estado:' || appointment_id, 100) < 80 THEN 2 ELSE 3 END
 WHERE upper(period) <= now()
   AND pg_temp.pick('estado:' || appointment_id, 100) < 90;

-- Cancelaciones (RF11): el 10 % de las citas, pasadas o futuras.
UPDATE appointments a
   SET appointment_status_id = 4,
       cancel_reason = (ARRAY['El paciente avisa que no puede asistir', 'Paciente enfermo',
                              'Cancelada por la clínica por fuerza mayor', 'Conflicto de horario del paciente'])
                       [1 + pg_temp.pick('motivo_cancelacion:' || a.appointment_id, 4)],
       cancelled_by  = r.user_id,
       cancelled_at  = LEAST(lower(a.period) - make_interval(hours => 2 + pg_temp.pick('cancelada:' || a.appointment_id, 70)),
                             now())
  FROM seed_receptions r
 WHERE r.clinic_id = a.clinic_id
   AND a.appointment_status_id = 1
   AND pg_temp.pick('estado:' || a.appointment_id, 100) >= 90;

-- Reprogramaciones (RF10): una por clínica, igual que lo hará la API: en la misma
-- transacción la original pasa a reprogramada y se inserta la nueva. Se prueban los
-- espacios siguientes hasta encontrar uno libre; si uno choca, el bloque
-- BEGIN/EXCEPTION deshace ambos cambios y se intenta el próximo.
DO $$
DECLARE
    v_clinic INT;
    v_orig   appointments%ROWTYPE;
    v_start  TIMESTAMPTZ;
BEGIN
    FOR v_clinic IN SELECT clinic_id FROM clinics ORDER BY clinic_id LOOP
        SELECT * INTO v_orig
          FROM appointments
         WHERE clinic_id = v_clinic
           AND appointment_status_id = 1
           AND lower(period) > now() + interval '2 days'
         ORDER BY lower(period), appointment_id
         LIMIT 1;
        CONTINUE WHEN NOT FOUND;

        FOR v_start IN
            SELECT g
              FROM professional_schedules s
             CROSS JOIN LATERAL generate_series(lower(s.period), upper(s.period) - interval '20 minutes',
                                                interval '30 minutes') AS g
             WHERE s.professional_id = v_orig.professional_id
               AND lower(s.period) > lower(v_orig.period) + interval '1 day'
             ORDER BY g
        LOOP
            BEGIN
                UPDATE appointments SET appointment_status_id = 5
                 WHERE appointment_id = v_orig.appointment_id;
                INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period,
                                          appointment_description, rescheduled_from_id, updated_by)
                VALUES (v_orig.clinic_id, v_orig.patient_id, v_orig.professional_id, v_orig.service_id,
                        tstzrange(v_start, NULL), v_orig.appointment_description, v_orig.appointment_id, 1);
                EXIT;
            EXCEPTION WHEN exclusion_violation OR SQLSTATE 'MC001' THEN
                NULL;  -- espacio ocupado o fuera del horario: probar el siguiente
            END;
        END LOOP;
    END LOOP;
END $$;

-- Bloqueos registrados después de reservar (RF6: sus citas quedan como conflicto).
INSERT INTO blockades (clinic_id, professional_id, period, reason, updated_by)
SELECT u.clinic_id, u.user_id,
       tstzrange((b.first_day + b.starts) AT TIME ZONE c.time_zone,
                 (b.last_day + b.ends)    AT TIME ZONE c.time_zone),
       b.reason, 1
  FROM seed_blockades b
  JOIN seed_users su USING (username)
  JOIN users u       ON u.keycloak_sub = su.keycloak_sub
  JOIN clinics c     ON c.clinic_id = u.clinic_id
 WHERE b.after_booking;


-- =============================================================================
-- NOTAS CLÍNICAS (RF15) Y BITÁCORA (RF18)
-- =============================================================================

-- El 60 % de las citas atendidas tiene nota, escrita 10 minutos después de terminar.
INSERT INTO clinical_notes (clinic_id, appointment_id, note_text, created_at, updated_by)
SELECT a.clinic_id, a.appointment_id,
       (ARRAY['Paciente refiere mejoría de los síntomas. Signos vitales dentro de parámetros normales. Se mantiene el tratamiento y se indica control en un mes.',
              'Se revisan exámenes de laboratorio sin hallazgos relevantes. Se dan recomendaciones de alimentación y actividad física.',
              'Paciente consulta por molestia persistente. Examen físico sin signos de alarma. Se indica tratamiento sintomático y control si no mejora.',
              'Control de rutina sin novedades. Se actualiza el expediente y se agenda la próxima revisión.',
              'Se ajusta la dosis del tratamiento actual por respuesta parcial. Se explican signos de alarma y se cita a control en dos semanas.'])
           [1 + pg_temp.pick('nota:' || a.appointment_id, 5)],
       upper(a.period) + interval '10 minutes',
       1
  FROM appointments a
 WHERE a.appointment_status_id = 2
   AND pg_temp.pick('con_nota:' || a.appointment_id, 100) < 60
 ORDER BY a.appointment_id;

-- Historia simulada de la bitácora, en orden cronológico:
--   - recepción lee el teléfono del paciente al reservar cada cita;
--   - el profesional crea la nota clínica de la cita atendida.
INSERT INTO audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id,
                        description, metadata, created_at)
SELECT clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description, metadata, created_at
  FROM (
        SELECT a.clinic_id, r.user_id, 1 AS event_type_id, 2 AS data_object_id, pc.contact_id::bigint AS object_id,
               a.patient_id, 'Lectura del teléfono del paciente al reservar una cita' AS description,
               jsonb_build_object('appointment_id', a.appointment_id) AS metadata, a.created_at
          FROM appointments a
          JOIN seed_receptions r   USING (clinic_id)
          JOIN patient_contacts pc ON pc.patient_id = a.patient_id
          JOIN contact_types ct    ON ct.contact_type_id = pc.contact_type_id AND ct.contact_type_name = 'telefono'
        UNION ALL
        SELECT n.clinic_id, a.professional_id, 2, 1, n.clinical_note_id,
               a.patient_id, 'Creación de nota clínica',
               jsonb_build_object('appointment_id', a.appointment_id), n.created_at
          FROM clinical_notes n
          JOIN appointments a USING (clinic_id, appointment_id)
       ) AS history
 ORDER BY created_at;

COMMIT;

-- Estadísticas al día para el planificador (EXPLAIN ANALYZE de los índices).
-- Solo las tablas con datos; un ANALYZE sin lista intentaría también catálogos del sistema.
ANALYZE appointments, professional_schedules, blockades, patients, patient_contacts, clinical_notes,
        audit_logs, users, professionals, services, services_per_professionals, specialties_per_professionals;
