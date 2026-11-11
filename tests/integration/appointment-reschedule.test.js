// RF10: reprogramar una cita. En una sola transacción, la original pasa a "reprogramada" y la nueva se inserta con
// rescheduled_from_id. Lo que se prueba es que en ningún momento quedan las dos ocupando espacio, ni ninguna:
// si algo falla, la original sigue reservada (I7, I1, I3, I4, I5), también con peticiones simultáneas.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import {
  addScheduleBlock, appointmentStatus, freeDay, localInstant, ownerDb, patientsOf, professionalsOf,
} from './db.js';

requireStack();
const db = ownerDb();

let reception;      // recepcion.sanjose
let clinicAdmin;    // admin.sanjose: también puede reprogramar
let professional;   // laura.mora
let clinicId;       // San José
let p1;             // { professionalId, serviceId, duration }
let patients;
let shared;         // { serviceId, professionalIds: [a, b] }: un servicio que atienden dos profesionales
let cartago;        // { clinicId, reception, p, patients }

before(async () => {
  reception = await token('recepcion.sanjose');
  clinicAdmin = await token('admin.sanjose');
  professional = await token('laura.mora');
  clinicId = (await api('GET', '/me', { token: reception })).body.clinicId;
  [p1] = await professionalsOf(db, clinicId);
  patients = await patientsOf(db, clinicId);

  const { rows: [row] } = await db.query(`
    SELECT spp.service_id AS "serviceId", array_agg(spp.professional_id ORDER BY spp.professional_id) AS "professionalIds"
      FROM services_per_professionals spp
      JOIN services s       ON s.service_id = spp.service_id AND s.is_active
      JOIN professionals pr ON pr.user_id = spp.professional_id AND pr.is_active
     WHERE spp.clinic_id = $1 AND spp.is_active
     GROUP BY spp.service_id
    HAVING count(*) >= 2
     LIMIT 1`, [clinicId]);
  shared = row;

  const cartagoReception = await token('recepcion.cartago');
  const cartagoId = (await api('GET', '/me', { token: cartagoReception })).body.clinicId;
  cartago = {
    clinicId: cartagoId,
    reception: cartagoReception,
    p: (await professionalsOf(db, cartagoId))[0],
    patients: await patientsOf(db, cartagoId),
  };
});

const book = (bearer, body) => api('POST', '/appointments', { token: bearer, body });
const reschedule = (bearer, id, body) => api('POST', `/appointments/${id}/reschedule`, { token: bearer, body });
const minutesBetween = (start, end) => (Date.parse(end) - Date.parse(start)) / 60_000;
const plusMinutes = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

// Un día nuevo con horario de 08:00 a 12:00 para esos profesionales.
async function dayWithSchedule(professionalIds, clinic = clinicId) {
  const day = await freeDay(db, professionalIds);
  for (const professionalId of professionalIds) {
    await addScheduleBlock(db, { clinicId: clinic, professionalId, day, from: '08:00', to: '12:00' });
  }
  return day;
}

