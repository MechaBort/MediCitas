// RF19: el administrador de la clínica consulta la bitácora con filtros por usuario, por paciente y por rango de
// fechas, paginada; con RF17 (solo el administrador) e I5 (nunca ve la bitácora de otra clínica). Las entradas se
// generan con lecturas reales por la API: el detalle de un paciente registra una fila por contacto leído (RF18).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { ownerDb } from './db.js';

requireStack();
const db = ownerDb();

let admin;          // admin.sanjose
let reception;      // recepcion.sanjose
let professional;   // laura.mora
let cartagoAdmin;   // admin.cartago
let clinicId;
let receptionId;
let professionalId;
let patientA;       // pacientes de San José con al menos un contacto activo
let patientB;
let today;          // 'YYYY-MM-DD' en la hora local de la clínica

const me = async (bearer) => (await api('GET', '/me', { token: bearer })).body;
const audit = (query = '', bearer = admin) => api('GET', `/audit${query}`, { token: bearer });
// Lectura real del detalle de un paciente: deja en la bitácora una fila 'read' por cada contacto (RF18).
const readPatient = async (bearer, patientId) => {
  const res = await api('GET', `/patients/${patientId}`, { token: bearer });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

before(async () => {
  admin = await token('admin.sanjose');
  reception = await token('recepcion.sanjose');
  professional = await token('laura.mora');
  cartagoAdmin = await token('admin.cartago');

  const adminMe = await me(admin);
  clinicId = adminMe.clinicId;
  receptionId = (await me(reception)).userId;
  professionalId = (await me(professional)).userId;

  const { rows } = await db.query(`
    SELECT p.patient_id FROM patients p
     WHERE p.clinic_id = $1 AND p.is_active
       AND EXISTS (SELECT 1 FROM patient_contacts c WHERE c.patient_id = p.patient_id AND c.is_active)
     ORDER BY p.patient_id LIMIT 2`, [clinicId]);
  [patientA, patientB] = rows.map((r) => r.patient_id);
  assert.ok(patientA && patientB, 'el seed debe tener dos pacientes con contactos en San José');

  today = (await db.query(
    "SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS d FROM clinics WHERE clinic_id = $1",
    [clinicId])).rows[0].d;

  await readPatient(reception, patientA);
  await readPatient(professional, patientB);
});

// Los archivos de prueba corren en paralelo y otros también escriben en esta bitácora: por eso las pruebas filtran por
// usuario y paciente, o anclan la paginación con beforeId, en vez de suponer cuál es "la entrada más nueva".
test('RF19, RF18: el administrador ve las lecturas recientes de su clínica, de la más nueva a la más antigua', async () => {
  const filter = `?userId=${receptionId}&patientId=${patientA}`;
  const previous = (await audit(`${filter}&limit=1`)).body.entries[0]?.logId ?? 0;
  await readPatient(reception, patientA);

  const res = await audit(filter);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.service, 'clinical');
  const [newest] = res.body.entries;
  assert.ok(newest.logId > previous, 'la lectura recién hecha aparece primero');
  assert.equal(newest.userId, receptionId);
  assert.equal(newest.patientId, patientA);
  assert.equal(newest.event, 'read');
  assert.equal(newest.dataObject, 'patient_contact');
  assert.ok(newest.userName && newest.description && newest.createdAt);

  const ids = res.body.entries.map((e) => e.logId);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'ordenadas por logId descendente');
});

test('RF19: el filtro por usuario solo trae lo que hizo ese usuario', async () => {
  const res = await audit(`?userId=${professionalId}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.length > 0);
  assert.ok(res.body.entries.every((e) => e.userId === professionalId));
});

test('RF19: el filtro por paciente solo trae lo que se hizo sobre ese paciente', async () => {
  const res = await audit(`?patientId=${patientB}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.length > 0);
  assert.ok(res.body.entries.every((e) => e.patientId === patientB));

  const both = await audit(`?patientId=${patientB}&userId=${receptionId}`);
  assert.ok(both.body.entries.every((e) => e.patientId === patientB && e.userId === receptionId));
});

test('RF19: el rango de fechas incluye el día de hoy en la hora de la clínica, y un rango antiguo sale vacío', async () => {
  const todayRes = await audit(`?from=${today}&to=${today}&userId=${receptionId}`);
  assert.equal(todayRes.status, 200);
  assert.ok(todayRes.body.entries.length > 0, 'las lecturas de hoy entran en from=to=hoy');

  const old = await audit('?from=2000-01-01&to=2000-01-31');
  assert.equal(old.status, 200);
  assert.deepEqual(old.body.entries, []);
  assert.equal(old.body.nextBeforeId, null);
});

test('RF19: la paginación con limit y beforeId recorre la bitácora sin repetir ni saltar entradas', async () => {
  await readPatient(reception, patientA);
  await readPatient(reception, patientB);

  const first = await audit('?limit=2');
  assert.equal(first.status, 200);
  assert.equal(first.body.entries.length, 2);
  assert.equal(first.body.nextBeforeId, first.body.entries[1].logId);

  const second = await audit(`?limit=2&beforeId=${first.body.nextBeforeId}`);
  assert.equal(second.status, 200);
  assert.ok(second.body.entries.every((e) => e.logId < first.body.nextBeforeId));

  // Las mismas cuatro de una vez, ancladas en la primera: lo que otras pruebas escriban después tiene logId mayor.
  const anchor = first.body.entries[0].logId + 1;
  const firstFour = (await audit(`?limit=4&beforeId=${anchor}`)).body.entries.map((e) => e.logId);
  assert.deepEqual([...first.body.entries, ...second.body.entries].map((e) => e.logId), firstFour);
});

test('RF19, RF17: solo el administrador de la clínica consulta la bitácora', async () => {
  assert.equal((await audit('', reception)).status, 403);
  assert.equal((await audit('', professional)).status, 403);
  assert.equal((await api('GET', '/audit')).status, 401);
});

test('RF19, I5: el administrador de otra clínica no ve nada de esta, ni filtrando por sus pacientes o usuarios', async () => {
  const byPatient = await audit(`?patientId=${patientA}`, cartagoAdmin);
  assert.equal(byPatient.status, 200);
  assert.deepEqual(byPatient.body.entries, []);

  const byUser = await audit(`?userId=${receptionId}`, cartagoAdmin);
  assert.deepEqual(byUser.body.entries, []);

  const all = await audit('', cartagoAdmin);
  assert.ok(all.body.entries.every((e) => e.userId !== receptionId && e.userId !== professionalId));
});

test('RF19, I5: los parámetros se validan y un clinicId se rechaza con 400', async () => {
  for (const query of [
    `?from=${today}&to=2000-01-01`,   // rango al revés
    '?from=2026-02-30',               // fecha imposible
    '?limit=0',
    '?limit=1000000',
    '?userId=abc',
    '?beforeId=-1',
    `?clinicId=${clinicId}`,
  ]) {
    assert.equal((await audit(query)).status, 400, query);
  }
});
