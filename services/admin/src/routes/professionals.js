import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { ROLE_ID, createAccount, personSchema } from '../accounts.js';
import * as keycloak from '../keycloak.js';

// RF4: registro de profesionales con su especialidad y asociación de los servicios que están
// habilitados para atender. Todas las consultas filtran por req.user.clinicId: un profesional
// o un servicio de otra clínica responde 404, igual que uno que no existe (I5).
export const professionalsRouter = Router();
professionalsRouter.use(requirePermission('professionals.manage'));

const id = z.number().int().positive().max(2147483647);
const professionalIdSchema = z.object({ professionalId: z.coerce.number().int().positive().max(2147483647) });

const newProfessionalSchema = personSchema.extend({
  licenseNumber: z.string().trim().min(1).max(30),
  specialtyIds: z.array(id).min(1),
  serviceIds: z.array(id).default([]),
  phone: z.string().trim().min(1).max(320).optional(),
}).strict();

const updateProfessionalSchema = z.object({
  licenseNumber: z.string().trim().min(1).max(30).optional(),
  specialtyIds: z.array(id).min(1).optional(),
  serviceIds: z.array(id).optional(),
  isActive: z.boolean().optional(),
}).strict().refine(
  (b) => b.licenseNumber !== undefined || b.specialtyIds !== undefined
    || b.serviceIds !== undefined || b.isActive !== undefined,
  'Indique al menos un campo para actualizar',
);

const setServicesSchema = z.object({
  serviceIds: z.array(id),
}).strict();

const SELECT_PROFESSIONAL = `
  SELECT u.user_id, u.name, u.last_name, p.license_number,
         (u.is_active AND p.is_active) AS is_active,
         p.created_at, p.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
             'specialtyId', sp.specialty_id,
             'specialtyName', sp.specialty_name
           ) ORDER BY sp.specialty_name, sp.specialty_id)
             FROM specialties_per_professionals spp
             JOIN specialties sp ON sp.specialty_id = spp.specialty_id
            WHERE spp.professional_id = u.user_id AND spp.is_active
         ), '[]'::json) AS specialties,
         COALESCE((
           SELECT json_agg(json_build_object(
             'serviceId', s.service_id,
             'serviceName', s.service_name,
             'durationMinutes', s.duration_minutes,
             'specialtyId', s.specialty_id
           ) ORDER BY s.service_name, s.service_id)
             FROM services_per_professionals svp
             JOIN services s ON s.clinic_id = svp.clinic_id AND s.service_id = svp.service_id
            WHERE svp.clinic_id = u.clinic_id AND svp.professional_id = u.user_id
              AND svp.is_active AND s.is_active
         ), '[]'::json) AS services,
         COALESCE((
           SELECT json_agg(json_build_object(
             'contactId', pc.contact_id,
             'type', ct.contact_type_name,
             'value', pc.contact_value
           ) ORDER BY pc.contact_id)
             FROM professional_contacts pc
             JOIN contact_types ct ON ct.contact_type_id = pc.contact_type_id
            WHERE pc.clinic_id = u.clinic_id AND pc.professional_id = u.user_id AND pc.is_active
         ), '[]'::json) AS contacts
    FROM users u
    JOIN professionals p ON p.user_id = u.user_id
   WHERE u.clinic_id = $1`;