// Reserva por la API y devuelve el cuerpo de la respuesta (appointmentId, start, end…).
async function booked(body, bearer = reception) {
  const res = await book(bearer, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// Cuántas citas nuevas apuntan a la original: 0 si la reprogramación no ocurrió, 1 si ocurrió.
async function replacements(appointmentId) {
  const { rows: [row] } = await db.query(
    'SELECT count(*)::int AS n FROM appointments WHERE rescheduled_from_id = $1', [appointmentId]);
  return row.n;
}

test('RF10, I4, I7: recepción reprograma una cita; la original queda reprogramada y su espacio, libre', async () => {
  const day = await dayWithSchedule([p1.professionalId]);
  const original = await booked({
    patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00'), description: 'Control',
  });
  const newStart = await localInstant(db, clinicId, day, '10:00');

  const res = await reschedule(reception, original.appointmentId, { start: newStart });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.service, 'agenda');
  assert.equal(res.headers.get('location'), `/appointments/${res.body.appointmentId}`);
  assert.equal(res.body.rescheduledFromId, original.appointmentId);
  assert.equal(res.body.status, 'reservada');
  // Se conservan el paciente, el servicio y la descripción; la duración la sigue decidiendo el servicio (I4).
  assert.equal(res.body.patientId, patients[0]);
  assert.equal(res.body.serviceId, p1.serviceId);
  assert.equal(res.body.description, 'Control');
  assert.equal(Date.parse(res.body.start), Date.parse(newStart));
  assert.equal(minutesBetween(res.body.start, res.body.end), p1.duration);

  assert.equal(await appointmentStatus(db, original.appointmentId), 'reprogramada');
  assert.equal(await replacements(original.appointmentId), 1);
  // I7: el espacio de la original quedó libre para otro paciente.
  assert.equal((await book(reception, { patientId: patients[1], ...pick(p1), start: original.start })).status, 201);
});

test('RF10, I1, I2: la nueva hora puede cruzarse con la original, porque la original deja su espacio primero', async () => {
  const day = await dayWithSchedule([p1.professionalId]);
  const original = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });

  // Mismo paciente y mismo profesional, corrida media duración: si la nueva se insertara antes de liberar la
  // original, chocaría con ella en las dos restricciones EXCLUDE.
  const shift = Math.max(1, Math.floor(p1.duration / 2));
  const res = await reschedule(reception, original.appointmentId, { start: plusMinutes(original.start, shift) });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await appointmentStatus(db, original.appointmentId), 'reprogramada');
});

test('RF10, I1: si el nuevo espacio está ocupado responde 409, y el ROLLBACK deja la original reservada', async () => {
  const day = await dayWithSchedule([p1.professionalId]);
  const original = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
  const other = await booked({ patientId: patients[1], ...pick(p1), start: await localInstant(db, clinicId, day, '10:00') });

  const res = await reschedule(reception, original.appointmentId, { start: other.start });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /profesional/i);
  assert.equal(await appointmentStatus(db, original.appointmentId), 'reservada');
  assert.equal(await replacements(original.appointmentId), 0);
});

test('RF10, I3: una hora nueva fuera del horario, o en el pasado, responde 400 y la original sigue reservada', async () => {
  const day = await dayWithSchedule([p1.professionalId]);
  const original = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });

  for (const start of [await localInstant(db, clinicId, day, '13:00'), '2020-01-06T15:00:00Z']) {
    assert.equal((await reschedule(reception, original.appointmentId, { start })).status, 400, start);
  }
  assert.equal(await appointmentStatus(db, original.appointmentId), 'reservada');
  assert.equal(await replacements(original.appointmentId), 0);
});

test('RF10, RF13: una cita ya reprogramada o cancelada no se puede reprogramar (409)', async () => {
  const day = await dayWithSchedule([p1.professionalId]);
  const first = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
  assert.equal((await reschedule(reception, first.appointmentId, { start: await localInstant(db, clinicId, day, '10:00') })).status, 201);
  assert.equal((await reschedule(reception, first.appointmentId, { start: await localInstant(db, clinicId, day, '11:00') })).status, 409);
  assert.equal(await replacements(first.appointmentId), 1);

  const cancelled = await booked({ patientId: patients[1], ...pick(p1), start: first.start });
  const cancel = await api('POST', `/appointments/${cancelled.appointmentId}/cancel`, {
    token: reception, body: { reason: 'El paciente pidió cancelar' },
  });
  assert.equal(cancel.status, 200);
  assert.equal((await reschedule(reception, cancelled.appointmentId, { start: await localInstant(db, clinicId, day, '11:00') })).status, 409);
  assert.equal(await replacements(cancelled.appointmentId), 0);
});

test('RF10, I1: dos recepcionistas reprograman la misma cita a la vez, a horas distintas: una sola gana (5 rondas)', async () => {
  for (let round = 1; round <= 5; round++) {
    const day = await dayWithSchedule([p1.professionalId]);
    const original = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
    const ten = await localInstant(db, clinicId, day, '10:00');
    const eleven = await localInstant(db, clinicId, day, '11:00');

    const results = await Promise.all([
      reschedule(reception, original.appointmentId, { start: ten }),
      reschedule(clinicAdmin, original.appointmentId, { start: eleven }),
    ]);

    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], `ronda ${round}`);
    assert.equal(await appointmentStatus(db, original.appointmentId), 'reprogramada', `ronda ${round}`);
    assert.equal(await replacements(original.appointmentId), 1, `ronda ${round}: debe quedar una sola cita nueva`);
  }
});

