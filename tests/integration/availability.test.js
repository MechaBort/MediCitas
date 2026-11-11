// RF7 y RF8: disponibilidad. Los espacios libres salen del horario (RF5), menos los bloqueos (RF6) y menos las citas
// reservadas, cortados por la duración del servicio. Las pruebas de I7 e I8 reservan, cancelan o reprograman un espacio
// devuelto y vuelven a consultar: la siguiente consulta tiene que reflejar el cambio. Cuando llegue la caché de RF7,
// estas mismas pruebas son las que demuestran que la caché no devuelve espacios viejos.
// Cada prueba prepara su propio horario en días lejanos y únicos (db.js), así no depende del seed.
//
// Desde la caché de RF7, una consulta deja guardados los huecos de ese día durante 60 s, también si están vacíos. Los
// helpers de db.js escriben directo en la base y no suben la versión de la agenda, así que si otra prueba eligiera ese
// mismo día con freeDay y le agregara horario, leería la copia vacía. Por eso las consultas a días que se quedan sin
// horario usan fechas del año 2000 (EMPTY_DAY), que freeDay y freePastDay nunca eligen, o le agregan horario al día
// después de consultarlo, para que freeDay ya no lo elija.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import {
  addBlockade, addScheduleBlock, freeDay, freeDays, freePastDay, localInstant, ownerDb, patientsOf, professionalsOf,
} from './db.js';

requireStack();
const db = ownerDb();

let reception;      // recepcion.sanjose
let clinicId;       // San José
let p1;             // { professionalId, serviceId, duration }
let patients;       // ids de pacientes de San José
let notOffered;     // servicio de San José que p1 no atiende
let other;          // profesional y servicio de Cartago
let shared;         // { serviceId, duration, professionalIds }: un servicio que atienden dos o más profesionales

before(async () => {
  reception = await token('recepcion.sanjose');
  clinicId = (await api('GET', '/me', { token: reception })).body.clinicId;
  const cartagoId = (await api('GET', '/me', { token: await token('recepcion.cartago') })).body.clinicId;

  [p1] = await professionalsOf(db, clinicId);
  [other] = await professionalsOf(db, cartagoId);
  patients = await patientsOf(db, clinicId);

  notOffered = (await db.query(`
    SELECT service_id FROM services
     WHERE clinic_id = $1 AND is_active
       AND service_id NOT IN (SELECT service_id FROM services_per_professionals WHERE professional_id = $2)
     LIMIT 1`, [clinicId, p1.professionalId])).rows[0].service_id;

  // Los mismos filtros que RF8: servicio, asignación, usuario y profesional activos.
  const { rows: [row] } = await db.query(`
    SELECT spp.service_id AS "serviceId", s.duration_minutes AS duration,
           array_agg(spp.professional_id ORDER BY spp.professional_id) AS "professionalIds"
      FROM services_per_professionals spp
      JOIN services s       ON s.service_id = spp.service_id AND s.is_active
      JOIN users u          ON u.user_id = spp.professional_id AND u.is_active
      JOIN professionals pr ON pr.user_id = spp.professional_id AND pr.is_active
     WHERE spp.clinic_id = $1 AND spp.is_active
     GROUP BY spp.service_id, s.duration_minutes
    HAVING count(*) >= 2
     LIMIT 1`, [clinicId]);
  shared = row;
});

const byProfessional = (bearer, professionalId, query) =>
  api('GET', `/availability/professionals/${professionalId}?${new URLSearchParams(query)}`, { token: bearer });
const byService = (bearer, serviceId, query) =>
  api('GET', `/availability/services/${serviceId}?${new URLSearchParams(query)}`, { token: bearer });
const book = (body) => api('POST', '/appointments', { token: reception, body });

// Un día sin horario fuera del rango de freeDay (+400 a +4000 días) y de freePastDay (-400 a -4000).
const EMPTY_DAY = '2000-01-03';

const starts = (slots) => slots.map((s) => s.start);
const minutesBetween = (start, end) => (Date.parse(end) - Date.parse(start)) / 60_000;
const addDays = (day, n) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Espacios de un profesional en un día para su servicio; exige 200.
async function slotsOf({ professionalId, serviceId }, day, bearer = reception) {
  const res = await byProfessional(bearer, professionalId, { serviceId, date: day });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.slots;
}

// Inicios esperados: espacios seguidos de `duration` minutos desde el inicio de cada tramo libre [desde, hasta),
// en la hora local de la clínica.
async function grid(day, ranges, duration) {
  const expected = [];
  for (const [from, to] of ranges) {
    const end = Date.parse(await localInstant(db, clinicId, day, to));
    for (let t = Date.parse(await localInstant(db, clinicId, day, from)); t + duration * 60_000 <= end; t += duration * 60_000) {
      expected.push(new Date(t).toISOString());
    }
  }
  return expected;
}

