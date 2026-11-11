// Conexión directa a la base como mc_owner, solo para dos cosas que la API no hace:
// - preparar datos que todavía no se pueden crear por la API (por ejemplo, bloques de horario, mientras no
//   exista la ruta de RF5) o que la API nunca permite (como alterar la bitácora en la prueba del módulo §9);
// - verificar el resultado directamente en la base (por ejemplo, que quedó una sola cita).
// La operación que se prueba siempre pasa por la API.
import { after } from 'node:test';
import pg from 'pg';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://mc_owner:mc_owner_dev@localhost:5432/medicitas';

// Pool del archivo de pruebas; se cierra al terminar el archivo para que el proceso pueda salir.
export function ownerDb() {
  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  after(() => db.end());
  return db;
}

// Profesionales activos de una clínica, cada uno con su primer servicio activo:
// [{ professionalId, serviceId, duration }].
export async function professionalsOf(db, clinicId) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (spp.professional_id)
           spp.professional_id AS "professionalId", spp.service_id AS "serviceId", s.duration_minutes AS duration
      FROM services_per_professionals spp
      JOIN services s       ON s.service_id = spp.service_id AND s.is_active
      JOIN users u          ON u.user_id = spp.professional_id AND u.is_active
      JOIN professionals pr ON pr.user_id = u.user_id AND pr.is_active
     WHERE spp.clinic_id = $1 AND spp.is_active
     ORDER BY spp.professional_id, spp.service_id`, [clinicId]);
  return rows;
}

// Ids de pacientes activos de una clínica (hasta 10).
export async function patientsOf(db, clinicId) {
  const { rows } = await db.query(
    'SELECT patient_id FROM patients WHERE clinic_id = $1 AND is_active ORDER BY patient_id LIMIT 10', [clinicId]);
  return rows.map((r) => r.patient_id);
}

// Un día lejano en el que ninguno de los profesionales indicados tiene horario. Cada llamada elige otro día, así
// las pruebas no chocan con el seed ni con corridas anteriores. Devuelve 'YYYY-MM-DD'.
export async function freeDay(db, professionalIds) {
  const { rows: [row] } = await db.query(`
    SELECT d::date::text AS day
      FROM generate_series(current_date + 400 + (random() * 3000)::int, current_date + 4000, interval '1 day') d
     WHERE NOT EXISTS (SELECT 1 FROM professional_schedules s
                        WHERE s.professional_id = ANY ($1)
                          AND s.period && tstzrange(d - interval '1 day', d + interval '2 days'))
     LIMIT 1`, [professionalIds]);
  return row.day;
}

// Varios días seguidos y lejanos en los que ninguno de esos profesionales tiene horario, para las pruebas de un rango
// de fechas (RF8). Devuelve ['YYYY-MM-DD', ...] en orden.
export async function freeDays(db, professionalIds, count) {
  const { rows: [row] } = await db.query(`
    SELECT ARRAY(SELECT (d::date + k)::text FROM generate_series(0, $2 - 1) AS k ORDER BY k) AS days
      FROM generate_series(current_date + 400 + (random() * 3000)::int, current_date + 4000, interval '1 day') d
     WHERE NOT EXISTS (SELECT 1 FROM professional_schedules s
                        WHERE s.professional_id = ANY ($1)
                          AND s.period && tstzrange(d - interval '1 day', d + make_interval(days => $2 + 1)))
     LIMIT 1`, [professionalIds, count]);
  return row.days;
}

// Un día del pasado lejano en el que esos profesionales no tienen horario, para citas que ya empezaron (RF12):
// la API no permite reservar en el pasado, así que esas citas se preparan aquí.
export async function freePastDay(db, professionalIds) {
  const { rows: [row] } = await db.query(`
    SELECT d::date::text AS day
      FROM generate_series(current_date - 400 - (random() * 3000)::int, current_date - 4000, interval '-1 day') d
     WHERE NOT EXISTS (SELECT 1 FROM professional_schedules s
                        WHERE s.professional_id = ANY ($1)
                          AND s.period && tstzrange(d - interval '1 day', d + interval '2 days'))
     LIMIT 1`, [professionalIds]);
  return row.day;
}

// Cita reservada creada directamente en la base (para días pasados). Los triggers igual calculan el fin con la
// duración del servicio y exigen un bloque de horario que la contenga. Devuelve su id.
export async function addAppointment(db, { clinicId, patientId, professionalId, serviceId, day, time }) {
  const { rows: [row] } = await db.query(`
    INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period, updated_by)
    SELECT $1, $2, $3, $4, tstzrange(($5::date + $6::time) AT TIME ZONE time_zone, NULL), 1
      FROM clinics WHERE clinic_id = $1
    RETURNING appointment_id`,
    [clinicId, patientId, professionalId, serviceId, day, time]);
  return Number(row.appointment_id);
}

// Estado actual de una cita, para verificar que una operación rechazada no la cambió.
export async function appointmentStatus(db, appointmentId) {
  const { rows: [row] } = await db.query(`
    SELECT s.status_name FROM appointments a
      JOIN appointment_statuses s ON s.appointment_status_id = a.appointment_status_id
     WHERE a.appointment_id = $1`, [appointmentId]);
  return row?.status_name;
}

// Instante absoluto de una hora local de la clínica (time: 'HH:MM') en un día. Devuelve un ISO 8601 en UTC.
export async function localInstant(db, clinicId, day, time) {
  const { rows: [row] } = await db.query(
    'SELECT ($2::date + $3::time) AT TIME ZONE time_zone AS instant FROM clinics WHERE clinic_id = $1',
    [clinicId, day, time]);
  return row.instant.toISOString();
}

// Bloque de horario [from, to) en la hora local de la clínica. Lo registra el usuario Sistema (user_id 1).
// Como escribe directo en la base, no sube la versión de la agenda en Redis (la caché de RF7): se usa en días nuevos,
// antes de consultar su disponibilidad. Lo mismo vale para addBlockade.
export async function addScheduleBlock(db, { clinicId, professionalId, day, from, to }) {
  await db.query(`
    INSERT INTO professional_schedules (clinic_id, professional_id, period, updated_by)
    SELECT $1, $2, tstzrange(($3::date + $4::time) AT TIME ZONE time_zone, ($3::date + $5::time) AT TIME ZONE time_zone), 1
      FROM clinics WHERE clinic_id = $1`,
    [clinicId, professionalId, day, from, to]);
}

// Bloqueo de agenda (RF6) [from, to) en la hora local de la clínica.
export async function addBlockade(db, { clinicId, professionalId, day, from, to }) {
  await db.query(`
    INSERT INTO blockades (clinic_id, professional_id, period, reason, updated_by)
    SELECT $1, $2, tstzrange(($3::date + $4::time) AT TIME ZONE time_zone, ($3::date + $5::time) AT TIME ZONE time_zone),
           'Bloqueo de prueba', 1
      FROM clinics WHERE clinic_id = $1`,
    [clinicId, professionalId, day, from, to]);
}