test('RF10: reprogramaciones cruzadas a la vez (A al espacio de B, B al de A): sin 500, sin citas perdidas ni duplicadas (3 rondas)', async () => {
  for (let round = 1; round <= 3; round++) {
    const day = await dayWithSchedule([p1.professionalId]);
    const a = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
    const b = await booked({ patientId: patients[1], ...pick(p1), start: await localInstant(db, clinicId, day, '10:00') });

    // Si las dos llegan a la vez, se bloquean entre sí y PostgreSQL aborta una por deadlock; withTransaction la
    // repite. Ninguna puede ganar: cada una necesita el espacio que la otra sigue ocupando.
    const results = await Promise.all([
      reschedule(reception, a.appointmentId, { start: b.start }),
      reschedule(clinicAdmin, b.appointmentId, { start: a.start }),
    ]);

    assert.deepEqual(results.map((r) => r.status), [409, 409], `ronda ${round}: ${JSON.stringify(results.map((r) => r.body))}`);
    for (const original of [a, b]) {
      assert.equal(await appointmentStatus(db, original.appointmentId), 'reservada', `ronda ${round}`);
      assert.equal(await replacements(original.appointmentId), 0, `ronda ${round}`);
    }
  }
});

test('RF10: se puede reprogramar con otro profesional que atiende el mismo servicio', async () => {
  const [a, b] = shared.professionalIds;
  const day = await dayWithSchedule([a, b]);
  const start = await localInstant(db, clinicId, day, '09:00');
  const original = await booked({ patientId: patients[2], professionalId: a, serviceId: shared.serviceId, start });

  const res = await reschedule(reception, original.appointmentId, { start, professionalId: b });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.professionalId, b);
  assert.equal(res.body.serviceId, shared.serviceId);
  assert.equal(await appointmentStatus(db, original.appointmentId), 'reprogramada');
});

test('RF10, I5: una cita de otra clínica, o un profesional de otra clínica, responde 404 y nada cambia', async () => {
  const cartagoDay = await dayWithSchedule([cartago.p.professionalId], cartago.clinicId);
  const foreign = await booked({
    patientId: cartago.patients[0], ...pick(cartago.p), start: await localInstant(db, cartago.clinicId, cartagoDay, '09:00'),
  }, cartago.reception);
  const later = await localInstant(db, cartago.clinicId, cartagoDay, '10:00');
  assert.equal((await reschedule(reception, foreign.appointmentId, { start: later })).status, 404);
  assert.equal(await appointmentStatus(db, foreign.appointmentId), 'reservada');

  const day = await dayWithSchedule([p1.professionalId]);
  const own = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
  const res = await reschedule(reception, own.appointmentId, {
    start: await localInstant(db, clinicId, day, '10:00'), professionalId: cartago.p.professionalId,
  });
  assert.equal(res.status, 404);
  assert.equal(await appointmentStatus(db, own.appointmentId), 'reservada');
  assert.equal(await replacements(own.appointmentId), 0);
});

test('RF10, RF17, I4: un profesional no puede reprogramar (403), y el cuerpo se valida (400)', async () => {
  const day = await dayWithSchedule([p1.professionalId]);
  const original = await booked({ patientId: patients[0], ...pick(p1), start: await localInstant(db, clinicId, day, '09:00') });
  const start = await localInstant(db, clinicId, day, '10:00');

  assert.equal((await reschedule(professional, original.appointmentId, { start })).status, 403);
  for (const body of [{}, { start, end: start }, { start, clinicId }, { start: start.replace('Z', '') }, { start, serviceId: 1 }]) {
    assert.equal((await reschedule(reception, original.appointmentId, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await reschedule(reception, 'abc', { start })).status, 400);
  assert.equal(await appointmentStatus(db, original.appointmentId), 'reservada');
});

function pick({ professionalId, serviceId }) {
  return { professionalId, serviceId };
}
