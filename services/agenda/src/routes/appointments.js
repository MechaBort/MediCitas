import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { bumpAgendaVersion } from '../agenda-version.js';

// Citas (RF9–RF13). Todas las consultas filtran por req.user.clinicId: un paciente, profesional o servicio de
// otra clínica responde 404, igual que uno que no existe (I5).
export const appointmentsRouter = Router();

const id = z.number().int().positive().max(2147483647);

const newAppointmentSchema = z.object({
  patientId: id,
  professionalId: id,
  serviceId: id,
  // Instante de inicio con su zona horaria, p. ej. 2026-11-12T09:00:00-06:00. El fin no se recibe: lo calcula
  // la base con la duración del servicio (I4).
  start: z.iso.datetime({ offset: true }),
  description: z.string().trim().min(1).max(500).optional(),
}).strict();

// Lo que hay que saber antes de insertar, en una sola consulta: que el paciente, el profesional y el servicio
// existan, estén activos y sean de la clínica; que el profesional atienda ese servicio; que el inicio sea
// futuro; y la zona horaria de la clínica, para saber qué día de su agenda se ocupa.
const CHECK_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM patients
             WHERE clinic_id = $1 AND patient_id = $2 AND is_active) AS patient_ok,
    EXISTS (SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
             WHERE u.clinic_id = $1 AND u.user_id = $3 AND u.is_active AND p.is_active) AS professional_ok,
    EXISTS (SELECT 1 FROM services
             WHERE clinic_id = $1 AND service_id = $4 AND is_active) AS service_ok,
    EXISTS (SELECT 1 FROM services_per_professionals
             WHERE clinic_id = $1 AND professional_id = $3 AND service_id = $4 AND is_active) AS offered,
    $5::timestamptz <= now() AS in_past,
    (SELECT time_zone FROM clinics WHERE clinic_id = $1) AS time_zone`;

// El fin del periodo queda en NULL: el trigger appointments_set_period lo calcula con la duración del servicio
// (I4). Después, appointments_check_agenda revisa el horario y los bloqueos (I3, MC001), y las restricciones
// EXCLUDE deciden si el espacio sigue libre (I1, I2: 23P01). Si dos reservas compiten por el mismo espacio, la
// segunda espera a la primera y, si esta confirma, falla: no hay ventana en la que las dos lo vean libre.
const INSERT_SQL = `
  INSERT INTO appointments (clinic_id, patient_id, professional_id, service_id, period, appointment_description, updated_by)
  VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, NULL), $6, $7)
  RETURNING appointment_id, lower(period) AS start_at, upper(period) AS end_at,
            (lower(period) AT TIME ZONE $8)::date::text AS first_day,
            ((upper(period) - interval '1 microsecond') AT TIME ZONE $8)::date::text AS last_day`;

// RF9: reservar. Tres desenlaces: concedida (201), espacio ya tomado (409) y solicitud inválida (400).
appointmentsRouter.post('/', requirePermission('appointments.manage'), async (req, res) => {
  const body = parse(newAppointmentSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const appointment = await withTransaction(dbRole, async (client) => {
    const { rows: [check] } = await client.query(CHECK_SQL,
      [clinicId, body.patientId, body.professionalId, body.serviceId, body.start]);

    if (!check.patient_ok) throw new HttpError(404, 'Paciente no encontrado');
    if (!check.professional_ok) throw new HttpError(404, 'Profesional no encontrado');
    if (!check.service_ok) throw new HttpError(404, 'Servicio no encontrado');
    if (!check.offered) throw new HttpError(400, 'El profesional no atiende ese servicio');
    if (check.in_past) throw new HttpError(400, 'La cita debe empezar en el futuro');

    const { rows: [row] } = await client.query(INSERT_SQL, [clinicId, body.patientId, body.professionalId,
      body.serviceId, body.start, body.description ?? null, userId, check.time_zone]);
    return row;
  });

  // Después del COMMIT: las copias de disponibilidad de ese día dejan de valer (I8).
  await bumpAgendaVersion({
    clinicId,
    professionalId: body.professionalId,
    firstDay: appointment.first_day,
    lastDay: appointment.last_day,
  });

  res.status(201).location(`/appointments/${appointment.appointment_id}`).json({
    appointmentId: Number(appointment.appointment_id),
    patientId: body.patientId,
    professionalId: body.professionalId,
    serviceId: body.serviceId,
    status: 'reservada',
    start: appointment.start_at,
    end: appointment.end_at,
    description: body.description ?? null,
  });
});
