import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth.js';
import { withTransaction } from '../db.js';
import { HttpError, parse } from '../errors.js';
import { ROLE_ID, createAccount, personSchema } from '../accounts.js';
import * as keycloak from '../keycloak.js';

// RF2: gestión de los usuarios de la clínica (alta, baja lógica y asignación de rol).
// Todas las consultas filtran por req.user.clinicId: un usuario de otra clínica responde 404,
// igual que uno que no existe, para no revelar que existe (I5).
export const usersRouter = Router();
usersRouter.use(requirePermission('users.manage'));

// Los profesionales tienen datos propios (licencia, especialidades, servicios) y se dan de alta
// y cambian de rol por /professionals (RF4). Aquí solo se manejan estos dos roles.
const MANAGED_ROLES = ['clinic_admin', 'reception'];

const userIdSchema = z.object({ userId: z.coerce.number().int().positive().max(2147483647) });

const newUserSchema = personSchema.extend({ role: z.enum(MANAGED_ROLES) });

const updateUserSchema = z.object({
  role: z.enum(MANAGED_ROLES).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((b) => b.role !== undefined || b.isActive !== undefined, 'Indique role, isActive o ambos');

const SELECT_USER = `
  SELECT u.user_id, u.name, u.last_name, r.role_name, u.is_active, u.created_at, u.updated_at
    FROM users u
    JOIN roles r ON r.role_id = u.role_id
   WHERE u.clinic_id = $1`;

function toUser(row) {
  return {
    userId: row.user_id,
    name: row.name,
    lastName: row.last_name,
    role: row.role_name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

usersRouter.get('/', async (req, res) => {
  const rows = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query(`${SELECT_USER} ORDER BY u.last_name, u.name`, [req.user.clinicId])).rows);
  res.json(rows.map(toUser));
});

usersRouter.get('/:userId', async (req, res) => {
  const { userId } = parse(userIdSchema, req.params);
  const row = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query(`${SELECT_USER} AND u.user_id = $2`, [req.user.clinicId, userId])).rows[0]);
  if (!row) {
    throw new HttpError(404, 'Usuario no encontrado');
  }
  res.json(toUser(row));
});

// Alta: cuenta en Keycloak y fila en users en la clínica de quien la crea (ver createAccount).
usersRouter.post('/', async (req, res) => {
  const { role, ...person } = parse(newUserSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const row = await createAccount(person, role, (sub) =>
    withTransaction(dbRole, async (client) => {
      const { rows: [created] } = await client.query(
        `INSERT INTO users (keycloak_sub, clinic_id, role_id, name, last_name, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING user_id`,
        [sub, clinicId, ROLE_ID[role], person.name, person.lastName, userId],
      );
      return (await client.query(`${SELECT_USER} AND u.user_id = $2`, [clinicId, created.user_id])).rows[0];
    }));

  res.status(201).json({ ...toUser(row), username: person.username });
});

// Cambio de rol y baja lógica (isActive: false) o reactivación.
// Primero se confirma en la base y después se replica en Keycloak. Si Keycloak falla, las dos
// copias quedan distintas, pero el sistema falla cerrado en todos los casos:
//   - rol distinto en cada lado: identify responde 403 por rol que no coincide;
//   - baja: la base ya lo tiene inactivo, identify responde 403;
//   - reactivación: Keycloak sigue sin entregarle tokens.
// Como las operaciones en Keycloak son idempotentes, repetir la petición corrige la diferencia.
usersRouter.patch('/:userId', async (req, res) => {
  const { userId: targetId } = parse(userIdSchema, req.params);
  const body = parse(updateUserSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const { row, keycloakSub } = await withTransaction(dbRole, async (client) => {
    const { rows: [target] } = await client.query(
      `SELECT u.keycloak_sub, r.role_name
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
        WHERE u.clinic_id = $1 AND u.user_id = $2
          FOR UPDATE OF u`,
      [clinicId, targetId],
    );
    if (!target) {
      throw new HttpError(404, 'Usuario no encontrado');
    }
    if (targetId === userId) {
      throw new HttpError(409, 'No puede cambiar su propio rol ni darse de baja a sí mismo');
    }
    if (body.role !== undefined && target.role_name === 'professional') {
      throw new HttpError(409, 'El rol de un profesional no se cambia aquí: se gestiona en /professionals');
    }

    await client.query(
      `UPDATE users
          SET role_id = COALESCE($3, role_id),
              is_active = COALESCE($4, is_active),
              updated_by = $5
        WHERE clinic_id = $1 AND user_id = $2`,
      [clinicId, targetId, body.role ? ROLE_ID[body.role] : null, body.isActive ?? null, userId],
    );
    const updated = (await client.query(`${SELECT_USER} AND u.user_id = $2`, [clinicId, targetId])).rows[0];
    return { row: updated, keycloakSub: target.keycloak_sub };
  });

  try {
    if (body.role !== undefined) {
      await keycloak.setRealmRole(keycloakSub, body.role);
    }
    if (body.isActive !== undefined) {
      await keycloak.setEnabled(keycloakSub, body.isActive);
    }
  } catch (err) {
    console.error(`No se pudo replicar en Keycloak el cambio del usuario ${targetId}`, err);
    throw new HttpError(502, 'El cambio quedó guardado en MediCitas pero no se pudo aplicar en Keycloak. '
      + 'Mientras tanto el usuario no puede operar; repita la solicitud.');
  }

  res.json(toUser(row));
});
