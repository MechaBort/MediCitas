import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { logAuditEvent } from '../audit.js';

// Gestión de pacientes de la clínica (RF14) y registro en bitácora de toda lectura y escritura de
// sus datos de contacto (RF18, I6). Todas las consultas filtran por req.user.clinicId: un paciente
// de otra clínica responde 404, igual que uno inexistente (I5).
export const patientsRouter = Router();

const idParam = z.object({
  patientId: z.coerce.number().int().positive().max(2147483647),
});

const GENDER_ID_BY_NAME = {
  femenino: 1,
  masculino: 2,
  otro: 3,
  'prefiere no decir': 4,
};

const genderEnum = z.enum(['femenino', 'masculino', 'otro', 'prefiere no decir']);

const contactSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('telefono'),
    value: z.string().trim().min(3).max(50),
  }).strict(),
  z.object({
    type: z.literal('email'),
    value: z.email().max(320),
  }).strict(),
]);

const createPatientSchema = z.object({
  identification: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  birthDate: z.iso.date(),
  gender: genderEnum.nullable().optional(),
  genderId: z.number().int().min(1).max(4).nullable().optional(),
  contacts: z.array(contactSchema).max(10).optional().default([]),
}).strict();

const updatePatientSchema = z.object({
  identification: z.string().trim().min(1).max(30).optional(),
  name: z.string().trim().min(1).max(50).optional(),
  lastName: z.string().trim().min(1).max(50).optional(),
  birthDate: z.iso.date().optional(),
  gender: genderEnum.nullable().optional(),
  genderId: z.number().int().min(1).max(4).nullable().optional(),
  isActive: z.boolean().optional(),
  contacts: z.array(contactSchema).max(10).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'Debe enviar al menos un campo para actualizar',
});

function resolveGenderId(body, fallback = null) {
  if (body.gender !== undefined && body.genderId !== undefined) {
    const mapped = body.gender === null ? null : GENDER_ID_BY_NAME[body.gender];
    if (mapped !== body.genderId) {
      throw new HttpError(400, 'gender y genderId no coinciden');
    }
    return mapped;
  }
  if (body.gender !== undefined) {
    return body.gender === null ? null : GENDER_ID_BY_NAME[body.gender];
  }
  if (body.genderId !== undefined) {
    return body.genderId;
  }
  return fallback;
}

function assertUniqueContacts(contacts) {
  const seen = new Set();
  for (const c of contacts) {
    const key = `${c.type}:${c.value.toLowerCase()}`;
    if (seen.has(key)) {
      throw new HttpError(400, 'No se permiten contactos duplicados en la misma solicitud');
    }
    seen.add(key);
  }
}

const PATIENT_SELECT_SQL = `
  SELECT p.patient_id AS "patientId",
         p.identification,
         p.name,
         p.last_name AS "lastName",
         p.birth_date::text AS "birthDate",
         p.gender_id AS "genderId",
         g.gender_name AS gender,
         p.is_active AS "isActive",
         p.created_at AS "createdAt",
         p.updated_at AS "updatedAt"
    FROM patients p
    LEFT JOIN genders g ON g.gender_id = p.gender_id`;

const CONTACTS_SELECT_SQL = `
  SELECT pc.contact_id AS "contactId",
         ct.contact_type_name AS type,
         pc.contact_value AS value
    FROM patient_contacts pc
    JOIN contact_types ct ON ct.contact_type_id = pc.contact_type_id
   WHERE pc.clinic_id = $1 AND pc.patient_id = $2 AND pc.is_active
   ORDER BY pc.contact_id`;

// Catálogo de géneros para formularios de registro de pacientes (RF14).
patientsRouter.get('/genders', requirePermission('patients.read'), async (req, res) => {
  const rows = await withTransaction(req.user.dbRole, async (client) =>
    (await client.query('SELECT gender_id AS "genderId", gender_name AS name FROM genders ORDER BY gender_id')).rows);
  res.json(rows);
});

