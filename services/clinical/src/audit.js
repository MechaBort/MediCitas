// Registro en la bitácora de auditoría append-only (RF18, I6).
// Toda lectura y escritura de datos de contacto de pacientes (RF14) y de notas clínicas (RF15) se
// registra dentro de la misma transacción (withTransaction) que realiza la operación.

// Catálogo fijo de db/sql/03-catalogs.sql.
export const EVENT_TYPE = {
  read: 1,
  create: 2,
  update: 3,
  delete: 4, // baja lógica
};

export const DATA_OBJECT = {
  clinical_note: 1,
  patient_contact: 2,
};

const INSERT_AUDIT_SQL = `
  INSERT INTO audit_logs (
    clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description, metadata
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export async function logAuditEvent(client, {
  clinicId,
  userId,
  eventType,
  dataObject,
  objectId,
  patientId,
  description,
  metadata = null,
}) {
  const eventTypeId = typeof eventType === 'number' ? eventType : EVENT_TYPE[eventType];
  const dataObjectId = typeof dataObject === 'number' ? dataObject : DATA_OBJECT[dataObject];
  await client.query(INSERT_AUDIT_SQL, [
    clinicId,
    userId,
    eventTypeId,
    dataObjectId,
    objectId,
    patientId,
    description,
    metadata ? JSON.stringify(metadata) : null,
  ]);
}
