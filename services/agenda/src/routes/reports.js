import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';

// RF21: contar las citas por estado en un rango de fechas. Basta una consulta agregada sobre la base transaccional;
// la analítica real es de la Etapa 2. Permiso reports.read: solo el administrador de la clínica. Todas las consultas
// filtran por req.user.clinicId (I5). En Kubernetes, con réplica (paso 4), esta lectura puede ir al servicio -ro.
export const reportsRouter = Router();

const id = z.coerce.number().int().positive().max(2147483647);
const rangeQuery = z.object({
  from: z.iso.date(),           // días 'YYYY-MM-DD' en la hora local de la clínica, inclusive
  to: z.iso.date(),
  professionalId: id.optional(), // sin él, toda la clínica
}).strict();

// Un año completo, también bisiesto. Contar es barato: un recorrido del índice ix_appointments_clinic_start sobre las
// citas del rango, y la respuesta son siempre cinco números. El tope solo evita pedir varios años de una vez.
const MAX_RANGE_DAYS = 366;

const PROFESSIONAL_SQL = `
  SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
   WHERE u.clinic_id = $1 AND u.user_id = $2`;

// Las citas que empiezan dentro del rango, contadas por estado. Se parte del catálogo de estados para que los que no
// tienen citas aparezcan con 0.
const COUNT_SQL = `
  SELECT st.status_name, count(a.appointment_id)::int AS total
    FROM appointment_statuses st
    LEFT JOIN (
      SELECT a.appointment_id, a.appointment_status_id
        FROM clinics c
        JOIN appointments a
          ON a.clinic_id = c.clinic_id
         AND lower(a.period) >= $2::date::timestamp AT TIME ZONE c.time_zone
         AND lower(a.period) <  ($3::date + 1)::timestamp AT TIME ZONE c.time_zone
       WHERE c.clinic_id = $1
         AND ($4::int IS NULL OR a.professional_id = $4)
    ) a ON a.appointment_status_id = st.appointment_status_id
   GROUP BY st.appointment_status_id, st.status_name
   ORDER BY st.appointment_status_id`;

// Días entre dos fechas, inclusive.
const daysInRange = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

reportsRouter.get('/appointments-by-status', requirePermission('reports.read'), async (req, res) => {
  const { from, to, professionalId } = parse(rangeQuery, req.query);
  const days = daysInRange(from, to);
  if (days < 1) throw new HttpError(400, 'La fecha final no puede ser anterior a la inicial');
  if (days > MAX_RANGE_DAYS) throw new HttpError(400, `El rango no puede pasar de ${MAX_RANGE_DAYS} días`);
  const { clinicId, dbRole } = req.user;

  const rows = await withTransaction(dbRole, async (client) => {
    if (professionalId !== undefined) {
      const { rowCount } = await client.query(PROFESSIONAL_SQL, [clinicId, professionalId]);
      if (rowCount === 0) throw new HttpError(404, 'Profesional no encontrado');
    }
    return (await client.query(COUNT_SQL, [clinicId, from, to, professionalId ?? null])).rows;
  });

  res.json({
    from,
    to,
    professionalId: professionalId ?? null,
    total: rows.reduce((sum, r) => sum + r.total, 0),
    byStatus: Object.fromEntries(rows.map((r) => [r.status_name, r.total])),
  });
});
