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

// Instante absoluto de una hora local de la clínica (time: 'HH:MM') en un día. Devuelve un ISO 8601 en UTC.
export async function localInstant(db, clinicId, day, time) {
  const { rows: [row] } = await db.query(
    'SELECT ($2::date + $3::time) AT TIME ZONE time_zone AS instant FROM clinics WHERE clinic_id = $1',
    [clinicId, day, time]);
  return row.instant.toISOString();
}

// Bloque de horario [from, to) en la hora local de la clínica. Lo registra el usuario Sistema (user_id 1).
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
