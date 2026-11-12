import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { logAuditEvent } from '../audit.js';

// Notas clínicas (RF15), el dato más sensible del sistema, y el registro en la bitácora de toda lectura y escritura
// de ellas (RF18, I6). Según la matriz de permisos, solo el profesional las escribe y las lee, y únicamente las de
// las citas que él mismo atendió: el router exige clinical_notes.write_own (solo lo tiene el rol professional) y
// cada consulta filtra por la clínica del token y por el profesional de la cita. Una nota o una cita de otra
// clínica, o de otro profesional, responde 404, igual que una que no existe (I5).
export const clinicalNotesRouter = Router();
clinicalNotesRouter.use(requirePermission('clinical_notes.write_own'));

// clinical_note_id y appointment_id son BIGINT en la base.
const bigId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const noteText = z.string().trim().min(1).max(10_000);

const idParam = z.object({ noteId: bigId });
const byAppointmentQuery = z.object({ appointmentId: bigId }).strict();
const createNoteSchema = z.object({ appointmentId: bigId, text: noteText }).strict();
const updateNoteSchema = z.object({ text: noteText }).strict();

// Estado 'atendida' del catálogo appointment_statuses (db/sql/03-catalogs.sql).
const ATTENDED = 2;

// La nota junto con su cita. El filtro por a.professional_id es el "solo de citas propias" de la matriz.
const NOTE_SELECT_SQL = `
  SELECT n.clinical_note_id AS "clinicalNoteId",
         n.appointment_id   AS "appointmentId",
         a.patient_id       AS "patientId",
         n.note_text        AS text,
         n.created_at       AS "createdAt",
         n.updated_at       AS "updatedAt"
    FROM clinical_notes n
    JOIN appointments a ON a.clinic_id = n.clinic_id AND a.appointment_id = n.appointment_id
   WHERE n.clinic_id = $1 AND a.professional_id = $2`;

function toNote(row) {
  return { ...row, clinicalNoteId: Number(row.clinicalNoteId), appointmentId: Number(row.appointmentId) };
}

// La descripción de la bitácora dice qué se hizo, nunca qué dice la nota: copiar el texto ahí lo dejaría en una
// tabla que lee el administrador de la clínica (RF19), que no puede leer notas.
const AUDIT_DESCRIPTION = {
  create: 'Creación de la nota clínica de una cita',
  read: 'Lectura de la nota clínica de una cita',
  update: 'Corrección de la nota clínica de una cita',
};

// RF18: registra un acceso a una nota en la misma transacción que la operación. Si la transacción se deshace, el
// registro también, y nunca queda una lectura sin su registro ni un registro sin su lectura.
function auditNote(client, user, eventType, note) {
  return logAuditEvent(client, {
    clinicId: user.clinicId,
    userId: user.userId,
    eventType,
    dataObject: 'clinical_note',
    objectId: note.clinicalNoteId,
    patientId: note.patientId,
    description: AUDIT_DESCRIPTION[eventType],
    metadata: { appointmentId: note.appointmentId },
  });
}

// Decide si el profesional del token puede escribir la nota de una cita (RF15) y devuelve el patient_id de esa cita,
// que la bitácora necesita (RF18).
//
// Reglas:
// - La cita debe existir en la clínica del token (clinicId) y ser del profesional del token (userId). Si no existe,
//   es de otra clínica o es de otro profesional, responde 404 con el mismo mensaje en los tres casos, para no
//   revelar que la cita existe (I5).
// - La cita debe estar atendida (appointment_status_id = ATTENDED). Si no, responde 409: la cita existe y es suya,
//   pero su estado actual no admite una nota.
//
// Columnas útiles de appointments: clinic_id, appointment_id, professional_id, patient_id, appointment_status_id.
// Basta revisarlo aquí, sin un trigger: 'atendida' es un estado final (MC002) y el profesional de una cita no cambia
// (MC004), así que ninguna transacción concurrente puede volver falsa esta revisión antes del COMMIT.
async function loadOwnAttendedAppointment(client, { clinicId, userId, appointmentId }) {
  // Una sola consulta: si hay fila, la cita es de esta clínica y de este profesional; su estado viene en la fila.
  const { rows: [appointment] } = await client.query(
    `SELECT patient_id, appointment_status_id
       FROM appointments
      WHERE clinic_id = $1 AND appointment_id = $2 AND professional_id = $3`,
    [clinicId, appointmentId, userId],
  );
  if (!appointment) {
    // No existe, es de otra clínica o es de otro profesional: el mismo 404 en los tres casos (I5).
    throw new HttpError(404, 'No se puede escribir la nota en la cita seleccionada');
  }
  if (appointment.appointment_status_id !== ATTENDED) {
    throw new HttpError(409, 'El estado actual de la cita no permite agregarle una nota clínica');
  }
  return appointment.patient_id;
}

