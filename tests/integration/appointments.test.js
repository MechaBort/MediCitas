// RF9: reservar una cita, con la pregunta rectora (dos recepcionistas por el último espacio) y las invariantes
// que protege la base: I1 y I2 (EXCLUDE), I3 (horario y bloqueos), I4 (la duración la decide el servicio) e I5.
// Cada prueba prepara su propio horario en un día lejano y único (db.js), así no depende del seed ni de corridas
// anteriores. La reserva siempre pasa por la API; la base solo se usa para preparar y para verificar.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { addBlockade, addScheduleBlock, freeDay, localInstant, ownerDb } from './db.js';

requireStack();
const db = ownerDb();

let reception;       // token de recepcion.sanjose
let clinicAdmin;     // token de admin.sanjose: también puede reservar
let clinicId;        // San José
let p1;              // { professionalId, serviceId, duration }
let p2;              // otro profesional de la misma clínica
let patients;        // ids de pacientes de San José
let notOffered;      // servicio de San José que p1 no atiende
let other;           // paciente, profesional y servicio de Cartago

before(async () => {
  reception = await token('recepcion.sanjose');
  clinicAdmin = await token('admin.sanjose');
  clinicId = (await api('GET', '/me', { token: reception })).body.clinicId;
  const cartagoId = (await api('GET', '/me', { token: await token('recepcion.cartago') })).body.clinicId;

  // El primer servicio activo de cada profesional activo, por clínica.
  const offered = async (clinic) => (await db.query(`
    SELECT DISTINCT ON (spp.professional_id)
           spp.professional_id AS "professionalId", spp.service_id AS "serviceId", s.duration_minutes AS duration
      FROM services_per_professionals spp
      JOIN services s       ON s.service_id = spp.service_id AND s.is_active
      JOIN users u          ON u.user_id = spp.professional_id AND u.is_active
      JOIN professionals pr ON pr.user_id = u.user_id AND pr.is_active
     WHERE spp.clinic_id = $1 AND spp.is_active
     ORDER BY spp.professional_id, spp.service_id`, [clinic])).rows;
  [p1, p2] = await offered(clinicId);
  const [otherProfessional] = await offered(cartagoId);

  const patientsOf = async (clinic) => (await db.query(
    'SELECT patient_id FROM patients WHERE clinic_id = $1 AND is_active ORDER BY patient_id LIMIT 10', [clinic]))
    .rows.map((r) => r.patient_id);
  patients = await patientsOf(clinicId);
  const [otherPatient] = await patientsOf(cartagoId);

  notOffered = (await db.query(`
    SELECT service_id FROM services
     WHERE clinic_id = $1 AND is_active
       AND service_id NOT IN (SELECT service_id FROM services_per_professionals WHERE professional_id = $2)
     LIMIT 1`, [clinicId, p1.professionalId])).rows[0].service_id;

  other = { patientId: otherPatient, ...otherProfessional };
});

const book = (bearer, body) => api('POST', '/appointments', { token: bearer, body });

// Un día nuevo con un bloque de horario para cada profesional indicado.
async function dayWithSchedule(professionals, from = '08:00', to = '12:00') {
  const day = await freeDay(db, professionals.map((p) => p.professionalId));
  for (const p of professionals) {
    await addScheduleBlock(db, { clinicId, professionalId: p.professionalId, day, from, to });
  }
  return day;
}

// Citas reservadas del profesional que se cruzan con ese día.
async function reservedOn(professionalId, day) {
  const { rows: [row] } = await db.query(`
    SELECT count(*)::int AS n FROM appointments
     WHERE professional_id = $1 AND appointment_status_id = 1
       AND period && tstzrange($2::date - interval '1 day', $2::date + interval '2 days')`, [professionalId, day]);
  return row.n;
}

const minutesBetween = (start, end) => (Date.parse(end) - Date.parse(start)) / 60_000;

test('RF9, I4: recepción reserva una cita; el fin lo calcula la base con la duración del servicio', async () => {
  const day = await dayWithSchedule([p1]);
  const start = await localInstant(db, clinicId, day, '09:00');
  const res = await book(reception, { patientId: patients[0], ...pick(p1), start, description: 'Control' });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.service, 'agenda');
  assert.equal(res.body.status, 'reservada');
  assert.equal(minutesBetween(res.body.start, res.body.end), p1.duration);
  assert.equal(res.headers.get('location'), `/appointments/${res.body.appointmentId}`);
  assert.equal(await reservedOn(p1.professionalId, day), 1);
});

test('RF9, I4: el cliente no puede mandar el fin de la cita', async () => {
  const day = await dayWithSchedule([p1]);
  const start = await localInstant(db, clinicId, day, '09:00');
  const res = await book(reception, { patientId: patients[0], ...pick(p1), start, end: start });
  assert.equal(res.status, 400);
  assert.equal(await reservedOn(p1.professionalId, day), 0);
});

