import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { bumpAgendaVersion } from '../agenda-version.js';

// Horarios de atención por profesional (RF5). Cada bloque se recibe en la fecha y hora local de la
// clínica ('YYYY-MM-DD' y 'HH:MM') y se guarda como tstzrange [inicio, fin) en instantes absolutos
// convirtiendo con clinics.time_zone. Puede haber varios bloques por día (jornada partida), pero no
// pueden solaparse entre sí (ex_schedules_overlap). Borrar o recortar un bloque que dejaría citas
// reservadas fuera del horario lo impide el trigger trg_professional_schedules_guard con MC006 (409, I3).
export const schedulesRouter = Router();

const id = z.number().int().positive().max(2147483647);
const queryId = z.coerce.number().int().positive().max(2147483647);
const timeString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Formato de hora inválido (use HH:MM)');

const scheduleIdParams = z.object({ scheduleId: queryId });

const listSchedulesQuery = z.object({
  professionalId: queryId.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict();

const createScheduleSchema = z.object({
  professionalId: id,
  date: z.iso.date(),
  startTime: timeString,
  endTime: timeString,
}).strict();

const updateScheduleSchema = z.object({
  date: z.iso.date().optional(),
  startTime: timeString.optional(),
  endTime: timeString.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'Debe enviar al menos un campo para actualizar',
});

// Lectura: administrador de clínica, profesional o recepción (agenda/disponibilidad).
function requireScheduleRead(req, res, next) {
  const { permissions } = req.user;
  if (
    permissions.has('schedules.manage') ||
    permissions.has('schedules.manage_own') ||
    permissions.has('appointments.manage') ||
    permissions.has('agenda.read')
  ) {
    return next();
  }
  return res.status(403).json({ error: 'No tiene permiso para esta operación' });
}

// Escritura (RF5, RF17): schedules.manage (administrador de clínica, cualquier profesional de su
// clínica) o schedules.manage_own (profesional, únicamente su propio userId).
function requireScheduleWrite(req, res, next) {
  const { permissions } = req.user;
  if (permissions.has('schedules.manage') || permissions.has('schedules.manage_own')) {
    return next();
  }
  return res.status(403).json({ error: 'No tiene permiso para esta operación' });
}

function assertCanManageProfessional(user, professionalId) {
  if (!user.permissions.has('schedules.manage') && professionalId !== user.userId) {
    throw new HttpError(403, 'Solo puede gestionar su propio horario');
  }
}

function formatSchedule(row) {
  return {
    scheduleId: row.scheduleId,
    professionalId: row.professionalId,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    start: row.start,
    end: row.end,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const LIST_SCHEDULES_SQL = `
  SELECT s.schedule_id AS "scheduleId",
         s.professional_id AS "professionalId",
         (lower(s.period) AT TIME ZONE c.time_zone)::date::text AS date,
         to_char(lower(s.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS "startTime",
         to_char(upper(s.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS "endTime",
         lower(s.period) AS start,
         upper(s.period) AS "end",
         s.created_at AS "createdAt",
         s.updated_at AS "updatedAt"
    FROM professional_schedules s
    JOIN clinics c ON c.clinic_id = s.clinic_id
   WHERE s.clinic_id = $1
     AND ($2::int IS NULL OR s.professional_id = $2)
     AND ($3::date IS NULL OR s.period && tstzrange($3::date::timestamp AT TIME ZONE c.time_zone, 'infinity'))
     AND ($4::date IS NULL OR s.period && tstzrange('-infinity', ($4::date + 1)::timestamp AT TIME ZONE c.time_zone))
   ORDER BY lower(s.period), s.schedule_id`;

// RF5: listar los bloques de horario de la clínica, opcionalmente por profesional y rango de fechas.
schedulesRouter.get('/', requireScheduleRead, async (req, res) => {
  const { professionalId = null, from = null, to = null } = parse(listSchedulesQuery, req.query);
  if (from && to && from > to) {
    throw new HttpError(400, 'La fecha final no puede ser anterior a la inicial');
  }
  const { clinicId, dbRole } = req.user;

  const rows = await withTransaction(dbRole, async (client) => {
    if (professionalId !== null) {
      const { rows: [prof] } = await client.query(
        `SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
          WHERE u.clinic_id = $1 AND u.user_id = $2`,
        [clinicId, professionalId],
      );
      if (!prof) throw new HttpError(404, 'Profesional no encontrado');
    }
    return (await client.query(LIST_SCHEDULES_SQL, [clinicId, professionalId, from, to])).rows;
  });

  res.json(rows.map(formatSchedule));
});

const CHECK_CREATE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
             WHERE u.clinic_id = $1 AND u.user_id = $2 AND u.is_active AND p.is_active) AS professional_ok,
    c.time_zone,
    EXISTS (SELECT 1 FROM professional_schedules s
             WHERE s.clinic_id = $1 AND s.professional_id = $2
               AND s.period && tstzrange(($3::date + $4::time) AT TIME ZONE c.time_zone,
                                         ($3::date + $5::time) AT TIME ZONE c.time_zone)) AS overlaps
    FROM clinics c
   WHERE c.clinic_id = $1`;

const INSERT_SCHEDULE_SQL = `
  INSERT INTO professional_schedules (clinic_id, professional_id, period, updated_by)
  VALUES ($1, $2, tstzrange(($3::date + $4::time) AT TIME ZONE $6,
                            ($3::date + $5::time) AT TIME ZONE $6), $7)
  RETURNING schedule_id AS "scheduleId",
            professional_id AS "professionalId",
            (lower(period) AT TIME ZONE $6)::date::text AS date,
            to_char(lower(period) AT TIME ZONE $6, 'HH24:MI') AS "startTime",
            to_char(upper(period) AT TIME ZONE $6, 'HH24:MI') AS "endTime",
            lower(period) AS start,
            upper(period) AS "end",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            (lower(period) AT TIME ZONE $6)::date::text AS first_day,
            ((upper(period) - interval '1 microsecond') AT TIME ZONE $6)::date::text AS last_day`;

// RF5: definir un bloque de horario de atención para un profesional.
schedulesRouter.post('/', requireScheduleWrite, async (req, res) => {
  const body = parse(createScheduleSchema, req.body);
  assertCanManageProfessional(req.user, body.professionalId);
  if (body.startTime >= body.endTime) {
    throw new HttpError(400, 'La hora de fin debe ser posterior a la de inicio');
  }
  const { clinicId, userId, dbRole } = req.user;

  const created = await withTransaction(dbRole, async (client) => {
    const { rows: [check] } = await client.query(CHECK_CREATE_SQL, [
      clinicId, body.professionalId, body.date, body.startTime, body.endTime,
    ]);
    if (!check.professional_ok) throw new HttpError(404, 'Profesional no encontrado');
    if (check.overlaps) {
      throw new HttpError(409, 'El bloque de horario se cruza con otro existente del profesional');
    }

    const { rows: [row] } = await client.query(INSERT_SCHEDULE_SQL, [
      clinicId, body.professionalId, body.date, body.startTime, body.endTime, check.time_zone, userId,
    ]);
    return row;
  });

  // Después del COMMIT: invalida las copias de disponibilidad de ese día (I8).
  await bumpAgendaVersion({
    clinicId,
    professionalId: body.professionalId,
    firstDay: created.first_day,
    lastDay: created.last_day,
  });

  res.status(201).location(`/schedules/${created.scheduleId}`).json(formatSchedule(created));
});

const CURRENT_SCHEDULE_SQL = `
  SELECT s.schedule_id, s.professional_id, c.time_zone,
         (lower(s.period) AT TIME ZONE c.time_zone)::date::text AS date,
         to_char(lower(s.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS start_time,
         to_char(upper(s.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS end_time,
         (lower(s.period) AT TIME ZONE c.time_zone)::date::text AS first_day,
         ((upper(s.period) - interval '1 microsecond') AT TIME ZONE c.time_zone)::date::text AS last_day
    FROM professional_schedules s
    JOIN clinics c ON c.clinic_id = s.clinic_id
   WHERE s.clinic_id = $1 AND s.schedule_id = $2`;

const UPDATE_SCHEDULE_SQL = `
  UPDATE professional_schedules
     SET period = tstzrange(($3::date + $4::time) AT TIME ZONE $6,
                            ($3::date + $5::time) AT TIME ZONE $6),
         updated_by = $7
   WHERE clinic_id = $1 AND schedule_id = $2
  RETURNING schedule_id AS "scheduleId",
            professional_id AS "professionalId",
            (lower(period) AT TIME ZONE $6)::date::text AS date,
            to_char(lower(period) AT TIME ZONE $6, 'HH24:MI') AS "startTime",
            to_char(upper(period) AT TIME ZONE $6, 'HH24:MI') AS "endTime",
            lower(period) AS start,
            upper(period) AS "end",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            (lower(period) AT TIME ZONE $6)::date::text AS first_day,
            ((upper(period) - interval '1 microsecond') AT TIME ZONE $6)::date::text AS last_day`;

// RF5, I3: modificar un bloque de horario. Si el cambio deja citas reservadas fuera del horario del
// profesional, el trigger trg_professional_schedules_guard aborta con MC006 (409).
schedulesRouter.patch('/:scheduleId', requireScheduleWrite, async (req, res) => {
  const { scheduleId } = parse(scheduleIdParams, req.params);
  const body = parse(updateScheduleSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const { current, updated } = await withTransaction(dbRole, async (client) => {
    const { rows: [existing] } = await client.query(CURRENT_SCHEDULE_SQL, [clinicId, scheduleId]);
    if (!existing) throw new HttpError(404, 'Bloque de horario no encontrado');
    assertCanManageProfessional(req.user, existing.professional_id);

    const date = body.date ?? existing.date;
    const startTime = body.startTime ?? existing.start_time;
    const endTime = body.endTime ?? existing.end_time;
    if (startTime >= endTime) {
      throw new HttpError(400, 'La hora de fin debe ser posterior a la de inicio');
    }

    const { rows: [overlap] } = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM professional_schedules s
          WHERE s.clinic_id = $1 AND s.professional_id = $2 AND s.schedule_id <> $3
            AND s.period && tstzrange(($4::date + $5::time) AT TIME ZONE $7,
                                      ($4::date + $6::time) AT TIME ZONE $7)
       ) AS overlaps`,
      [clinicId, existing.professional_id, scheduleId, date, startTime, endTime, existing.time_zone],
    );
    if (overlap.overlaps) {
      throw new HttpError(409, 'El bloque de horario se cruza con otro existente del profesional');
    }

    const { rows: [row] } = await client.query(UPDATE_SCHEDULE_SQL, [
      clinicId, scheduleId, date, startTime, endTime, existing.time_zone, userId,
    ]);
    return { current: existing, updated: row };
  });

  // Después del COMMIT: invalida tanto el día viejo como el nuevo si cambió de fecha (I8).
  await bumpAgendaVersion({
    clinicId,
    professionalId: current.professional_id,
    firstDay: current.first_day,
    lastDay: current.last_day,
  });
  if (updated.first_day !== current.first_day || updated.last_day !== current.last_day) {
    await bumpAgendaVersion({
      clinicId,
      professionalId: current.professional_id,
      firstDay: updated.first_day,
      lastDay: updated.last_day,
    });
  }

  res.json(formatSchedule(updated));
});

// RF5, I3: eliminar un bloque de horario. Falla con 409 (MC006) si tiene citas reservadas que no
// quedan cubiertas por otro bloque.
schedulesRouter.delete('/:scheduleId', requireScheduleWrite, async (req, res) => {
  const { scheduleId } = parse(scheduleIdParams, req.params);
  const { clinicId, dbRole } = req.user;

  const deleted = await withTransaction(dbRole, async (client) => {
    const { rows: [existing] } = await client.query(CURRENT_SCHEDULE_SQL, [clinicId, scheduleId]);
    if (!existing) throw new HttpError(404, 'Bloque de horario no encontrado');
    assertCanManageProfessional(req.user, existing.professional_id);

    await client.query('DELETE FROM professional_schedules WHERE clinic_id = $1 AND schedule_id = $2', [
      clinicId, scheduleId,
    ]);
    return existing;
  });

  await bumpAgendaVersion({
    clinicId,
    professionalId: deleted.professional_id,
    firstDay: deleted.first_day,
    lastDay: deleted.last_day,
  });

  res.status(204).end();
});