// RF15, RF18: el profesional adjunta la nota de una cita que atendió.
clinicalNotesRouter.post('/', async (req, res) => {
  const { appointmentId, text } = parse(createNoteSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const note = await withTransaction(dbRole, async (client) => {
    const patientId = await loadOwnAttendedAppointment(client, { clinicId, userId, appointmentId });

    // Una nota por cita. Esta revisión da un mensaje claro en el caso normal; si dos peticiones llegan a la vez, la
    // garantía es UNIQUE (appointment_id) en la base, y la segunda recibe el 409 genérico de 23505.
    const { rowCount } = await client.query(
      'SELECT 1 FROM clinical_notes WHERE clinic_id = $1 AND appointment_id = $2',
      [clinicId, appointmentId],
    );
    if (rowCount > 0) {
      throw new HttpError(409, 'La cita ya tiene una nota clínica; para cambiarla, use PATCH /clinical-notes/{id}');
    }

    const { rows: [row] } = await client.query(
      `INSERT INTO clinical_notes (clinic_id, appointment_id, note_text, updated_by)
       VALUES ($1, $2, $3, $4)
       RETURNING clinical_note_id AS "clinicalNoteId", appointment_id AS "appointmentId", note_text AS text,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [clinicId, appointmentId, text, userId],
    );
    const created = toNote({ ...row, patientId });
    await auditNote(client, req.user, 'create', created);
    return created;
  });

  res.status(201).location(`/clinical-notes/${note.clinicalNoteId}`).json(note);
});

// RF15, RF18: la nota de una cita, buscada por la cita. Hay una sola nota por cita, así que es la forma natural de
// abrirla desde la agenda.
clinicalNotesRouter.get('/', async (req, res) => {
  const { appointmentId } = parse(byAppointmentQuery, req.query);
  res.json(await readNote(req.user, 'AND n.appointment_id = $3', appointmentId));
});

// RF15, RF18: una nota por su id.
clinicalNotesRouter.get('/:noteId', async (req, res) => {
  const { noteId } = parse(idParam, req.params);
  res.json(await readNote(req.user, 'AND n.clinical_note_id = $3', noteId));
});

// Lee una nota propia y registra la lectura (RF18). condition es una de las dos constantes de arriba, nunca texto que
// venga de la petición; el valor viaja como parámetro.
async function readNote(user, condition, value) {
  return withTransaction(user.dbRole, async (client) => {
    const { rows: [row] } = await client.query(`${NOTE_SELECT_SQL} ${condition}`, [user.clinicId, user.userId, value]);
    if (!row) throw new HttpError(404, 'Nota clínica no encontrada');
    const note = toNote(row);
    await auditNote(client, user, 'read', note);
    return note;
  });
}

// RF15, RF18: el autor corrige el texto de su nota. Cada corrección queda en la bitácora.
clinicalNotesRouter.patch('/:noteId', async (req, res) => {
  const { noteId } = parse(idParam, req.params);
  const { text } = parse(updateNoteSchema, req.body);
  const { clinicId, userId, dbRole } = req.user;

  const note = await withTransaction(dbRole, async (client) => {
    const { rows: [row] } = await client.query(
      `UPDATE clinical_notes n
          SET note_text = $4, updated_by = $2
         FROM appointments a
        WHERE n.clinic_id = $1 AND n.clinical_note_id = $3
          AND a.clinic_id = n.clinic_id AND a.appointment_id = n.appointment_id AND a.professional_id = $2
       RETURNING n.clinical_note_id AS "clinicalNoteId", n.appointment_id AS "appointmentId",
                 a.patient_id AS "patientId", n.note_text AS text, n.created_at AS "createdAt",
                 n.updated_at AS "updatedAt"`,
      [clinicId, userId, noteId, text],
    );
    if (!row) throw new HttpError(404, 'Nota clínica no encontrada');
    const updated = toNote(row);
    await auditNote(client, req.user, 'update', updated);
    return updated;
  });

  res.json(note);
});
