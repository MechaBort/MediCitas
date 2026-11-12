import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';

// RF20: la agenda del día, la vista con la que trabaja recepción. Solo lectura, con el permiso agenda.read (los tres
// roles de clínica, según la matriz; el profesional también ve la de toda la clínica, porque la matriz no le da una
// variante "solo lo propio"). Todas las consultas filtran por req.user.clinicId (I5).
export const agendaRouter = Router();

const id = z.coerce.number().int().positive().max(2147483647);
const agendaQuery = z.object({
  date: z.iso.date(),          // día 'YYYY-MM-DD' en la hora local de la clínica
  professionalId: id.optional(), // sin él, la agenda de toda la clínica
}).strict();

// El profesional debe ser de la clínica del token; si no, 404 como uno inexistente (I5). No se exige que esté
// activo: la agenda de un día pasado de un profesional dado de baja sigue siendo consultable.
const PROFESSIONAL_SQL = `
  SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
   WHERE u.clinic_id = $1 AND u.user_id = $2`;

// Las citas que empiezan ese día en la hora local de la clínica, en todos los estados: recepción ve también las
// canceladas y las reprogramadas. El filtro sobre lower(period) es el que pueden usar los índices
// ix_appointments_clinic_start (toda la clínica) e ix_appointments_prof_start (un profesional). No se leen los
// contactos del paciente: esos sí tendrían que registrarse en la bitácora (RF18).
const AGENDA_SQL = `
  SELECT a.appointment_id, lower(a.period) AS start_at, upper(a.period) AS end_at, st.status_name,
         a.appointment_description,
         a.professional_id, pu.name || ' ' || pu.last_name AS professional_name,
         a.patient_id, pa.name || ' ' || pa.last_name AS patient_name,
         a.service_id, s.service_name
    FROM clinics c
    JOIN appointments a
      ON a.clinic_id = c.clinic_id
     AND lower(a.period) >= $2::date::timestamp AT TIME ZONE c.time_zone
     AND lower(a.period) <  ($2::date + 1)::timestamp AT TIME ZONE c.time_zone
    JOIN appointment_statuses st ON st.appointment_status_id = a.appointment_status_id
    JOIN users pu                ON pu.user_id = a.professional_id
    JOIN patients pa             ON pa.patient_id = a.patient_id
    JOIN services s              ON s.service_id = a.service_id
   WHERE c.clinic_id = $1
     AND ($3::int IS NULL OR a.professional_id = $3)
   ORDER BY lower(a.period), a.professional_id, a.appointment_id`;

agendaRouter.get('/', requirePermission('agenda.read'), async (req, res) => {
  const { date, professionalId } = parse(agendaQuery, req.query);
  const { clinicId, dbRole } = req.user;

  const rows = await withTransaction(dbRole, async (client) => {
    if (professionalId !== undefined) {
      const { rowCount } = await client.query(PROFESSIONAL_SQL, [clinicId, professionalId]);
      if (rowCount === 0) throw new HttpError(404, 'Profesional no encontrado');
    }
    return (await client.query(AGENDA_SQL, [clinicId, date, professionalId ?? null])).rows;
  });

  res.json({
    date,
    professionalId: professionalId ?? null,
    appointments: rows.map((r) => ({
      appointmentId: Number(r.appointment_id),
      start: r.start_at,
      end: r.end_at,
      status: r.status_name,
      description: r.appointment_description,
      professional: { professionalId: r.professional_id, name: r.professional_name },
      patient: { patientId: r.patient_id, name: r.patient_name },
      service: { serviceId: r.service_id, name: r.service_name },
    })),
  });
});
