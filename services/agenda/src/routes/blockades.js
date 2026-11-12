import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { bumpAgendaVersion } from '../agenda-version.js';

// Bloqueos de agenda por profesional (RF6): vacaciones, permisos o ausencias. A diferencia de los
// horarios (RF5), los bloqueos pueden solaparse entre sí y un bloqueo que cae sobre citas ya
// reservadas NO las cancela automáticamente: esas citas quedan en estado "reservada" y se listan
// como conflictos para que recepción las reprograme (RF6, RF10).
export const blockadesRouter = Router();

const id = z.number().int().positive().max(2147483647);
const queryId = z.coerce.number().int().positive().max(2147483647);
const timeString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Formato de hora inválido (use HH:MM)');

const blockadeIdParams = z.object({ blockadeId: queryId });

const listBlockadesQuery = z.object({
  professionalId: queryId.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict();

const conflictsQuery = z.object({
  professionalId: queryId.optional(),
  blockadeId: queryId.optional(),
}).strict();

// Acepta date (para un bloqueo dentro de un mismo día) o el par startDate + endDate (para ausencias
// de varios días, como vacaciones).
const createBlockadeSchema = z.object({
  professionalId: id,
  date: z.iso.date().optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  startTime: timeString,
  endTime: timeString,
  reason: z.string().trim().min(1).max(500),
}).strict();

function requireBlockadeRead(req, res, next) {
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

function requireBlockadeWrite(req, res, next) {
  const { permissions } = req.user;
  if (permissions.has('schedules.manage') || permissions.has('schedules.manage_own')) {
    return next();
  }
  return res.status(403).json({ error: 'No tiene permiso para esta operación' });
}

function assertCanManageProfessional(user, professionalId) {
  if (!user.permissions.has('schedules.manage') && professionalId !== user.userId) {
    throw new HttpError(403, 'Solo puede gestionar sus propios bloqueos');
  }
}

function formatConflict(row) {
  return {
    appointmentId: Number(row.appointmentId),
    professionalId: row.professionalId,
    ...(row.professionalName !== undefined && { professionalName: row.professionalName }),
    patientId: row.patientId,
    patientName: row.patientName,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    start: row.start,
    end: row.end,
    description: row.description,
    ...(row.blockadeId !== undefined && { blockadeId: row.blockadeId }),
    ...(row.blockadeReason !== undefined && { blockadeReason: row.blockadeReason }),
  };
}

function formatBlockade(row, conflicts = []) {
  return {
    blockadeId: row.blockadeId,
    professionalId: row.professionalId,
    startDate: row.startDate,
    startTime: row.startTime,
    endDate: row.endDate,
    endTime: row.endTime,
    start: row.start,
    end: row.end,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    conflicts: conflicts.map(formatConflict),
  };
}

const CONFLICTS_SQL = `
  SELECT a.appointment_id AS "appointmentId",
         a.professional_id AS "professionalId",
         u.name || ' ' || u.last_name AS "professionalName",
         a.patient_id AS "patientId",
         p.name || ' ' || p.last_name AS "patientName",
         a.service_id AS "serviceId",
         s.service_name AS "serviceName",
         lower(a.period) AS start,
         upper(a.period) AS "end",
         a.appointment_description AS description,
         b.blockade_id AS "blockadeId",
         b.reason AS "blockadeReason"
    FROM appointments a
    JOIN blockades b ON b.clinic_id = a.clinic_id
                    AND b.professional_id = a.professional_id
                    AND b.period && a.period
    JOIN users u    ON u.clinic_id = a.clinic_id AND u.user_id = a.professional_id
    JOIN patients p ON p.clinic_id = a.clinic_id AND p.patient_id = a.patient_id
    JOIN services s ON s.clinic_id = a.clinic_id AND s.service_id = a.service_id
   WHERE a.clinic_id = $1
     AND a.appointment_status_id = 1
     AND ($2::int IS NULL OR a.professional_id = $2)
     AND ($3::int IS NULL OR b.blockade_id = $3)
   ORDER BY lower(a.period), a.appointment_id, b.blockade_id`;

// RF6: listar todas las citas reservadas de la clínica que caen dentro de algún bloqueo vigente,
// para que recepción o administración puedan reprogramarlas.
blockadesRouter.get('/conflicts', requireBlockadeRead, async (req, res) => {
  const { professionalId = null, blockadeId = null } = parse(conflictsQuery, req.query);
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
    if (blockadeId !== null) {
      const { rows: [blk] } = await client.query(
        'SELECT 1 FROM blockades WHERE clinic_id = $1 AND blockade_id = $2',
        [clinicId, blockadeId],
      );
      if (!blk) throw new HttpError(404, 'Bloqueo no encontrado');
    }
    return (await client.query(CONFLICTS_SQL, [clinicId, professionalId, blockadeId])).rows;
  });

  res.json(rows.map(formatConflict));
});

const LIST_BLOCKADES_SQL = `
  SELECT b.blockade_id AS "blockadeId",
         b.professional_id AS "professionalId",
         (lower(b.period) AT TIME ZONE c.time_zone)::date::text AS "startDate",
         to_char(lower(b.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS "startTime",
         (upper(b.period) AT TIME ZONE c.time_zone)::date::text AS "endDate",
         to_char(upper(b.period) AT TIME ZONE c.time_zone, 'HH24:MI') AS "endTime",
         lower(b.period) AS start,
         upper(b.period) AS "end",
         b.reason,
         b.created_at AS "createdAt",
         b.updated_at AS "updatedAt"
    FROM blockades b
    JOIN clinics c ON c.clinic_id = b.clinic_id
   WHERE b.clinic_id = $1
     AND ($2::int IS NULL OR b.professional_id = $2)
     AND ($3::date IS NULL OR b.period && tstzrange($3::date::timestamp AT TIME ZONE c.time_zone, 'infinity'))
     AND ($4::date IS NULL OR b.period && tstzrange('-infinity', ($4::date + 1)::timestamp AT TIME ZONE c.time_zone))
   ORDER BY lower(b.period), b.blockade_id`;

// RF6: listar los bloqueos de la clínica, cada uno con las citas reservadas que entran en conflicto.
blockadesRouter.get('/', requireBlockadeRead, async (req, res) => {
  const { professionalId = null, from = null, to = null } = parse(listBlockadesQuery, req.query);
  if (from && to && from > to) {
    throw new HttpError(400, 'La fecha final no puede ser anterior a la inicial');
  }
  const { clinicId, dbRole } = req.user;

  const { blockades, conflictsByBlockade } = await withTransaction(dbRole, async (client) => {
    if (professionalId !== null) {
      const { rows: [prof] } = await client.query(
        `SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
          WHERE u.clinic_id = $1 AND u.user_id = $2`,
        [clinicId, professionalId],
      );
      if (!prof) throw new HttpError(404, 'Profesional no encontrado');
    }

    const { rows: blockadeRows } = await client.query(LIST_BLOCKADES_SQL, [clinicId, professionalId, from, to]);
    const { rows: conflictRows } = await client.query(CONFLICTS_SQL, [clinicId, professionalId, null]);
    const byBlockade = new Map();
    for (const c of conflictRows) {
      if (!byBlockade.has(c.blockadeId)) byBlockade.set(c.blockadeId, []);
      byBlockade.get(c.blockadeId).push(c);
    }
    return { blockades: blockadeRows, conflictsByBlockade: byBlockade };
  });

  res.json(blockades.map((b) => formatBlockade(b, conflictsByBlockade.get(b.blockadeId) ?? [])));
});

const CHECK_PROFESSIONAL_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
             WHERE u.clinic_id = $1 AND u.user_id = $2 AND u.is_active AND p.is_active) AS professional_ok,
    c.time_zone
    FROM clinics c
   WHERE c.clinic_id = $1`;

const INSERT_BLOCKADE_SQL = `
  INSERT INTO blockades (clinic_id, professional_id, period, reason, updated_by)
  VALUES ($1, $2, tstzrange(($3::date + $4::time) AT TIME ZONE $8,
                            ($5::date + $6::time) AT TIME ZONE $8), $7, $9)
  RETURNING blockade_id AS "blockadeId",
            professional_id AS "professionalId",
            (lower(period) AT TIME ZONE $8)::date::text AS "startDate",
            to_char(lower(period) AT TIME ZONE $8, 'HH24:MI') AS "startTime",
            (upper(period) AT TIME ZONE $8)::date::text AS "endDate",
            to_char(upper(period) AT TIME ZONE $8, 'HH24:MI') AS "endTime",
            lower(period) AS start,
            upper(period) AS "end",
            reason,
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            (lower(period) AT TIME ZONE $8)::date::text AS first_day,
            ((upper(period) - interval '1 microsecond') AT TIME ZONE $8)::date::text AS last_day`;

// RF6: registrar un bloqueo de agenda. No cancela las citas reservadas que caen dentro; las devuelve
// en conflicts para que recepción las reprograme.
blockadesRouter.post('/', requireBlockadeWrite, async (req, res) => {
  const body = parse(createBlockadeSchema, req.body);
  assertCanManageProfessional(req.user, body.professionalId);

  const hasSingleDate = body.date !== undefined;
  const hasDateRange = body.startDate !== undefined || body.endDate !== undefined;
  if ((hasSingleDate && hasDateRange) || (!hasSingleDate && (body.startDate === undefined || body.endDate === undefined))) {
    throw new HttpError(400, 'Indique date o el par startDate y endDate');
  }

  const startDate = body.date ?? body.startDate;
  const endDate = body.date ?? body.endDate;
  if (startDate > endDate || (startDate === endDate && body.startTime >= body.endTime)) {
    throw new HttpError(400, 'El fin del bloqueo debe ser posterior al inicio');
  }

  const { clinicId, userId, dbRole } = req.user;

  const { created, conflicts } = await withTransaction(dbRole, async (client) => {
    const { rows: [check] } = await client.query(CHECK_PROFESSIONAL_SQL, [clinicId, body.professionalId]);
    if (!check.professional_ok) throw new HttpError(404, 'Profesional no encontrado');

    const { rows: [row] } = await client.query(INSERT_BLOCKADE_SQL, [
      clinicId,
      body.professionalId,
      startDate,
      body.startTime,
      endDate,
      body.endTime,
      body.reason,
      check.time_zone,
      userId,
    ]);

    const { rows: conflictRows } = await client.query(CONFLICTS_SQL, [
      clinicId, body.professionalId, row.blockadeId,
    ]);

    return { created: row, conflicts: conflictRows };
  });

  // Después del COMMIT: invalida las copias de disponibilidad de todos los días del bloqueo (I8).
  await bumpAgendaVersion({
    clinicId,
    professionalId: body.professionalId,
    firstDay: created.first_day,
    lastDay: created.last_day,
  });

  res.status(201).location(`/blockades/${created.blockadeId}`).json(formatBlockade(created, conflicts));
});

const CURRENT_BLOCKADE_SQL = `
  SELECT b.blockade_id, b.professional_id,
         (lower(b.period) AT TIME ZONE c.time_zone)::date::text AS first_day,
         ((upper(b.period) - interval '1 microsecond') AT TIME ZONE c.time_zone)::date::text AS last_day
    FROM blockades b
    JOIN clinics c ON c.clinic_id = b.clinic_id
   WHERE b.clinic_id = $1 AND b.blockade_id = $2`;

// RF6: eliminar un bloqueo de agenda.
blockadesRouter.delete('/:blockadeId', requireBlockadeWrite, async (req, res) => {
  const { blockadeId } = parse(blockadeIdParams, req.params);
  const { clinicId, dbRole } = req.user;

  const deleted = await withTransaction(dbRole, async (client) => {
    const { rows: [existing] } = await client.query(CURRENT_BLOCKADE_SQL, [clinicId, blockadeId]);
    if (!existing) throw new HttpError(404, 'Bloqueo no encontrado');
    assertCanManageProfessional(req.user, existing.professional_id);

    await client.query('DELETE FROM blockades WHERE clinic_id = $1 AND blockade_id = $2', [
      clinicId, blockadeId,
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