function toProfessional(row) {
  return {
    professionalId: row.user_id,
    userId: row.user_id,
    name: row.name,
    lastName: row.last_name,
    role: 'professional',
    licenseNumber: row.license_number,
    isActive: row.is_active,
    specialties: row.specialties,
    services: row.services,
    contacts: row.contacts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Comprueba que todas las especialidades existan, que todos los servicios pertenezcan a la clínica
// y estén activos (I5), y que el profesional tenga la especialidad requerida por cada servicio (RF3, RF4).
async function validateSpecialtiesAndServices(client, clinicId, specialtyIds, serviceIds) {
  const uniqueSpecialties = [...new Set(specialtyIds)];
  const uniqueServices = [...new Set(serviceIds)];

  const { rows: foundSpecialties } = await client.query(
    'SELECT specialty_id FROM specialties WHERE specialty_id = ANY($1::int[])',
    [uniqueSpecialties],
  );
  if (foundSpecialties.length !== uniqueSpecialties.length) {
    throw new HttpError(404, 'Especialidad no encontrada');
  }

  if (uniqueServices.length > 0) {
    const { rows: foundServices } = await client.query(
      `SELECT service_id, specialty_id
         FROM services
        WHERE clinic_id = $1 AND service_id = ANY($2::int[]) AND is_active`,
      [clinicId, uniqueServices],
    );
    if (foundServices.length !== uniqueServices.length) {
      throw new HttpError(404, 'Servicio no encontrado');
    }

    const specialtySet = new Set(uniqueSpecialties);
    for (const svc of foundServices) {
      if (!specialtySet.has(svc.specialty_id)) {
        throw new HttpError(400, 'El profesional no tiene la especialidad que requiere el servicio');
      }
    }
  }

  return { uniqueSpecialties, uniqueServices };
}

// Sincroniza las especialidades y los servicios habilitados usando is_active en lugar de DELETE,
// para no romper la FK de citas históricas hacia services_per_professionals.
async function syncSpecialties(client, professionalId, uniqueSpecialties, updatedBy) {
  await client.query(
    `UPDATE specialties_per_professionals
        SET is_active = false, updated_by = $2
      WHERE professional_id = $1 AND is_active AND NOT (specialty_id = ANY($3::int[]))`,
    [professionalId, updatedBy, uniqueSpecialties],
  );
  await client.query(
    `INSERT INTO specialties_per_professionals (professional_id, specialty_id, is_active, updated_by)
     SELECT $1, unnest($2::int[]), true, $3
     ON CONFLICT (professional_id, specialty_id)
     DO UPDATE SET is_active = true, updated_by = EXCLUDED.updated_by
      WHERE NOT specialties_per_professionals.is_active`,
    [professionalId, uniqueSpecialties, updatedBy],
  );
}

async function syncServices(client, clinicId, professionalId, uniqueServices, updatedBy) {
  await client.query(
    `UPDATE services_per_professionals
        SET is_active = false, updated_by = $3
      WHERE clinic_id = $1 AND professional_id = $2 AND is_active AND NOT (service_id = ANY($4::int[]))`,
    [clinicId, professionalId, updatedBy, uniqueServices],
  );
  if (uniqueServices.length > 0) {
    await client.query(
      `INSERT INTO services_per_professionals (clinic_id, professional_id, service_id, is_active, updated_by)
       SELECT $1, $2, unnest($3::int[]), true, $4
       ON CONFLICT (clinic_id, professional_id, service_id)
       DO UPDATE SET is_active = true, updated_by = EXCLUDED.updated_by
        WHERE NOT services_per_professionals.is_active`,
      [clinicId, professionalId, uniqueServices, updatedBy],
    );
  }
}

professionalsRouter.get('/', async (req, res) => {
  const rows = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query(`${SELECT_PROFESSIONAL} ORDER BY u.last_name, u.name, u.user_id`, [req.user.clinicId])).rows);
  res.json(rows.map(toProfessional));
});

professionalsRouter.get('/:professionalId', async (req, res) => {
  const { professionalId } = parse(professionalIdSchema, req.params);
  const row = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query(`${SELECT_PROFESSIONAL} AND u.user_id = $2`, [req.user.clinicId, professionalId])).rows[0]);
  if (!row) {
    throw new HttpError(404, 'Profesional no encontrado');
  }
  res.json(toProfessional(row));
});