// Un día nuevo con esos bloques de horario para p1.
async function dayWithSchedule(blocks = [['08:00', '12:00']]) {
  const day = await freeDay(db, [p1.professionalId]);
  for (const [from, to] of blocks) {
    await addScheduleBlock(db, { clinicId, professionalId: p1.professionalId, day, from, to });
  }
  return day;
}

async function booked(start, patientId = patients[0]) {
  const res = await book({ patientId, professionalId: p1.professionalId, serviceId: p1.serviceId, start });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// --- RF7: el cálculo ---------------------------------------------------------------------------------------------

test('RF7: un día con horario de 08:00 a 12:00 devuelve espacios seguidos, del largo del servicio', async () => {
  const day = await dayWithSchedule();
  const res = await byProfessional(reception, p1.professionalId, { serviceId: p1.serviceId, date: day });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.service, 'agenda');
  assert.equal(res.body.professionalId, p1.professionalId);
  assert.equal(res.body.serviceId, p1.serviceId);
  assert.equal(res.body.date, day);
  assert.equal(res.body.durationMinutes, p1.duration);
  assert.deepEqual(starts(res.body.slots), await grid(day, [['08:00', '12:00']], p1.duration));
  assert.ok(res.body.slots.every((s) => minutesBetween(s.start, s.end) === p1.duration));
});

test('RF5, RF7: una jornada partida no da espacios en el corte, y dos bloques seguidos se unen', async () => {
  // El corte entre los dos bloques de la mañana cae un minuto después del primer espacio: si no se unieran, el
  // segundo espacio (que cruza ese corte) no existiría.
  const split = hhmm(8 * 60 + p1.duration + 1);
  const day = await dayWithSchedule([['08:00', split], [split, '12:00'], ['14:00', '16:00']]);
  const slots = await slotsOf(p1, day);
  assert.deepEqual(starts(slots), await grid(day, [['08:00', '12:00'], ['14:00', '16:00']], p1.duration));
});

test('RF6, RF7: un bloqueo quita los espacios que toca', async () => {
  const day = await dayWithSchedule();
  await addBlockade(db, { clinicId, professionalId: p1.professionalId, day, from: '09:00', to: '10:00' });
  const slots = await slotsOf(p1, day);
  assert.deepEqual(starts(slots), await grid(day, [['08:00', '09:00'], ['10:00', '12:00']], p1.duration));
});

test('RF7: un día sin horario, o con horario pero ya pasado, no tiene espacios', async () => {
  const empty = await freeDay(db, [p1.professionalId]);
  assert.deepEqual(await slotsOf(p1, empty), []);
  // El día queda con su copia vacía en la caché: con un horario, freeDay ya no lo elige para otra prueba.
  await addScheduleBlock(db, { clinicId, professionalId: p1.professionalId, day: empty, from: '08:00', to: '12:00' });

  const past = await freePastDay(db, [p1.professionalId]);
  await addScheduleBlock(db, { clinicId, professionalId: p1.professionalId, day: past, from: '08:00', to: '12:00' });
  assert.deepEqual(await slotsOf(p1, past), []);
});

// --- I7 e I8: la siguiente consulta refleja cada cambio -----------------------------------------------------------

test('RF7, RF9, I8: un espacio devuelto se reserva (201), y la siguiente consulta ya no lo muestra', async () => {
  const day = await dayWithSchedule();
  const before = await slotsOf(p1, day);
  const chosen = before[1];

  await booked(chosen.start);

  assert.deepEqual(starts(await slotsOf(p1, day)), starts(before).filter((s) => s !== chosen.start));
});

