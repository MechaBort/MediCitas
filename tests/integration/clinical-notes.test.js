// RF15 (nota clínica de una cita atendida, solo del profesional que la atendió) y RF18 (toda lectura y escritura de
// notas queda en la bitácora), con I5 (aislamiento) e I6 (la cadena de la bitácora sigue íntegra). Las citas que ya
// pasaron se preparan en la base (db.js), porque la API no permite reservar en el pasado; el desenlace "atendida" se
// registra por la API, como lo haría recepción.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { addAppointment, addScheduleBlock, freePastDay, ownerDb, patientsOf, professionalsOf } from './db.js';

requireStack();
const db = ownerDb();

let reception;   // recepcion.sanjose
let clinicAdmin; // admin.sanjose
let laura;       // laura.mora: la profesional de las citas de esta prueba
let andres;      // andres.solis: otro profesional de la misma clínica
let carlos;      // carlos.brenes: profesional de Cartago
let clinicId;
let lauraPro;    // { professionalId, serviceId, duration }
let patients;

const me = async (bearer) => (await api('GET', '/me', { token: bearer })).body;

before(async () => {
  reception = await token('recepcion.sanjose');
  clinicAdmin = await token('admin.sanjose');
  laura = await token('laura.mora');
  andres = await token('andres.solis');
  carlos = await token('carlos.brenes');

  clinicId = (await me(reception)).clinicId;
  const lauraMe = await me(laura);
  assert.equal(lauraMe.clinicId, clinicId, 'laura.mora debe ser de la clínica de recepcion.sanjose');
  assert.equal((await me(andres)).clinicId, clinicId, 'andres.solis debe ser de la misma clínica');
  assert.notEqual((await me(carlos)).clinicId, clinicId, 'carlos.brenes debe ser de otra clínica');

  lauraPro = (await professionalsOf(db, clinicId)).find((p) => p.professionalId === lauraMe.userId);
  assert.ok(lauraPro, 'laura.mora debe tener al menos un servicio activo');
  patients = await patientsOf(db, clinicId);
});

// Cita de laura.mora en un día pasado, a las 09:00. Sin outcome queda reservada; con outcome, recepción registra
// su desenlace por la API.
async function pastAppointment({ outcome } = {}) {
  const day = await freePastDay(db, [lauraPro.professionalId]);
  await addScheduleBlock(db, { clinicId, professionalId: lauraPro.professionalId, day, from: '08:00', to: '12:00' });
  const id = await addAppointment(db, {
    clinicId, patientId: patients[0], professionalId: lauraPro.professionalId, serviceId: lauraPro.serviceId,
    day, time: '09:00',
  });
  if (outcome) {
    const res = await api('POST', `/appointments/${id}/outcome`, { token: reception, body: { outcome } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  return id;
}

const writeNote = (bearer, appointmentId, text = 'Paciente estable; control en un mes.') =>
  api('POST', '/clinical-notes', { token: bearer, body: { appointmentId, text } });

// Filas de la bitácora sobre una nota (data_object_id 1 = clinical_note), contadas por tipo de evento.
async function auditOf(noteId) {
  const { rows } = await db.query(`
    SELECT e.name AS event, count(*)::int AS n
      FROM audit_logs l JOIN event_types e ON e.event_type_id = l.event_type_id
     WHERE l.data_object_id = 1 AND l.object_id = $1
     GROUP BY e.name`, [noteId]);
  return Object.fromEntries(rows.map((r) => [r.event, r.n]));
}

test('RF15, RF18: el profesional que atendió la cita escribe su nota, la lee y la corrige; cada acceso deja una fila en la bitácora', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });

  const created = await writeNote(laura, appointmentId, 'Dolor lumbar leve. Reposo y control.');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.service, 'clinical');
  const noteId = created.body.clinicalNoteId;
  assert.equal(created.headers.get('location'), `/clinical-notes/${noteId}`);
  assert.equal(created.body.appointmentId, appointmentId);
  assert.equal(created.body.patientId, patients[0]);
  assert.equal(created.body.text, 'Dolor lumbar leve. Reposo y control.');
  assert.deepEqual(await auditOf(noteId), { create: 1 });

  const byId = await api('GET', `/clinical-notes/${noteId}`, { token: laura });
  assert.equal(byId.status, 200);
  assert.equal(byId.body.text, 'Dolor lumbar leve. Reposo y control.');
  assert.deepEqual(await auditOf(noteId), { create: 1, read: 1 });

  const byAppointment = await api('GET', `/clinical-notes?appointmentId=${appointmentId}`, { token: laura });
  assert.equal(byAppointment.status, 200);
  assert.equal(byAppointment.body.clinicalNoteId, noteId);
  assert.deepEqual(await auditOf(noteId), { create: 1, read: 2 });

  const fixed = await api('PATCH', `/clinical-notes/${noteId}`, {
    token: laura, body: { text: 'Dolor lumbar leve. Reposo, analgésico y control en dos semanas.' },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.text, 'Dolor lumbar leve. Reposo, analgésico y control en dos semanas.');
  assert.deepEqual(await auditOf(noteId), { create: 1, read: 2, update: 1 });
});

