// Módulo §9 (auditoría verificable): verificación criptográfica de la cadena de huellas SHA-256
// de clinical.audit_logs por clínica.
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { parse } from '@medicitas/common/errors';

export const auditRouter = Router();

const emptyQuerySchema = z.object({}).strict();

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