test('RF9, I1: dos citas seguidas del mismo profesional se conceden (los periodos [inicio, fin) no se cruzan)', async () => {
  const day = await dayWithSchedule([p1]);
  const first = await book(reception, { patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
  assert.equal(first.status, 201);
  const second = await book(reception, { patientId: patients[1], ...pick(p1), start: first.body.end });
  assert.equal(second.status, 201, JSON.stringify(second.body));
});

test('RF9, I1: pregunta rectora: dos recepcionistas por el último espacio, exactamente una reserva (5 rondas)', async () => {
  for (let round = 1; round <= 5; round++) {
    // Un bloque del tamaño exacto de un servicio: es el último espacio libre de ese profesional ese día.
    const day = await freeDay(db, [p1.professionalId]);
    const startTime = '09:00';
    const endTime = new Date(Date.UTC(2000, 0, 1, 9, p1.duration)).toISOString().slice(11, 16);
    await addScheduleBlock(db, { clinicId, professionalId: p1.professionalId, day, from: startTime, to: endTime });
    const start = await localInstant(db, clinicId, day, startTime);

    const results = await Promise.all([
      book(reception, { patientId: patients[0], ...pick(p1), start }),
      book(clinicAdmin, { patientId: patients[1], ...pick(p1), start }),
    ]);

    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], `ronda ${round}`);
    const loser = results.find((r) => r.status === 409);
    assert.match(loser.body.error, /profesional/i, `ronda ${round}: el 409 debe ser por el profesional`);
    assert.equal(await reservedOn(p1.professionalId, day), 1, `ronda ${round}: debe quedar una sola cita`);
  }
});

test('RF9, I1: diez clientes simultáneos por el último espacio: uno solo gana', async () => {
  const day = await freeDay(db, [p1.professionalId]);
  const endTime = new Date(Date.UTC(2000, 0, 1, 9, p1.duration)).toISOString().slice(11, 16);
  await addScheduleBlock(db, { clinicId, professionalId: p1.professionalId, day, from: '09:00', to: endTime });
  const start = await localInstant(db, clinicId, day, '09:00');

  const results = await Promise.all(patients.slice(0, 10).map((patientId, i) =>
    book(i % 2 ? clinicAdmin : reception, { patientId, ...pick(p1), start })));

  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, `estados: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, results.length - 1, `estados: ${statuses}`);
  assert.equal(await reservedOn(p1.professionalId, day), 1);
});

test('RF9, I2: un paciente no puede tener dos citas a la misma hora, aunque sea con otro profesional', async () => {
  const day = await dayWithSchedule([p1, p2]);
  const start = await localInstant(db, clinicId, day, '09:00');
  assert.equal((await book(reception, { patientId: patients[0], ...pick(p1), start })).status, 201);

  const res = await book(reception, { patientId: patients[0], ...pick(p2), start });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /paciente/i, 'el 409 debe ser por el paciente, no por el profesional');
  assert.equal(await reservedOn(p2.professionalId, day), 0);
});

test('RF9, I3: una cita fuera del horario del profesional, o que se sale de él, responde 400', async () => {
  const day = await dayWithSchedule([p1], '08:00', '12:00');
  for (const time of ['13:00', '07:30']) {
    const res = await book(reception, { patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, time) });
    assert.equal(res.status, 400, `a las ${time}`);
  }
  // Empieza dentro del horario, pero termina después de las 12:00.
  const lastMinute = await localInstant(db, clinicId, day, '11:59');
  assert.equal((await book(reception, { patientId: patients[0], ...pick(p1), start: lastMinute })).status, 400);
  assert.equal(await reservedOn(p1.professionalId, day), 0);
});

test('RF9, RF6, I3: una cita dentro de un bloqueo del profesional responde 400', async () => {
  const day = await dayWithSchedule([p1]);
  await addBlockade(db, { clinicId, professionalId: p1.professionalId, day, from: '10:00', to: '11:00' });
  const res = await book(reception, { patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '10:00') });
  assert.equal(res.status, 400);
  assert.equal(await reservedOn(p1.professionalId, day), 0);
});

test('RF9: una cita que empieza en el pasado responde 400', async () => {
  const res = await book(reception, { patientId: patients[0], ...pick(p1), start: '2020-01-06T15:00:00Z' });
  assert.equal(res.status, 400);
});

test('RF4, RF9: un servicio que el profesional no atiende responde 400', async () => {
  const day = await dayWithSchedule([p1]);
  const res = await book(reception, {
    patientId: patients[0], professionalId: p1.professionalId, serviceId: notOffered,
    start: await localInstant(db, clinicId, day, '09:00'),
  });
  assert.equal(res.status, 400);
});

test('RF9, I5: un paciente, un profesional o un servicio de otra clínica responde 404', async () => {
  const day = await dayWithSchedule([p1]);
  const start = await localInstant(db, clinicId, day, '09:00');
  const cases = {
    paciente: { patientId: other.patientId, ...pick(p1) },
    profesional: { patientId: patients[0], professionalId: other.professionalId, serviceId: p1.serviceId },
    servicio: { patientId: patients[0], professionalId: p1.professionalId, serviceId: other.serviceId },
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.equal((await book(reception, { ...body, start })).status, 404, name);
  }
  assert.equal(await reservedOn(p1.professionalId, day), 0);
});

test('RF9, RF17: sin token responde 401, y un profesional no puede reservar (403)', async () => {
  const body = { patientId: patients[0], ...pick(p1), start: '2030-01-07T15:00:00Z' };
  assert.equal((await book(undefined, body)).status, 401);
  assert.equal((await book(await token('laura.mora'), body)).status, 403);
});

test('RF9, I5: el body se valida: sin inicio, inicio sin zona horaria o un clinicId responden 400', async () => {
  const base = { patientId: patients[0], ...pick(p1) };
  for (const body of [base, { ...base, start: '2030-01-07T09:00:00' }, { ...base, start: '2030-01-07T15:00:00Z', clinicId }]) {
    assert.equal((await book(reception, body)).status, 400, JSON.stringify(body));
  }
});

function pick({ professionalId, serviceId }) {
  return { professionalId, serviceId };
}
