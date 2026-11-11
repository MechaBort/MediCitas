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

// --- Cambios de estado: cancelar (RF11) y registrar el desenlace (RF12) -------------------------------------
//
// Las reglas de RF12 y RF13 las garantiza la base, en el trigger appointments_check_status: solo se sale de
// "reservada", un estado final ya no admite cambios (MC002 → 409) y el desenlace solo se registra después de la
// hora de inicio (MC003 → 409). Las rutas no repiten esas reglas: hacen el UPDATE y traducen el error.
// Al salir de "reservada", la cita deja de contar para las restricciones EXCLUDE: su espacio queda libre en el
// mismo COMMIT (I7).

// appointment_status_id fijos de db/sql/03-catalogs.sql.
const STATUS_NAME = { 1: 'reservada', 2: 'atendida', 3: 'ausente', 4: 'cancelada', 5: 'reprogramada' };

const idParams = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const cancelSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const outcomeSchema = z.object({ outcome: z.enum(['atendida', 'ausente']) }).strict();

// Columnas que devuelven las rutas de cambio de estado, más los días de la agenda que ocupaba la cita.
const RETURNING = `
  RETURNING a.appointment_id, a.patient_id, a.professional_id, a.service_id, a.appointment_status_id,
            lower(a.period) AS start_at, upper(a.period) AS end_at, a.appointment_description,
            a.cancel_reason, a.cancelled_by, a.cancelled_at,
            (lower(a.period) AT TIME ZONE c.time_zone)::date::text AS first_day,
            ((upper(a.period) - interval '1 microsecond') AT TIME ZONE c.time_zone)::date::text AS last_day`;

function toAppointment(row) {
  return {
    appointmentId: Number(row.appointment_id),
    patientId: row.patient_id,
    professionalId: row.professional_id,
    serviceId: row.service_id,
    status: STATUS_NAME[row.appointment_status_id],
    start: row.start_at,
    end: row.end_at,
    description: row.appointment_description,
    cancelReason: row.cancel_reason,
    cancelledBy: row.cancelled_by,
    cancelledAt: row.cancelled_at,
  };
}

// Aplica un UPDATE a una cita de la clínica del token y, después del COMMIT, sube la versión de su agenda.
// Una cita que no existe o es de otra clínica responde 404 (I5).
async function changeStatus(req, sql, params) {
  const { id } = parse(idParams, req.params);
  const { clinicId, dbRole } = req.user;

  const row = await withTransaction(dbRole, async (client) =>
    (await client.query(sql, [clinicId, id, ...params])).rows[0]);
  if (!row) {
    throw new HttpError(404, 'Cita no encontrada');
  }

  await bumpAgendaVersion({
    clinicId,
    professionalId: row.professional_id,
    firstDay: row.first_day,
    lastDay: row.last_day,
  });
  return toAppointment(row);
}

// RF11: cancelar, dejando el motivo y quién canceló. Una cita en estado final no se cancela (MC002 → 409).
appointmentsRouter.post('/:id/cancel', requirePermission('appointments.manage'), async (req, res) => {
  const { reason } = parse(cancelSchema, req.body);
  const appointment = await changeStatus(req, `
    UPDATE appointments a
       SET appointment_status_id = 4, cancel_reason = $3, cancelled_by = $4, cancelled_at = now(), updated_by = $4
      FROM clinics c
     WHERE a.clinic_id = $1 AND a.appointment_id = $2 AND c.clinic_id = a.clinic_id
    ${RETURNING}`, [reason, req.user.userId]);
  res.json(appointment);
});

// RF12: registrar el desenlace, atendida o ausente. Solo después de la hora de inicio (MC003 → 409) y solo
// desde "reservada" (MC002 → 409). Según la matriz, también lo puede registrar el profesional.
appointmentsRouter.post('/:id/outcome', requirePermission('appointments.outcome'), async (req, res) => {
  const { outcome } = parse(outcomeSchema, req.body);
  const status = outcome === 'atendida' ? 2 : 3;
  const appointment = await changeStatus(req, `
    UPDATE appointments a
       SET appointment_status_id = $3, updated_by = $4
      FROM clinics c
     WHERE a.clinic_id = $1 AND a.appointment_id = $2 AND c.clinic_id = a.clinic_id
    ${RETURNING}`, [status, req.user.userId]);
  res.json(appointment);
});