test('RF18: la bitácora registra quién, sobre cuál paciente y cuándo, pero nunca el texto de la nota', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  const secret = `Texto sensible ${Date.now()}`;
  const { body: note } = await writeNote(laura, appointmentId, secret);
  await api('GET', `/clinical-notes/${note.clinicalNoteId}`, { token: laura });

  const { rows } = await db.query(
    'SELECT user_id, patient_id, description, metadata::text AS metadata, created_at FROM audit_logs WHERE data_object_id = 1 AND object_id = $1',
    [note.clinicalNoteId]);
  assert.equal(rows.length, 2);
  const lauraId = lauraPro.professionalId;
  for (const row of rows) {
    assert.equal(row.user_id, lauraId);
    assert.equal(row.patient_id, patients[0]);
    assert.ok(row.created_at instanceof Date);
    assert.ok(!row.description.includes(secret) && !(row.metadata ?? '').includes(secret), 'el texto no va a la bitácora');
  }
});

test('RF15, RF17: recepción y el administrador de la clínica no escriben ni leen notas (403)', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  const { body: note } = await writeNote(laura, appointmentId);

  for (const bearer of [reception, clinicAdmin]) {
    assert.equal((await writeNote(bearer, appointmentId)).status, 403);
    assert.equal((await api('GET', `/clinical-notes/${note.clinicalNoteId}`, { token: bearer })).status, 403);
    assert.equal((await api('PATCH', `/clinical-notes/${note.clinicalNoteId}`, {
      token: bearer, body: { text: 'cambio' },
    })).status, 403);
  }
  assert.deepEqual(await auditOf(note.clinicalNoteId), { create: 1 }, 'un 403 no lee nada, así que no registra nada');
});

test('RF15, I5: otro profesional de la misma clínica no escribe, no lee ni corrige la nota de una cita ajena (404)', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  assert.equal((await writeNote(andres, appointmentId)).status, 404);

  const { body: note } = await writeNote(laura, appointmentId, 'Nota de laura');
  assert.equal((await api('GET', `/clinical-notes/${note.clinicalNoteId}`, { token: andres })).status, 404);
  assert.equal((await api('GET', `/clinical-notes?appointmentId=${appointmentId}`, { token: andres })).status, 404);
  assert.equal((await api('PATCH', `/clinical-notes/${note.clinicalNoteId}`, {
    token: andres, body: { text: 'Intento de cambio' },
  })).status, 404);

  assert.equal((await api('GET', `/clinical-notes/${note.clinicalNoteId}`, { token: laura })).body.text, 'Nota de laura');
});

test('RF15, I5: un profesional de otra clínica recibe 404, igual que con una cita o una nota que no existe', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  const { body: note } = await writeNote(laura, appointmentId);

  assert.equal((await writeNote(carlos, appointmentId)).status, 404);
  assert.equal((await api('GET', `/clinical-notes/${note.clinicalNoteId}`, { token: carlos })).status, 404);
  assert.equal((await writeNote(laura, 999999999)).status, 404);
  assert.equal((await api('GET', '/clinical-notes/999999999', { token: laura })).status, 404);
});

test('RF15: una cita que no está atendida responde 409 y no crea la nota', async () => {
  for (const outcome of [undefined, 'ausente']) {
    const appointmentId = await pastAppointment({ outcome });
    const res = await writeNote(laura, appointmentId);
    assert.equal(res.status, 409, `cita ${outcome ?? 'reservada'}: ${JSON.stringify(res.body)}`);
    const { rowCount } = await db.query('SELECT 1 FROM clinical_notes WHERE appointment_id = $1', [appointmentId]);
    assert.equal(rowCount, 0);
  }
});

test('RF15: una segunda nota para la misma cita responde 409, y la primera no cambia', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  const first = await writeNote(laura, appointmentId, 'Primera nota');
  assert.equal(first.status, 201);

  const second = await writeNote(laura, appointmentId, 'Segunda nota');
  assert.equal(second.status, 409);
  assert.equal((await api('GET', `/clinical-notes/${first.body.clinicalNoteId}`, { token: laura })).body.text, 'Primera nota');
});

test('RF15, I5: el cuerpo y los parámetros se validan: sin texto, texto vacío, ids inválidos o con clinicId responden 400', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  const bad = [
    { appointmentId },
    { appointmentId, text: '   ' },
    { appointmentId: 'abc', text: 'x' },
    { appointmentId, text: 'x', clinicId: 2 },
    { appointmentId, text: 'x'.repeat(10_001) },
  ];
  for (const body of bad) {
    assert.equal((await api('POST', '/clinical-notes', { token: laura, body })).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await api('GET', '/clinical-notes', { token: laura })).status, 400);
  assert.equal((await api('GET', '/clinical-notes/1.5', { token: laura })).status, 400);
  assert.equal((await api('PATCH', '/clinical-notes/1', { token: laura, body: { text: 'x', clinicId: 2 } })).status, 400);
});

test('RF18, I6: la cadena de huellas de la bitácora sigue íntegra después de escribir, leer y corregir notas', async () => {
  const appointmentId = await pastAppointment({ outcome: 'atendida' });
  const { body: note } = await writeNote(laura, appointmentId);
  await api('GET', `/clinical-notes/${note.clinicalNoteId}`, { token: laura });
  await api('PATCH', `/clinical-notes/${note.clinicalNoteId}`, { token: laura, body: { text: 'Corregida' } });

  const verify = await api('GET', '/audit/verify', { token: clinicAdmin });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.valid, true, JSON.stringify(verify.body));
});
