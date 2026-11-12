// RF20: la agenda del día (de un profesional o de toda la clínica; el profesional, solo la suya) y RF21: el conteo de citas por estado en un rango
// de fechas. Las dos son de solo lectura. Las citas se crean por la API en días nuevos (freeDay), así las pruebas no
// dependen del seed. Las que ya empezaron (atendida, ausente) se preparan en un día pasado con addAppointment, porque
// la API no permite reservar en el pasado, y su desenlace sí se registra por la API.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import {
  addAppointment, addScheduleBlock, freeDay, freePastDay, localInstant, ownerDb, patientsOf, professionalsOf,
} from './db.js';

requireStack();
const db = ownerDb();

let reception;      // recepcion.sanjose
let clinicAdmin;    // admin.sanjose: el único con reports.read
let professional;   // laura.mora
let clinicId;       // San José
let p1;             // { professionalId, serviceId, duration }
let p2;
let patients;
let cartago;        // { clinicId, reception, p, patients }

// Un día fuera del rango de freeDay y freePastDay, para las pruebas que solo miran códigos de respuesta.
const ANY_DAY = '2000-01-03';

before(async () => {
  reception = await token('recepcion.sanjose');
  clinicAdmin = await token('admin.sanjose');
  professional = await token('laura.mora');
  clinicId = (await api('GET', '/me', { token: reception })).body.clinicId;
  [p1, p2] = await professionalsOf(db, clinicId);
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

const agenda = (bearer, query) => api('GET', `/agenda?${new URLSearchParams(query)}`, { token: bearer });
const report = (bearer, query) =>
  api('GET', `/reports/appointments-by-status?${new URLSearchParams(query)}`, { token: bearer });
const addDays = (day, n) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

const schedule = (professionalId, day, clinic = clinicId) =>
  addScheduleBlock(db, { clinicId: clinic, professionalId, day, from: '08:00', to: '12:00' });

// Reserva por la API a una hora local y devuelve el id de la cita.
async function booked({ professionalId, serviceId }, patientId, day, time, { bearer = reception, clinic = clinicId } = {}) {
  const start = await localInstant(db, clinic, day, time);
  const res = await api('POST', '/appointments', { token: bearer, body: { patientId, professionalId, serviceId, start } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.appointmentId;
}

async function cancel(appointmentId) {
  const res = await api('POST', `/appointments/${appointmentId}/cancel`, {
    token: reception, body: { reason: 'Prueba de agenda y reportes' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

// --- RF20: la agenda del día ------------------------------------------------------------------------------------

test('RF20: la agenda de un profesional lista sus citas del día en orden, con estado y nombres, también las canceladas', async () => {
  const day = await freeDay(db, [p1.professionalId]);
  await schedule(p1.professionalId, day);
  const late = await booked(p1, patients[1], day, '10:00');
  const early = await booked(p1, patients[0], day, '08:00');
  await cancel(late);

  const res = await agenda(reception, { date: day, professionalId: p1.professionalId });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.service, 'agenda');
  assert.equal(res.body.date, day);
  assert.deepEqual(res.body.appointments.map((a) => a.appointmentId), [early, late]);
  assert.deepEqual(res.body.appointments.map((a) => a.status), ['reservada', 'cancelada']);
  const [first] = res.body.appointments;
  assert.equal(first.start, await localInstant(db, clinicId, day, '08:00'));
  assert.equal(first.professional.professionalId, p1.professionalId);
  assert.equal(first.patient.patientId, patients[0]);
  assert.equal(first.service.serviceId, p1.serviceId);
  for (const name of [first.professional.name, first.patient.name, first.service.name]) {
    assert.ok(typeof name === 'string' && name.length > 0);
  }
});

test('RF20: la agenda de toda la clínica incluye a todos sus profesionales, ordenada por hora', async () => {
  const day = await freeDay(db, [p1.professionalId, p2.professionalId]);
  await schedule(p1.professionalId, day);
  await schedule(p2.professionalId, day);
  const ofP2 = await booked(p2, patients[2], day, '08:00');
  const ofP1 = await booked(p1, patients[3], day, '09:00');

  const res = await agenda(clinicAdmin, { date: day });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.professionalId, null);
  const ids = res.body.appointments.map((a) => a.appointmentId);
  assert.ok(ids.indexOf(ofP2) >= 0 && ids.indexOf(ofP2) < ids.indexOf(ofP1), `orden: ${ids}`);
  const starts = res.body.appointments.map((a) => Date.parse(a.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  const [dayStart, nextDay] = [await localInstant(db, clinicId, day, '00:00'), await localInstant(db, clinicId, addDays(day, 1), '00:00')];
  assert.ok(starts.every((t) => t >= Date.parse(dayStart) && t < Date.parse(nextDay)), 'todas empiezan ese día');
});

test('RF20, I5: una cita de otra clínica el mismo día no aparece, y un profesional de otra clínica responde 404', async () => {
  const day = await freeDay(db, [p1.professionalId, cartago.p.professionalId]);
  await schedule(cartago.p.professionalId, day, cartago.clinicId);
  const fromCartago = await booked(cartago.p, cartago.patients[0], day, '08:00',
    { bearer: cartago.reception, clinic: cartago.clinicId });

  const res = await agenda(reception, { date: day });
  assert.equal(res.status, 200);
  assert.ok(!res.body.appointments.some((a) => a.appointmentId === fromCartago));

  assert.equal((await agenda(reception, { date: day, professionalId: cartago.p.professionalId })).status, 404);
  assert.equal((await agenda(reception, { date: day, professionalId: 2147483647 })).status, 404);
});

test('RF20, RF17: el profesional solo consulta su propia agenda: sin professionalId recibe la suya, y con la de otro profesional 403', async () => {
  const me = (await api('GET', '/me', { token: professional })).body.userId;
  const mine = (await professionalsOf(db, clinicId)).find((p) => p.professionalId === me);
  const other = [p1, p2].find((p) => p.professionalId !== me);
  assert.ok(mine && other, 'laura.mora y otro profesional de San José con servicios');
  const day = await freeDay(db, [mine.professionalId, other.professionalId]);
  await schedule(mine.professionalId, day);
  await schedule(other.professionalId, day);
  const ofMine = await booked(mine, patients[4], day, '08:00');
  const ofOther = await booked(other, patients[5], day, '09:00');

  for (const query of [{ date: day }, { date: day, professionalId: me }]) {
    const res = await agenda(professional, query);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.professionalId, me);
    assert.deepEqual(res.body.appointments.map((a) => a.appointmentId), [ofMine]);
  }

  // 403 tanto para un profesional de su clínica como para uno de otra o uno inexistente: no revela si existe (I5).
  for (const professionalId of [other.professionalId, cartago.p.professionalId, 2147483647]) {
    const res = await agenda(professional, { date: day, professionalId });
    assert.equal(res.status, 403, `professionalId ${professionalId}: ${JSON.stringify(res.body)}`);
  }

  // Recepción sigue viendo la agenda de toda la clínica.
  const all = (await agenda(reception, { date: day })).body.appointments.map((a) => a.appointmentId);
  assert.ok(all.includes(ofMine) && all.includes(ofOther), `toda la clínica: ${all}`);
});

test('RF20, RF17: recepción y el profesional consultan la agenda (200); la plataforma 403 y sin token 401', async () => {
  assert.equal((await agenda(reception, { date: ANY_DAY })).status, 200);
  assert.equal((await agenda(professional, { date: ANY_DAY })).status, 200);
  assert.equal((await agenda(await token('plataforma'), { date: ANY_DAY })).status, 403);
  assert.equal((await agenda(undefined, { date: ANY_DAY })).status, 401);
});

test('RF20, I5: los parámetros se validan: sin fecha, fecha imposible, profesional no numérico o con clinicId responden 400', async () => {
  for (const query of [{}, { date: '2030-02-30' }, { date: ANY_DAY, professionalId: 'abc' }, { date: ANY_DAY, clinicId }]) {
    assert.equal((await agenda(reception, query)).status, 400, JSON.stringify(query));
  }
});

// --- RF21: conteo por estado --------------------------------------------------------------------------------------

test('RF21, RF10, RF11, RF12: cuenta por estado las citas de un profesional en un rango de fechas', async () => {
  // Día futuro: una cancelada, una reprogramada y dos reservadas (una es la que nace de la reprogramación).
  const day = await freeDay(db, [p1.professionalId]);
  await schedule(p1.professionalId, day);
  const toCancel = await booked(p1, patients[4], day, '08:00');
  const toMove = await booked(p1, patients[5], day, '09:00');
  await booked(p1, patients[6], day, '10:00');
  await cancel(toCancel);
  const moved = await api('POST', `/appointments/${toMove}/reschedule`, {
    token: reception, body: { start: await localInstant(db, clinicId, day, '11:00') },
  });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));

  const future = await report(clinicAdmin, { from: day, to: day, professionalId: p1.professionalId });
  assert.equal(future.status, 200, JSON.stringify(future.body));
  assert.deepEqual(future.body.byStatus, { reservada: 2, atendida: 0, ausente: 0, cancelada: 1, reprogramada: 1 });
  assert.equal(future.body.total, 4);

  // Día pasado: una atendida y una ausente, con el desenlace registrado por la API.
  const past = await freePastDay(db, [p1.professionalId]);
  await schedule(p1.professionalId, past);
  for (const [time, outcome] of [['08:00', 'atendida'], ['09:00', 'ausente']]) {
    const appointmentId = await addAppointment(db, {
      clinicId, patientId: patients[7], professionalId: p1.professionalId, serviceId: p1.serviceId, day: past, time,
    });
    const res = await api('POST', `/appointments/${appointmentId}/outcome`, { token: clinicAdmin, body: { outcome } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const before = await report(clinicAdmin, { from: past, to: past, professionalId: p1.professionalId });
  assert.deepEqual(before.body.byStatus, { reservada: 0, atendida: 1, ausente: 1, cancelada: 0, reprogramada: 0 });
  assert.equal(before.body.total, 2);
});

test('RF21: el conteo de toda la clínica trae los cinco estados e incluye los de cada profesional', async () => {
  const day = await freeDay(db, [p1.professionalId, p2.professionalId]);
  await schedule(p1.professionalId, day);
  await schedule(p2.professionalId, day);
  await booked(p1, patients[8], day, '08:00');
  await cancel(await booked(p2, patients[9], day, '08:00'));

  const clinic = await report(clinicAdmin, { from: day, to: day });
  assert.equal(clinic.status, 200, JSON.stringify(clinic.body));
  assert.equal(clinic.body.professionalId, null);
  assert.deepEqual(Object.keys(clinic.body.byStatus), ['reservada', 'atendida', 'ausente', 'cancelada', 'reprogramada']);
  assert.ok(clinic.body.byStatus.reservada >= 1 && clinic.body.byStatus.cancelada >= 1, JSON.stringify(clinic.body));
  assert.equal(clinic.body.total, Object.values(clinic.body.byStatus).reduce((a, b) => a + b, 0));
});

test('RF21: el rango se valida: al revés, de más de 366 días o sin fin responde 400; 366 días exactos, 200', async () => {
  const cases = [
    [400, { from: ANY_DAY, to: addDays(ANY_DAY, -1) }],
    [400, { from: ANY_DAY, to: addDays(ANY_DAY, 366) }],
    [400, { from: ANY_DAY }],
    [400, { from: ANY_DAY, to: ANY_DAY, clinicId }],
    [200, { from: ANY_DAY, to: addDays(ANY_DAY, 365) }],
    [200, { from: ANY_DAY, to: ANY_DAY }],
  ];
  for (const [status, query] of cases) {
    const res = await report(clinicAdmin, query);
    assert.equal(res.status, status, `${JSON.stringify(query)}: ${JSON.stringify(res.body)}`);
  }
});

test('RF21, RF17, I5: solo el administrador de la clínica cuenta citas, y un profesional de otra clínica responde 404', async () => {
  const query = { from: ANY_DAY, to: ANY_DAY };
  assert.equal((await report(reception, query)).status, 403);
  assert.equal((await report(professional, query)).status, 403);
  assert.equal((await report(undefined, query)).status, 401);
  assert.equal((await report(clinicAdmin, { ...query, professionalId: cartago.p.professionalId })).status, 404);
});