// Alta de un profesional: se validan las especialidades y servicios antes de tocar Keycloak, luego se
// crea la cuenta con rol `professional` (ver createAccount) y se insertan users, professionals,
// especialidades, servicios habilitados y contactos dentro de una sola transacción.
professionalsRouter.post('/', async (req, res) => {
  const { licenseNumber, specialtyIds, serviceIds, phone, ...person } = parse(newProfessionalSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  await withTransaction(dbRole, (client) =>
    validateSpecialtiesAndServices(client, clinicId, specialtyIds, serviceIds));

  const row = await createAccount(person, 'professional', (sub) =>
    withTransaction(dbRole, async (client) => {
      const { uniqueSpecialties, uniqueServices } = await validateSpecialtiesAndServices(
        client,
        clinicId,
        specialtyIds,
        serviceIds,
      );

      const { rows: [created] } = await client.query(
        `INSERT INTO users (keycloak_sub, clinic_id, role_id, name, last_name, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING user_id`,
        [sub, clinicId, ROLE_ID.professional, person.name, person.lastName, userId],
      );
      const professionalId = created.user_id;

      await client.query(
        `INSERT INTO professionals (user_id, license_number, updated_by)
         VALUES ($1, $2, $3)`,
        [professionalId, licenseNumber, userId],
      );

      await syncSpecialties(client, professionalId, uniqueSpecialties, userId);
      await syncServices(client, clinicId, professionalId, uniqueServices, userId);

      await client.query(
        `INSERT INTO professional_contacts (clinic_id, professional_id, contact_type_id, contact_value, updated_by)
         SELECT $1, $2, contact_type_id, $3, $4
           FROM contact_types
          WHERE contact_type_name = 'email'`,
        [clinicId, professionalId, person.email, userId],
      );
      if (phone !== undefined) {
        await client.query(
          `INSERT INTO professional_contacts (clinic_id, professional_id, contact_type_id, contact_value, updated_by)
           SELECT $1, $2, contact_type_id, $3, $4
             FROM contact_types
            WHERE contact_type_name = 'telefono'`,
          [clinicId, professionalId, phone, userId],
        );
      }

      return (await client.query(`${SELECT_PROFESSIONAL} AND u.user_id = $2`, [clinicId, professionalId])).rows[0];
    }));

  res.status(201).location(`/professionals/${row.user_id}`).json({
    ...toProfessional(row),
    username: person.username,
  });
});

// Actualización de licencia, especialidades, servicios habilitados o estado activo/inactivo.
professionalsRouter.patch('/:professionalId', async (req, res) => {
  const { professionalId } = parse(professionalIdSchema, req.params);
  const body = parse(updateProfessionalSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const { row, keycloakSub } = await withTransaction(dbRole, async (client) => {
    const { rows: [target] } = await client.query(
      `SELECT u.keycloak_sub
         FROM users u
         JOIN professionals p ON p.user_id = u.user_id
        WHERE u.clinic_id = $1 AND u.user_id = $2
          FOR UPDATE OF u, p`,
      [clinicId, professionalId],
    );
    if (!target) {
      throw new HttpError(404, 'Profesional no encontrado');
    }

    if (body.specialtyIds !== undefined || body.serviceIds !== undefined) {
      const effectiveSpecialties = body.specialtyIds ?? (await client.query(
        'SELECT specialty_id FROM specialties_per_professionals WHERE professional_id = $1 AND is_active',
        [professionalId],
      )).rows.map((r) => r.specialty_id);

      const effectiveServices = body.serviceIds ?? (await client.query(
        `SELECT svp.service_id
           FROM services_per_professionals svp
           JOIN services s ON s.clinic_id = svp.clinic_id AND s.service_id = svp.service_id
          WHERE svp.clinic_id = $1 AND svp.professional_id = $2 AND svp.is_active AND s.is_active`,
        [clinicId, professionalId],
      )).rows.map((r) => r.service_id);

      const { uniqueSpecialties, uniqueServices } = await validateSpecialtiesAndServices(
        client,
        clinicId,
        effectiveSpecialties,
        effectiveServices,
      );

      if (body.specialtyIds !== undefined) {
        await syncSpecialties(client, professionalId, uniqueSpecialties, userId);
      }
      if (body.serviceIds !== undefined) {
        await syncServices(client, clinicId, professionalId, uniqueServices, userId);
      }
    }

    if (body.licenseNumber !== undefined || body.isActive !== undefined) {
      await client.query(
        `UPDATE professionals
            SET license_number = COALESCE($2, license_number),
                is_active = COALESCE($3, is_active),
                updated_by = $4
          WHERE user_id = $1`,
        [professionalId, body.licenseNumber ?? null, body.isActive ?? null, userId],
      );
    }

    if (body.isActive !== undefined) {
      await client.query(
        `UPDATE users
            SET is_active = $3,
                updated_by = $4
          WHERE clinic_id = $1 AND user_id = $2`,
        [clinicId, professionalId, body.isActive, userId],
      );
    }

    const updated = (await client.query(`${SELECT_PROFESSIONAL} AND u.user_id = $2`, [clinicId, professionalId])).rows[0];
    return { row: updated, keycloakSub: target.keycloak_sub };
  });

  if (body.isActive !== undefined) {
    try {
      await keycloak.setEnabled(keycloakSub, body.isActive);
    } catch (err) {
      console.error(`No se pudo replicar en Keycloak el cambio del profesional ${professionalId}`, err);
      throw new HttpError(502, 'El cambio quedó guardado en MediCitas pero no se pudo aplicar en Keycloak. '
        + 'Mientras tanto el profesional no puede operar; repita la solicitud.');
    }
  }

  res.json(toProfessional(row));
});

// Ruta dedicada para reemplazar la lista de servicios que el profesional está habilitado para atender (RF4).
professionalsRouter.put('/:professionalId/services', async (req, res) => {
  const { professionalId } = parse(professionalIdSchema, req.params);
  const { serviceIds } = parse(setServicesSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const row = await withTransaction(dbRole, async (client) => {
    const { rowCount: exists } = await client.query(
      `SELECT 1
         FROM users u
         JOIN professionals p ON p.user_id = u.user_id
        WHERE u.clinic_id = $1 AND u.user_id = $2
          FOR UPDATE OF u, p`,
      [clinicId, professionalId],
    );
    if (exists === 0) {
      throw new HttpError(404, 'Profesional no encontrado');
    }

    const currentSpecialties = (await client.query(
      'SELECT specialty_id FROM specialties_per_professionals WHERE professional_id = $1 AND is_active',
      [professionalId],
    )).rows.map((r) => r.specialty_id);

    const { uniqueServices } = await validateSpecialtiesAndServices(
      client,
      clinicId,
      currentSpecialties,
      serviceIds,
    );
    await syncServices(client, clinicId, professionalId, uniqueServices, userId);

    return (await client.query(`${SELECT_PROFESSIONAL} AND u.user_id = $2`, [clinicId, professionalId])).rows[0];
  });

  res.json(toProfessional(row));
});
