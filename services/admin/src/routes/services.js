import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';

// RF3: catálogo de servicios de la clínica (nombre, duración en minutos y especialidad requerida).
// Todas las consultas filtran por req.user.clinicId: un servicio de otra clínica responde 404,
// igual que uno que no existe (I5).
export const servicesRouter = Router();
servicesRouter.use(requirePermission('services.manage'));

const id = z.number().int().positive().max(2147483647);
const serviceIdSchema = z.object({ serviceId: z.coerce.number().int().positive().max(2147483647) });

const newServiceSchema = z.object({
  serviceName: z.string().trim().min(1).max(63),
  durationMinutes: z.number().int().positive().max(1440),
  specialtyId: id,
}).strict();

const updateServiceSchema = z.object({
  serviceName: z.string().trim().min(1).max(63).optional(),
  durationMinutes: z.number().int().positive().max(1440).optional(),
  specialtyId: id.optional(),
  isActive: z.boolean().optional(),
}).strict().refine(
  (b) => b.serviceName !== undefined || b.durationMinutes !== undefined
    || b.specialtyId !== undefined || b.isActive !== undefined,
  'Indique al menos un campo para actualizar',
);

const SELECT_SERVICE = `
  SELECT s.service_id, s.service_name, s.duration_minutes, s.specialty_id,
         sp.specialty_name, s.is_active, s.created_at, s.updated_at
    FROM services s
    JOIN specialties sp ON sp.specialty_id = s.specialty_id
   WHERE s.clinic_id = $1`;

function toService(row) {
  return {
    serviceId: row.service_id,
    serviceName: row.service_name,
    durationMinutes: row.duration_minutes,
    specialtyId: row.specialty_id,
    specialtyName: row.specialty_name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Catálogo global de especialidades médicas, para saber qué specialtyId usar al crear servicios o profesionales.
servicesRouter.get('/specialties', async (req, res) => {
  const rows = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query('SELECT specialty_id, specialty_name FROM specialties ORDER BY specialty_id')).rows);
  res.json(rows.map((r) => ({ specialtyId: r.specialty_id, specialtyName: r.specialty_name })));
});

servicesRouter.get('/', async (req, res) => {
  const rows = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query(`${SELECT_SERVICE} ORDER BY s.service_name, s.service_id`, [req.user.clinicId])).rows);
  res.json(rows.map(toService));
});

servicesRouter.get('/:serviceId', async (req, res) => {
  const { serviceId } = parse(serviceIdSchema, req.params);
  const row = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query(`${SELECT_SERVICE} AND s.service_id = $2`, [req.user.clinicId, serviceId])).rows[0]);
  if (!row) {
    throw new HttpError(404, 'Servicio no encontrado');
  }
  res.json(toService(row));
});

servicesRouter.post('/', async (req, res) => {
  const body = parse(newServiceSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const row = await withTransaction(dbRole, async (client) => {
    const { rowCount: specialtyExists } = await client.query(
      'SELECT 1 FROM specialties WHERE specialty_id = $1',
      [body.specialtyId],
    );
    if (specialtyExists === 0) {
      throw new HttpError(404, 'Especialidad no encontrada');
    }

    const { rows: [created] } = await client.query(
      `INSERT INTO services (clinic_id, service_name, duration_minutes, specialty_id, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING service_id`,
      [clinicId, body.serviceName, body.durationMinutes, body.specialtyId, userId],
    );
    return (await client.query(`${SELECT_SERVICE} AND s.service_id = $2`, [clinicId, created.service_id])).rows[0];
  });

  res.status(201).location(`/services/${row.service_id}`).json(toService(row));
});

servicesRouter.patch('/:serviceId', async (req, res) => {
  const { serviceId } = parse(serviceIdSchema, req.params);
  const body = parse(updateServiceSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const row = await withTransaction(dbRole, async (client) => {
    const { rowCount: exists } = await client.query(
      'SELECT 1 FROM services WHERE clinic_id = $1 AND service_id = $2 FOR UPDATE',
      [clinicId, serviceId],
    );
    if (exists === 0) {
      throw new HttpError(404, 'Servicio no encontrado');
    }

    if (body.specialtyId !== undefined) {
      const { rowCount: specialtyExists } = await client.query(
        'SELECT 1 FROM specialties WHERE specialty_id = $1',
        [body.specialtyId],
      );
      if (specialtyExists === 0) {
        throw new HttpError(404, 'Especialidad no encontrada');
      }
    }

    await client.query(
      `UPDATE services
          SET service_name = COALESCE($3, service_name),
              duration_minutes = COALESCE($4, duration_minutes),
              specialty_id = COALESCE($5, specialty_id),
              is_active = COALESCE($6, is_active),
              updated_by = $7
        WHERE clinic_id = $1 AND service_id = $2`,
      [
        clinicId,
        serviceId,
        body.serviceName ?? null,
        body.durationMinutes ?? null,
        body.specialtyId ?? null,
        body.isActive ?? null,
        userId,
      ],
    );
    return (await client.query(`${SELECT_SERVICE} AND s.service_id = $2`, [clinicId, serviceId])).rows[0];
  });

  res.json(toService(row));
});