// RF14: listar el directorio de pacientes de la clínica del token. No incluye patient_contacts
// para no generar lecturas masivas de datos sensibles en la bitácora; los contactos se leen en
// GET /patients/:patientId.
patientsRouter.get('/', requirePermission('patients.read'), async (req, res) => {
  const { clinicId, dbRole } = req.user;
  const rows = await withTransaction(dbRole, async (client) =>
    (await client.query(
      `${PATIENT_SELECT_SQL} WHERE p.clinic_id = $1 ORDER BY p.patient_id`,
      [clinicId],
    )).rows);
  res.json(rows);
});

// RF14, RF18: consultar un paciente de la clínica junto con sus datos de contacto activos. Cada
// contacto leído se registra en audit_logs dentro de la misma transacción.
patientsRouter.get('/:patientId', requirePermission('patients.read'), async (req, res) => {
  const { patientId } = parse(idParam, req.params);
  const { clinicId, userId, dbRole } = req.user;

  const patient = await withTransaction(dbRole, async (client) => {
    const { rows: [row] } = await client.query(
      `${PATIENT_SELECT_SQL} WHERE p.clinic_id = $1 AND p.patient_id = $2`,
      [clinicId, patientId],
    );
    if (!row) throw new HttpError(404, 'Paciente no encontrado');

    const { rows: contacts } = await client.query(CONTACTS_SELECT_SQL, [clinicId, patientId]);
    for (const contact of contacts) {
      await logAuditEvent(client, {
        clinicId,
        userId,
        eventType: 'read',
        dataObject: 'patient_contact',
        objectId: contact.contactId,
        patientId,
        description: `Lectura de contacto (${contact.type}) del paciente`,
        metadata: { type: contact.type },
      });
    }

    return { ...row, contacts };
  });

  res.json(patient);
});

// RF14, RF18: registrar un paciente en la clínica del token, con sus datos de contacto.
patientsRouter.post('/', requirePermission('patients.write'), async (req, res) => {
  const body = parse(createPatientSchema, req.body);
  const genderId = resolveGenderId(body, null);
  assertUniqueContacts(body.contacts);
  const { clinicId, userId, dbRole } = req.user;

  const created = await withTransaction(dbRole, async (client) => {
    const { rows: [dateCheck] } = await client.query(
      'SELECT $1::date > current_date AS in_future',
      [body.birthDate],
    );
    if (dateCheck.in_future) {
      throw new HttpError(400, 'La fecha de nacimiento no puede ser futura');
    }

    const { rows: [inserted] } = await client.query(
      `INSERT INTO patients (clinic_id, identification, name, last_name, birth_date, gender_id, updated_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7)
       RETURNING patient_id`,
      [clinicId, body.identification, body.name, body.lastName, body.birthDate, genderId, userId],
    );
    const patientId = inserted.patient_id;

    const contacts = [];
    for (const c of body.contacts) {
      const { rows: [contactRow] } = await client.query(
        `INSERT INTO patient_contacts (clinic_id, patient_id, contact_type_id, contact_value, updated_by)
         SELECT $1, $2, ct.contact_type_id, $4, $5
           FROM contact_types ct
          WHERE ct.contact_type_name = $3
         RETURNING contact_id AS "contactId", $3::text AS type, contact_value AS value`,
        [clinicId, patientId, c.type, c.value, userId],
      );
      contacts.push(contactRow);

      await logAuditEvent(client, {
        clinicId,
        userId,
        eventType: 'create',
        dataObject: 'patient_contact',
        objectId: contactRow.contactId,
        patientId,
        description: `Creación de contacto (${c.type}) del paciente`,
        metadata: { type: c.type },
      });
    }

    const { rows: [row] } = await client.query(
      `${PATIENT_SELECT_SQL} WHERE p.clinic_id = $1 AND p.patient_id = $2`,
      [clinicId, patientId],
    );
    return { ...row, contacts };
  });

  res.status(201).location(`/patients/${created.patientId}`).json(created);
});

