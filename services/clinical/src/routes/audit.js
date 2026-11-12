// Bitácora de auditoría de la clínica (clinical.audit_logs):
// - RF19: consultarla con filtros por usuario, por paciente y por rango de fechas;
// - Módulo §9 (auditoría verificable): verificar la cadena de huellas SHA-256 por clínica.
// Las dos rutas exigen audit.read, que en la matriz solo tiene el administrador de la clínica.
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';

export const auditRouter = Router();

const emptyQuerySchema = z.object({}).strict();

// --- RF19: consulta con filtros ----------------------------------------------------------------------------------

// Paginación: 50 entradas por defecto, una pantalla de revisión, y 200 como máximo. Cada entrada lleva usuario, evento,
// descripción y metadata, así que 200 son unas decenas de KB. Más que eso pesa en cada respuesta y no se lee de una vez.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// from y to son opcionales; si vienen los dos, el rango no puede estar al revés. Los días 'YYYY-MM-DD' se comparan como
// texto. No hay tope de días, a diferencia de RF21 (366): aquí la paginación ya limita cada respuesta a MAX_LIMIT
// filas, sin importar cuán largo sea el rango, y un auditor sí necesita revisar períodos largos.
function assertValidRange(from, to) {
  if (from !== undefined && to !== undefined && from > to) {
    throw new HttpError(400, 'El rango de fechas está al revés: from es posterior a to');
  }
}

const id = z.coerce.number().int().positive().max(2147483647);
const auditQuerySchema = z.object({
  userId: id.optional(),
  patientId: id.optional(),
  from: z.iso.date().optional(),   // día 'YYYY-MM-DD' en la hora local de la clínica, inclusive
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  beforeId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), // log_id: la página siguiente
}).strict();

// De lo más reciente a lo más antiguo, por log_id: es el orden de la cadena de huellas (§9), y paginar es pedir
// log_id < beforeId. Recorre ix_audit_clinic_log (clinic_id, log_id); con patientId o userId puede usar
// ix_audit_clinic_patient_date o ix_audit_clinic_user_date. Los días se cuentan en la hora local de la clínica, igual
// que en RF21. Un filtro que apunta a otra clínica no encuentra nada, porque todo se filtra por la clínica del token.
const AUDIT_SQL = `
  SELECT l.log_id AS "logId",
         l.created_at AS "createdAt",
         l.user_id AS "userId",
         u.name || ' ' || u.last_name AS "userName",
         e.name AS event,
         d.name AS "dataObject",
         l.object_id AS "objectId",
         l.patient_id AS "patientId",
         l.description,
         l.metadata
    FROM clinics c
    JOIN audit_logs l   ON l.clinic_id = c.clinic_id
    JOIN users u        ON u.clinic_id = l.clinic_id AND u.user_id = l.user_id
    JOIN event_types e  ON e.event_type_id = l.event_type_id
    JOIN data_objects d ON d.data_object_id = l.data_object_id
   WHERE c.clinic_id = $1
     AND ($2::int    IS NULL OR l.user_id = $2)
     AND ($3::int    IS NULL OR l.patient_id = $3)
     AND ($4::date   IS NULL OR l.created_at >= $4::date::timestamp AT TIME ZONE c.time_zone)
     AND ($5::date   IS NULL OR l.created_at <  ($5::date + 1)::timestamp AT TIME ZONE c.time_zone)
     AND ($6::bigint IS NULL OR l.log_id < $6)
   ORDER BY l.log_id DESC
   LIMIT $7`;

// RF19: la bitácora de la clínica del token, con filtros opcionales y paginada. Responde
// { entries: [...], nextBeforeId }: si nextBeforeId no es null, la página siguiente se pide con ?beforeId=nextBeforeId.
auditRouter.get('/', requirePermission('audit.read'), async (req, res) => {
  const q = parse(auditQuerySchema, req.query);
  assertValidRange(q.from, q.to);

  const rows = await withTransaction(req.user.dbRole, async (client) => (await client.query(AUDIT_SQL, [
    req.user.clinicId, q.userId ?? null, q.patientId ?? null, q.from ?? null, q.to ?? null, q.beforeId ?? null, q.limit,
  ])).rows);

  const entries = rows.map((r) => ({ ...r, logId: Number(r.logId), objectId: Number(r.objectId) }));
  res.json({
    entries,
    nextBeforeId: entries.length === q.limit ? entries.at(-1).logId : null,
  });
});

// --- Módulo §9: verificación de la cadena ------------------------------------------------------------------------

// GET /audit/verify — recorre la cadena de huellas SHA-256 de la clínica del token y señala el
// primer registro roto si alguien alteró una fila o borró un eslabón intermedio (Módulo §9, I6).
auditRouter.get('/verify', requirePermission('audit.read'), async (req, res) => {
  parse(emptyQuerySchema, req.query);

  const result = await withTransaction(req.user.dbRole, async (client) => {
    const { rows } = await client.query(
      `SELECT is_valid            AS "valid",
              checked_count::int  AS "checkedCount",
              last_log_id::int    AS "lastLogId",
              last_row_hash       AS "lastRowHash",
              first_broken_log_id::int AS "firstBrokenLogId",
              failure_reason      AS "failureReason"
         FROM verify_audit_chain($1)`,
      [req.user.clinicId],
    );
    return rows[0];
  });

  res.json({
    clinicId: req.user.clinicId,
    ...result,
  });
});
