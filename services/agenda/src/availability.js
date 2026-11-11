// Huecos libres de la agenda de cada profesional, por día (RF7, RF8).
//
// Un hueco es un tramo de tiempo en el que el profesional atiende y no tiene nada: su horario (RF5), menos sus
// bloqueos (RF6) y menos sus citas reservadas. Los calcula la base en una sola consulta; el corte en espacios de la
// duración de cada servicio lo hace slots.js. La unidad es (profesional, día local de la clínica), la misma que la
// versión de agenda de agenda-version.js: aquí es donde la etapa siguiente pone la caché de RF7, sin tocar las rutas.

// $1 clínica, $2 profesionales (int[]), $3 y $4 primer y último día local, inclusive ('YYYY-MM-DD').
//
// 1. blocks: los bloques de horario de esos profesionales que tocan el rango. La consulta empieza por los horarios:
//    un día sin horario no genera filas, así que no cuesta nada. Usa el índice GiST de ex_schedules_overlap.
// 2. working: cada bloque se recorta a cada día local que toca (uno que cruza la medianoche cuenta en los dos) y se
//    unen con range_agg por profesional y día. Dos bloques seguidos (08:00–10:00 y 10:00–12:00) quedan como un solo
//    tramo, igual que en el trigger de I3, así que una cita puede cruzar de uno al otro.
// 3. Al tramo de trabajo se le restan, como rangos múltiples (tstzmultirange), los bloqueos y las citas reservadas
//    que tocan ese día; unnest separa el resultado en huecos. Solo cuentan las citas en estado reservada (1), igual
//    que en la restricción EXCLUDE: una cita cancelada o reprogramada ya no ocupa su espacio (I7). Las dos restas
//    usan los índices GiST de bloqueos (ix_blockades_prof_period) y de citas (ex_appointments_professional).
//
// Las fechas se pasan de día a instante con `fecha::timestamp AT TIME ZONE zona`: medianoche en la hora local de la
// clínica. Un `date` sin ese paso se convertiría con la zona de la sesión, no la de la clínica.
const GAPS_SQL = `
  WITH tz AS (
    SELECT time_zone AS zone FROM clinics WHERE clinic_id = $1
  ),
  blocks AS (
    SELECT s.professional_id, s.period,
           (lower(s.period) AT TIME ZONE tz.zone)::date AS first_day,
           ((upper(s.period) - interval '1 microsecond') AT TIME ZONE tz.zone)::date AS last_day
      FROM tz
      JOIN professional_schedules s
        ON s.clinic_id = $1
       AND s.professional_id = ANY ($2::int[])
       AND s.period && tstzrange($3::date::timestamp AT TIME ZONE tz.zone,
                                 ($4::date + 1)::timestamp AT TIME ZONE tz.zone)
  ),
  working AS (
    SELECT b.professional_id, d.day, d.day_range, range_agg(b.period * d.day_range) AS working
      FROM blocks b
     CROSS JOIN tz
     CROSS JOIN LATERAL (
       SELECT $3::date + k AS day,
              tstzrange(($3::date + k)::timestamp AT TIME ZONE tz.zone,
                        ($3::date + k + 1)::timestamp AT TIME ZONE tz.zone) AS day_range
         FROM generate_series(greatest(b.first_day, $3::date) - $3::date,
                              least(b.last_day, $4::date) - $3::date) AS k
     ) d
     GROUP BY b.professional_id, d.day, d.day_range
  )
  SELECT w.professional_id, w.day::text AS day, lower(g) AS gap_start, upper(g) AS gap_end
    FROM working w
   CROSS JOIN LATERAL unnest(
           w.working
           - COALESCE((SELECT range_agg(bl.period) FROM blockades bl
                        WHERE bl.clinic_id = $1 AND bl.professional_id = w.professional_id
                          AND bl.period && w.day_range), '{}')
           - COALESCE((SELECT range_agg(a.period) FROM appointments a
                        WHERE a.clinic_id = $1 AND a.professional_id = w.professional_id
                          AND a.appointment_status_id = 1
                          AND a.period && w.day_range), '{}')
         ) AS g
   ORDER BY w.professional_id, w.day, gap_start`;

export const gapsKey = (professionalId, day) => `${professionalId}:${day}`;

// Huecos libres de esos profesionales entre firstDay y lastDay ('YYYY-MM-DD', inclusive), dentro de una transacción
// ya abierta. Devuelve un Map de gapsKey(profesional, día) → [{ start: Date, end: Date }]. Un par que no está en el
// Map no tiene huecos: no hay horario ese día, o todo está ocupado o bloqueado.
export async function freeGaps(client, { clinicId, professionalIds, firstDay, lastDay = firstDay }) {
  const { rows } = await client.query(GAPS_SQL, [clinicId, professionalIds, firstDay, lastDay]);
  const gaps = new Map();
  for (const row of rows) {
    const key = gapsKey(row.professional_id, row.day);
    if (!gaps.has(key)) gaps.set(key, []);
    gaps.get(key).push({ start: row.gap_start, end: row.gap_end });
  }
  return gaps;
}
