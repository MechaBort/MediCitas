// RF11 (cancelar), RF12 (registrar el desenlace) y RF13 (transiciones de estado permitidas), con I7 (cancelar
// libera el espacio) e I5. Las citas futuras se reservan por la API; las que ya empezaron se preparan en la base
// (db.js), porque la API no permite reservar en el pasado.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import {
  addAppointment, addScheduleBlock, appointmentStatus, freeDay, freePastDay, localInstant, ownerDb, patientsOf,
  professionalsOf,
} from './db.js';

requireStack();
const db = ownerDb();

let reception;      // recepcion.sanjose
let receptionId;    // su user_id
let professional;   // laura.mora: profesional de San José
let clinicId;
let p1;             // { professionalId, serviceId, duration }
let patients;
let cartago;        // { clinicId, reception, p, patients }

before(async () => {
  reception = await token('recepcion.sanjose');
  const me = (await api('GET', '/me', { token: reception })).body;
  clinicId = me.clinicId;
  receptionId = me.userId;
  professional = await token('laura.mora');
  [p1] = await professionalsOf(db, clinicId);
  patients = await patientsOf(db, clinicId);

  const cartagoReception = await token('recepcion.cartago');
  const cartagoId = (await api('GET', '/me', { token: cartagoReception })).body.clinicId;
  cartago = {
    clinicId: cartagoId,
    reception: cartagoReception,
    p: (await professionalsOf(db, cartagoId))[0],
    patients: await patientsOf(db, cartagoId),
  };
});

const cancel = (bearer, id, body = { reason: 'El paciente pidió cancelar' }) =>
  api('POST', `/appointments/${id}/cancel`, { token: bearer, body });
const outcome = (bearer, id, value) => api('POST', `/appointments/${id}/outcome`, { token: bearer, body: { outcome: value } });

// Reserva por la API una cita futura de 09:00 en un día nuevo con horario. Devuelve { id, start, day }.
async function futureAppointment({ clinic = clinicId, bearer = reception, pro = p1, patientId = patients[0] } = {}) {
  const day = await freeDay(db, [pro.professionalId]);
  await addScheduleBlock(db, { clinicId: clinic, professionalId: pro.professionalId, day, from: '08:00', to: '12:00' });
  const start = await localInstant(db, clinic, day, '09:00');
  const res = await api('POST', '/appointments', {
    token: bearer, body: { patientId, professionalId: pro.professionalId, serviceId: pro.serviceId, start },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.appointmentId, start, day };
}

// Cita reservada que ya empezó: un día del pasado, preparada en la base.
async function pastAppointment() {
  const day = await freePastDay(db, [p1.professionalId]);
  await addScheduleBlock(db, { clinicId, professionalId: p1.professionalId, day, from: '08:00', to: '12:00' });
  return addAppointment(db, { clinicId, patientId: patients[0], ...pick(p1), day, time: '09:00' });
}

test('RF11, I7: recepción cancela una cita con su motivo, y el espacio queda libre para otra reserva', async () => {
  const appointment = await futureAppointment();
  const res = await cancel(reception, appointment.id);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'cancelada');
  assert.equal(res.body.cancelReason, 'El paciente pidió cancelar');
  assert.equal(res.body.cancelledBy, receptionId);
  assert.ok(res.body.cancelledAt);

  // El mismo espacio, para otro paciente: se concede, porque la cita cancelada ya no cuenta para I1.
  const again = await api('POST', '/appointments', {
    token: reception, body: { patientId: patients[1], ...pick(p1), start: appointment.start },
  });
  assert.equal(again.status, 201, JSON.stringify(again.body));
});

test('RF11: cancelar exige un motivo', async () => {
  const appointment = await futureAppointment();
  for (const body of [{}, { reason: '   ' }]) {
    assert.equal((await cancel(reception, appointment.id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await appointmentStatus(db, appointment.id), 'reservada');
});

test('RF12: registrar como atendida una cita que ya empezó', async () => {
  const id = await pastAppointment();
  const res = await outcome(reception, id, 'atendida');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'atendida');
});

test('RF12, RF17: el profesional también registra el desenlace, por ejemplo una ausencia', async () => {
  const id = await pastAppointment();
  const res = await outcome(professional, id, 'ausente');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'ausente');
});

test('RF12: el desenlace antes de la hora de inicio responde 409 y la cita no cambia', async () => {
  const appointment = await futureAppointment();
  assert.equal((await outcome(reception, appointment.id, 'atendida')).status, 409);
  assert.equal(await appointmentStatus(db, appointment.id), 'reservada');
});

test('RF12: el desenlace solo puede ser atendida o ausente', async () => {
  const id = await pastAppointment();
  for (const value of ['cancelada', 'reprogramada', 'reservada', '']) {
    assert.equal((await outcome(reception, id, value)).status, 400, value);
  }
  assert.equal(await appointmentStatus(db, id), 'reservada');
});

test('RF13: una cita cancelada no admite cambios: ni otra cancelación ni un desenlace (409)', async () => {
  const appointment = await futureAppointment();
  assert.equal((await cancel(reception, appointment.id)).status, 200);
  assert.equal((await cancel(reception, appointment.id)).status, 409);
  assert.equal((await outcome(reception, appointment.id, 'atendida')).status, 409);
  assert.equal(await appointmentStatus(db, appointment.id), 'cancelada');
});

test('RF13: una cita atendida no admite cambios: ni cancelarla ni cambiar su desenlace (409)', async () => {
  const id = await pastAppointment();
  assert.equal((await outcome(reception, id, 'atendida')).status, 200);
  assert.equal((await cancel(reception, id)).status, 409);
  assert.equal((await outcome(reception, id, 'ausente')).status, 409);
  assert.equal(await appointmentStatus(db, id), 'atendida');
});

test('RF11, RF17: un profesional no puede cancelar citas (403)', async () => {
  const appointment = await futureAppointment();
  assert.equal((await cancel(professional, appointment.id)).status, 403);
  assert.equal(await appointmentStatus(db, appointment.id), 'reservada');
});

test('RF11, RF12, I5: una cita de otra clínica responde 404, igual que una inexistente, y no cambia', async () => {
  const appointment = await futureAppointment({
    clinic: cartago.clinicId, bearer: cartago.reception, pro: cartago.p, patientId: cartago.patients[0],
  });
  assert.equal((await cancel(reception, appointment.id)).status, 404);
  assert.equal((await outcome(reception, appointment.id, 'atendida')).status, 404);
  assert.equal((await cancel(reception, Number.MAX_SAFE_INTEGER)).status, 404);
  assert.equal(await appointmentStatus(db, appointment.id), 'reservada');
});

test('RF11: un id de cita que no es un número responde 400', async () => {
  assert.equal((await cancel(reception, 'abc')).status, 400);
  assert.equal((await outcome(reception, '1.5', 'atendida')).status, 400);
});

function pick({ professionalId, serviceId }) {
  return { professionalId, serviceId };
}
