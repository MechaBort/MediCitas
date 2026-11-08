import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { ROLE_ID, createAccount, personSchema } from '../accounts.js';

export const clinicsRouter = Router();

const newClinicSchema = z.object({
  clinicCode: z.string().trim().min(1).max(30),
  clinicName: z.string().trim().min(1).max(75),
  timeZone: z.string().trim().min(1).max(64),
  admin: personSchema,
}).strict();

// RF1: alta de una clínica junto con su primer administrador. Solo el administrador de plataforma.
clinicsRouter.post('/', requirePermission('clinics.create'), async (req, res) => {
  const body = parse(newClinicSchema, req.body);
  const { userId, dbRole } = req.user;

  // Se revisa antes de tocar Keycloak, para no crear un usuario que luego haya que borrar.
  // Si dos altas con el mismo código compiten, la garantía real sigue siendo el UNIQUE.
  await withTransaction(dbRole, async (client) => {
    const tz = await client.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [body.timeZone]);
    if (tz.rowCount === 0) {
      throw new HttpError(400, 'Zona horaria desconocida: use un nombre IANA, por ejemplo America/Costa_Rica');
    }
    const duplicate = await client.query('SELECT 1 FROM clinics WHERE clinic_code = $1', [body.clinicCode]);
    if (duplicate.rowCount > 0) {
      throw new HttpError(409, 'Ya existe una clínica con ese código');
    }
  });

  const { clinic, adminUserId } = await createAccount(body.admin, 'clinic_admin', (sub) =>
    withTransaction(dbRole, async (client) => {
      const clinicRow = (await client.query(
        `INSERT INTO clinics (clinic_code, clinic_name, time_zone, updated_by)
         VALUES ($1, $2, $3, $4)
         RETURNING clinic_id, clinic_code, clinic_name, time_zone, is_active`,
        [body.clinicCode, body.clinicName, body.timeZone, userId],
      )).rows[0];

      const adminRow = (await client.query(
        `INSERT INTO users (keycloak_sub, clinic_id, role_id, name, last_name, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING user_id`,
        [sub, clinicRow.clinic_id, ROLE_ID.clinic_admin, body.admin.name, body.admin.lastName, userId],
      )).rows[0];

      return { clinic: clinicRow, adminUserId: adminRow.user_id };
    }));

  res.status(201).json({
    clinicId: clinic.clinic_id,
    clinicCode: clinic.clinic_code,
    clinicName: clinic.clinic_name,
    timeZone: clinic.time_zone,
    isActive: clinic.is_active,
    admin: {
      userId: adminUserId,
      username: body.admin.username,
      name: body.admin.name,
      lastName: body.admin.lastName,
      role: 'clinic_admin',
    },
  });
});