// RF14, RF18: actualizar los datos de un paciente y/o sus contactos. Los contactos que se retiran
// se dan de baja lógica (is_active = false, porque mc_clinic_admin y mc_reception no tienen DELETE
// sobre patient_contacts) y cada cambio queda registrado en audit_logs.
patientsRouter.patch('/:patientId', requirePermission('patients.write'), async (req, res) => {
  const { patientId } = parse(idParam, req.params);
  const body = parse(updatePatientSchema, req.body);
  if (body.contacts !== undefined) {
    assertUniqueContacts(body.contacts);
  }
  const { clinicId, userId, dbRole } = req.user;

  const updated = await withTransaction(dbRole, async (client) => {
    const { rows: [current] } = await client.query(
      'SELECT * FROM patients WHERE clinic_id = $1 AND patient_id = $2',
      [clinicId, patientId],
    );
    if (!current) throw new HttpError(404, 'Paciente no encontrado');

    const birthDate = body.birthDate ?? current.birth_date;
    if (body.birthDate !== undefined) {
      const { rows: [dateCheck] } = await client.query(
        'SELECT $1::date > current_date AS in_future',
        [body.birthDate],
      );
      if (dateCheck.in_future) {
        throw new HttpError(400, 'La fecha de nacimiento no puede ser futura');
      }
    }

    const genderId = resolveGenderId(body, current.gender_id);
    const identification = body.identification ?? current.identification;
    const name = body.name ?? current.name;
    const lastName = body.lastName ?? current.last_name;
    const isActive = body.isActive ?? current.is_active;

    await client.query(
      `UPDATE patients
          SET identification = $3,
              name = $4,
              last_name = $5,
              birth_date = $6::date,
              gender_id = $7,
              is_active = $8,
              updated_by = $9
        WHERE clinic_id = $1 AND patient_id = $2`,
      [clinicId, patientId, identification, name, lastName, birthDate, genderId, isActive, userId],
    );

    if (body.contacts !== undefined) {
      const { rows: existingContacts } = await client.query(
        `SELECT pc.contact_id AS "contactId", ct.contact_type_name AS type, pc.contact_value AS value
           FROM patient_contacts pc
           JOIN contact_types ct ON ct.contact_type_id = pc.contact_type_id
          WHERE pc.clinic_id = $1 AND pc.patient_id = $2 AND pc.is_active
          ORDER BY pc.contact_id`,
        [clinicId, patientId],
      );

      const desiredKeys = new Set(body.contacts.map((c) => `${c.type}:${c.value}`));
      const existingKeys = new Set(existingContacts.map((c) => `${c.type}:${c.value}`));

      // Baja lógica de los contactos que ya no están en la nueva lista.
      for (const oldContact of existingContacts) {
        if (!desiredKeys.has(`${oldContact.type}:${oldContact.value}`)) {
          await client.query(
            `UPDATE patient_contacts
                SET is_active = false, updated_by = $3
              WHERE clinic_id = $1 AND contact_id = $2`,
            [clinicId, oldContact.contactId, userId],
          );
          await logAuditEvent(client, {
            clinicId,
            userId,
            eventType: 'delete',
            dataObject: 'patient_contact',
            objectId: oldContact.contactId,
            patientId,
            description: `Baja lógica de contacto (${oldContact.type}) del paciente`,
            metadata: { type: oldContact.type },
          });
        }
      }

      // Alta de los contactos nuevos.
      for (const newContact of body.contacts) {
        if (!existingKeys.has(`${newContact.type}:${newContact.value}`)) {
          const { rows: [insertedContact] } = await client.query(
            `INSERT INTO patient_contacts (clinic_id, patient_id, contact_type_id, contact_value, updated_by)
             SELECT $1, $2, ct.contact_type_id, $4, $5
               FROM contact_types ct
              WHERE ct.contact_type_name = $3
             RETURNING contact_id AS "contactId"`,
            [clinicId, patientId, newContact.type, newContact.value, userId],
          );
          await logAuditEvent(client, {
            clinicId,
            userId,
            eventType: 'create',
            dataObject: 'patient_contact',
            objectId: insertedContact.contactId,
            patientId,
            description: `Creación de contacto (${newContact.type}) del paciente`,
            metadata: { type: newContact.type },
          });
        }
      }
    }

    const { rows: [row] } = await client.query(
      `${PATIENT_SELECT_SQL} WHERE p.clinic_id = $1 AND p.patient_id = $2`,
      [clinicId, patientId],
    );
    const { rows: contacts } = await client.query(CONTACTS_SELECT_SQL, [clinicId, patientId]);
    return { ...row, contacts };
  });

  res.json(updated);
});