test('RF7, RF11, I7: cancelar una cita devuelve su espacio a la siguiente consulta', async () => {
  const day = await dayWithSchedule();
  const before = await slotsOf(p1, day);
  const appointment = await booked(before[0].start);
  assert.equal((await slotsOf(p1, day)).length, before.length - 1);

  const res = await api('POST', `/appointments/${appointment.appointmentId}/cancel`, {
    token: reception, body: { reason: 'El paciente avisó que no puede' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.deepEqual(await slotsOf(p1, day), before);
});

test('RF7, RF10, I7: reprogramar libera el espacio viejo y ocupa el nuevo', async () => {
  const day = await dayWithSchedule();
  const before = await slotsOf(p1, day);
  const appointment = await booked(before[0].start);

  const res = await api('POST', `/appointments/${appointment.appointmentId}/reschedule`, {
    token: reception, body: { start: before[2].start },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.deepEqual(starts(await slotsOf(p1, day)), starts(before).filter((s) => s !== before[2].start));
});

// --- RF7: validación, aislamiento y permisos ----------------------------------------------------------------------

test('RF7, I5: un profesional o un servicio de otra clínica responde 404, igual que uno inexistente', async () => {
  const date = await freeDay(db, [p1.professionalId]);
  const cases = {
    'profesional de Cartago': [other.professionalId, p1.serviceId],
    'servicio de Cartago': [p1.professionalId, other.serviceId],
    'profesional inexistente': [2147483647, p1.serviceId],
  };
  for (const [name, [professionalId, serviceId]] of Object.entries(cases)) {
    assert.equal((await byProfessional(reception, professionalId, { serviceId, date })).status, 404, name);
  }
});

test('RF4, RF7: un servicio que el profesional no atiende responde 400', async () => {
  const date = await freeDay(db, [p1.professionalId]);
  const res = await byProfessional(reception, p1.professionalId, { serviceId: notOffered, date });
  assert.equal(res.status, 400);
});

test('RF7, RF8, RF17: sin token responde 401, la plataforma 403, y el profesional sí consulta (200)', async () => {
  const date = EMPTY_DAY;
  const query = { serviceId: p1.serviceId, date };
  assert.equal((await byProfessional(undefined, p1.professionalId, query)).status, 401);
  assert.equal((await byService(undefined, p1.serviceId, { from: date, to: date })).status, 401);
  assert.equal((await byProfessional(await token('plataforma'), p1.professionalId, query)).status, 403);
  assert.equal((await byProfessional(await token('laura.mora'), p1.professionalId, query)).status, 200);
});

test('RF7, I5: los parámetros se validan: sin fecha, fecha imposible, sin servicio o con clinicId responden 400', async () => {
  const date = await freeDay(db, [p1.professionalId]);
  const cases = [
    [p1.professionalId, { serviceId: p1.serviceId }],
    [p1.professionalId, { serviceId: p1.serviceId, date: '2030-02-30' }],
    [p1.professionalId, { serviceId: p1.serviceId, date: '07/01/2030' }],
    [p1.professionalId, { date }],
    [p1.professionalId, { serviceId: 'uno', date }],
    [p1.professionalId, { serviceId: p1.serviceId, date, clinicId }],
    ['abc', { serviceId: p1.serviceId, date }],
  ];
  for (const [professionalId, query] of cases) {
    const res = await byProfessional(reception, professionalId, query);
    assert.equal(res.status, 400, `${professionalId} ${JSON.stringify(query)}`);
  }
});

// --- RF8 ----------------------------------------------------------------------------------------------------------

test('RF8: solo aparecen los profesionales con espacio, y cada día coincide con RF7', async () => {
  const [a, b] = shared.professionalIds;
  const days = await freeDays(db, shared.professionalIds, 3);
  // a atiende el primer y el tercer día; b tiene horario el segundo, pero todo bloqueado: no tiene espacio.
  await addScheduleBlock(db, { clinicId, professionalId: a, day: days[0], from: '08:00', to: '12:00' });
  await addScheduleBlock(db, { clinicId, professionalId: a, day: days[2], from: '14:00', to: '16:00' });
  await addScheduleBlock(db, { clinicId, professionalId: b, day: days[1], from: '08:00', to: '12:00' });
  await addBlockade(db, { clinicId, professionalId: b, day: days[1], from: '08:00', to: '12:00' });

  const res = await byService(reception, shared.serviceId, { from: days[0], to: days[2] });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.durationMinutes, shared.duration);
  assert.deepEqual(res.body.professionals.map((p) => p.professionalId), [a]);
  const [entry] = res.body.professionals;
  assert.ok(entry.name.length > 0);
  assert.deepEqual(entry.days.map((d) => d.date), [days[0], days[2]]);
  for (const { date, slots } of entry.days) {
    assert.deepEqual(slots, await slotsOf({ professionalId: a, serviceId: shared.serviceId }, date), date);
  }
});

test('RF8, I5: el rango se valida: al revés o de más de 31 días responde 400; de otra clínica, 404', async () => {
  const from = EMPTY_DAY;
  const cases = [
    [400, shared.serviceId, { from, to: addDays(from, -1) }],
    [400, shared.serviceId, { from, to: addDays(from, 31) }],
    [400, shared.serviceId, { from }],
    [400, shared.serviceId, { from, to: from, clinicId }],
    [200, shared.serviceId, { from, to: addDays(from, 30) }],
    [200, shared.serviceId, { from, to: from }],
    [404, other.serviceId, { from, to: from }],
  ];
  for (const [status, serviceId, query] of cases) {
    const res = await byService(reception, serviceId, query);
    assert.equal(res.status, status, `${serviceId} ${JSON.stringify(query)}: ${JSON.stringify(res.body)}`);
  }
});
