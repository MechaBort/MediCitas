// RF5 (horarios de atención por profesional) y RF6 (bloqueos de agenda con detección de citas en
// conflicto), más I3 (ninguna cita fuera del horario o en bloqueo; MC006 al recortar/borrar un
// bloque con citas reservadas), I5 (aislamiento por clínica), I8 (disponibilidad e invalidación de
// versión tras cada cambio) y RF17 (schedules.manage vs schedules.manage_own).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { appointmentStatus, freeDay, localInstant, ownerDb, patientsOf, professionalsOf } from './db.js';

requireStack();
const db = ownerDb();

let adminSanJose;
let receptionSanJose;
let lauraToken;
let lauraUserId;
let clinicId;
let p1; // Laura Mora (user_id 6)
let p2; // Andrés Solís (user_id 7)
let patients;
let otherProf; // Profesional de Cartago

before(async () => {
  adminSanJose = await token('admin.sanjose');
  receptionSanJose = await token('recepcion.sanjose');
  lauraToken = await token('laura.mora');

  const meAdmin = (await api('GET', '/me', { token: adminSanJose })).body;
  const meLaura = (await api('GET', '/me', { token: lauraToken })).body;
  clinicId = meAdmin.clinicId;
  lauraUserId = meLaura.userId;

  const cartagoId = (await api('GET', '/me', { token: await token('admin.cartago') })).body.clinicId;
  const profs = await professionalsOf(db, clinicId);
  p1 = profs.find((p) => p.professionalId === lauraUserId) ?? profs[0];
  p2 = profs.find((p) => p.professionalId !== p1.professionalId);
  [otherProf] = await professionalsOf(db, cartagoId);
  patients = await patientsOf(db, clinicId);
});

const availability = (professionalId, serviceId, date) =>
  api('GET', `/availability/professionals/${professionalId}?${new URLSearchParams({ serviceId, date })}`, {
    token: receptionSanJose,
  });

test('RF5, RF7, I8: definir jornada partida por la API habilita los espacios de disponibilidad en hora local', async () => {
  const day = await freeDay(db, [p1.professionalId]);

  // Antes de crear bloques, no hay espacios ese día.
  const emptyAvail = await availability(p1.professionalId, p1.serviceId, day);
  assert.equal(emptyAvail.status, 200);
  assert.equal(emptyAvail.body.slots.length, 0);

  // Bloque de mañana (08:00 a 10:00) y bloque de tarde (14:00 a 16:00).
  const morning = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '08:00', endTime: '10:00' },
  });
  assert.equal(morning.status, 201, JSON.stringify(morning.body));
  assert.equal(morning.service, 'agenda');
  assert.equal(morning.body.professionalId, p1.professionalId);
  assert.equal(morning.body.date, day);
  assert.equal(morning.body.startTime, '08:00');
  assert.equal(morning.body.endTime, '10:00');

  const afternoon = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '14:00', endTime: '16:00' },
  });
  assert.equal(afternoon.status, 201, JSON.stringify(afternoon.body));

  // Listar los bloques de ese día por GET /schedules.
  const listed = await api(
    'GET',
    `/schedules?${new URLSearchParams({ professionalId: p1.professionalId, from: day, to: day })}`,
    { token: receptionSanJose },
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 2);
  assert.deepEqual(
    listed.body.map((b) => [b.startTime, b.endTime]),
    [['08:00', '10:00'], ['14:00', '16:00']],
  );

  // Disponibilidad refleja de inmediato la jornada partida (I8).
  const afterAvail = await availability(p1.professionalId, p1.serviceId, day);
  assert.equal(afterAvail.status, 200);
  const expectedCount = Math.floor(120 / p1.duration) * 2;
  assert.equal(afterAvail.body.slots.length, expectedCount);
});

test('RF5: dos bloques de horario que se solapan para el mismo profesional responden 409 y hora inválida responde 400', async () => {
  const day = await freeDay(db, [p1.professionalId]);

  const first = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '08:00', endTime: '12:00' },
  });
  assert.equal(first.status, 201);

  const overlap = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '11:00', endTime: '15:00' },
  });
  assert.equal(overlap.status, 409);

  const inverted = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '14:00', endTime: '12:00' },
  });
  assert.equal(inverted.status, 400);
});

test('RF5, I3, I8: modificar o borrar un bloque con citas reservadas falla con 409 (MC006), y sin citas reservadas funciona', async () => {
  const day = await freeDay(db, [p1.professionalId]);

  const created = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '08:00', endTime: '12:00' },
  });
  assert.equal(created.status, 201);
  const scheduleId = created.body.scheduleId;

  // Reservar una cita a las 08:00.
  const start = await localInstant(db, clinicId, day, '08:00');
  const booked = await api('POST', '/appointments', {
    token: receptionSanJose,
    body: {
      patientId: patients[0],
      professionalId: p1.professionalId,
      serviceId: p1.serviceId,
      start,
    },
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));

  // Recortar el bloque a [09:00, 12:00) dejaría la cita de las 08:00 fuera del horario -> 409 (MC006).
  const badPatch = await api('PATCH', `/schedules/${scheduleId}`, {
    token: adminSanJose,
    body: { startTime: '09:00' },
  });
  assert.equal(badPatch.status, 409);

  // Borrar el bloque con la cita reservada activa también falla con 409 (MC006).
  const badDelete = await api('DELETE', `/schedules/${scheduleId}`, {
    token: adminSanJose,
  });
  assert.equal(badDelete.status, 409);

  // Recortar solo el final a [08:00, 11:00) sigue cubriendo la cita de las 08:00 -> 200.
  const okPatch = await api('PATCH', `/schedules/${scheduleId}`, {
    token: adminSanJose,
    body: { endTime: '11:00' },
  });
  assert.equal(okPatch.status, 200, JSON.stringify(okPatch.body));
  assert.equal(okPatch.body.endTime, '11:00');

  // Al cancelar la cita, el bloque ya no tiene citas reservadas y se puede eliminar -> 204.
  const cancelled = await api('POST', `/appointments/${booked.body.appointmentId}/cancel`, {
    token: receptionSanJose,
    body: { reason: 'Paciente reprogramará luego' },
  });
  assert.equal(cancelled.status, 200);

  const okDelete = await api('DELETE', `/schedules/${scheduleId}`, {
    token: adminSanJose,
  });
  assert.equal(okDelete.status, 204);

  const afterAvail = await availability(p1.professionalId, p1.serviceId, day);
  assert.equal(afterAvail.body.slots.length, 0);
});

test('RF6, I3, RF7, I8: un bloqueo sobre una cita ya reservada no la cancela, la lista en conflicts y retira disponibilidad', async () => {
  const day = await freeDay(db, [p1.professionalId]);

  const schedule = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '08:00', endTime: '12:00' },
  });
  assert.equal(schedule.status, 201);

  // Reservar una cita a las 09:00.
  const start9 = await localInstant(db, clinicId, day, '09:00');
  const appt = await api('POST', '/appointments', {
    token: receptionSanJose,
    body: {
      patientId: patients[1],
      professionalId: p1.professionalId,
      serviceId: p1.serviceId,
      start: start9,
      description: 'Cita antes del bloqueo',
    },
  });
  assert.equal(appt.status, 201, JSON.stringify(appt.body));

  // Registrar un bloqueo de 09:00 a 11:00 sobre ese mismo día.
  const blockade = await api('POST', '/blockades', {
    token: adminSanJose,
    body: {
      professionalId: p1.professionalId,
      date: day,
      startTime: '09:00',
      endTime: '11:00',
      reason: 'Congreso médico extraordinario',
    },
  });
  assert.equal(blockade.status, 201, JSON.stringify(blockade.body));
  assert.equal(blockade.body.reason, 'Congreso médico extraordinario');

  // La cita reservada NO se canceló: sigue en estado "reservada" y aparece en conflicts.
  assert.equal(await appointmentStatus(db, appt.body.appointmentId), 'reservada');
  assert.equal(blockade.body.conflicts.length, 1);
  assert.equal(blockade.body.conflicts[0].appointmentId, appt.body.appointmentId);
  assert.equal(blockade.body.conflicts[0].patientId, patients[1]);

  // También aparece en GET /blockades/conflicts filtrando por el bloqueo.
  const conflictsRes = await api(
    'GET',
    `/blockades/conflicts?${new URLSearchParams({ blockadeId: blockade.body.blockadeId })}`,
    { token: receptionSanJose },
  );
  assert.equal(conflictsRes.status, 200);
  assert.equal(conflictsRes.body.length, 1);
  assert.equal(conflictsRes.body[0].appointmentId, appt.body.appointmentId);

  // La disponibilidad ya no ofrece ningún espacio entre 09:00 y 11:00 (I8).
  const avail = await availability(p1.professionalId, p1.serviceId, day);
  assert.equal(avail.status, 200);
  const start10 = await localInstant(db, clinicId, day, '10:00');
  assert.ok(!avail.body.slots.some((s) => s.start === start9 || s.start === start10));

  // Intentar reservar una cita nueva dentro del bloqueo (10:00) falla con 400 (MC001, I3).
  const blockedBook = await api('POST', '/appointments', {
    token: receptionSanJose,
    body: {
      patientId: patients[2],
      professionalId: p1.professionalId,
      serviceId: p1.serviceId,
      start: start10,
    },
  });
  assert.equal(blockedBook.status, 400);

  // Al borrar el bloqueo, el espacio de las 10:00 vuelve a estar disponible.
  const delRes = await api('DELETE', `/blockades/${blockade.body.blockadeId}`, {
    token: adminSanJose,
  });
  assert.equal(delRes.status, 204);

  const availAfterDelete = await availability(p1.professionalId, p1.serviceId, day);
  assert.ok(availAfterDelete.body.slots.some((s) => s.start === start10));
});

test('RF5, RF6, RF17: un profesional con schedules.manage_own gestiona su propia agenda pero recibe 403 sobre otro profesional, y recepción recibe 403 al escribir', async () => {
  const day = await freeDay(db, [p1.professionalId, p2.professionalId]);

  // Laura (profesional, p1) puede crear su propio horario y su propio bloqueo.
  const ownSchedule = await api('POST', '/schedules', {
    token: lauraToken,
    body: { professionalId: p1.professionalId, date: day, startTime: '08:00', endTime: '10:00' },
  });
  assert.equal(ownSchedule.status, 201, JSON.stringify(ownSchedule.body));

  const ownBlockade = await api('POST', '/blockades', {
    token: lauraToken,
    body: {
      professionalId: p1.professionalId,
      date: day,
      startTime: '09:00',
      endTime: '10:00',
      reason: 'Permiso personal de Laura',
    },
  });
  assert.equal(ownBlockade.status, 201, JSON.stringify(ownBlockade.body));

  // Laura intenta crear horario o bloqueo para Andrés (p2) -> 403.
  const otherSchedule = await api('POST', '/schedules', {
    token: lauraToken,
    body: { professionalId: p2.professionalId, date: day, startTime: '08:00', endTime: '10:00' },
  });
  assert.equal(otherSchedule.status, 403);

  const otherBlockade = await api('POST', '/blockades', {
    token: lauraToken,
    body: {
      professionalId: p2.professionalId,
      date: day,
      startTime: '08:00',
      endTime: '10:00',
      reason: 'Intento sobre otro profesional',
    },
  });
  assert.equal(otherBlockade.status, 403);

  // Admin crea un bloque de horario para Andrés; Laura intenta editarlo o borrarlo -> 403.
  const p2Schedule = await api('POST', '/schedules', {
    token: adminSanJose,
    body: { professionalId: p2.professionalId, date: day, startTime: '08:00', endTime: '10:00' },
  });
  assert.equal(p2Schedule.status, 201);

  assert.equal(
    (await api('PATCH', `/schedules/${p2Schedule.body.scheduleId}`, {
      token: lauraToken,
      body: { endTime: '11:00' },
    })).status,
    403,
  );
  assert.equal(
    (await api('DELETE', `/schedules/${p2Schedule.body.scheduleId}`, { token: lauraToken })).status,
    403,
  );

  // Recepción no tiene schedules.manage ni schedules.manage_own -> 403 al escribir.
  const receptionWrite = await api('POST', '/schedules', {
    token: receptionSanJose,
    body: { professionalId: p1.professionalId, date: day, startTime: '13:00', endTime: '15:00' },
  });
  assert.equal(receptionWrite.status, 403);
});

test('RF5, RF6, I5: horarios y bloqueos de otra clínica responden 404 y no aceptan clinicId en el cuerpo', async () => {
  const day = await freeDay(db, [otherProf.professionalId]);

  // Consultar o crear horarios/bloqueos para un profesional de Cartago desde San José -> 404.
  assert.equal(
    (await api('GET', `/schedules?professionalId=${otherProf.professionalId}`, { token: adminSanJose })).status,
    404,
  );
  assert.equal(
    (await api('POST', '/schedules', {
      token: adminSanJose,
      body: { professionalId: otherProf.professionalId, date: day, startTime: '08:00', endTime: '12:00' },
    })).status,
    404,
  );
  assert.equal(
    (await api('POST', '/blockades', {
      token: adminSanJose,
      body: {
        professionalId: otherProf.professionalId,
        date: day,
        startTime: '08:00',
        endTime: '10:00',
        reason: 'Otra clínica',
      },
    })).status,
    404,
  );

  // Enviar clinicId en el cuerpo se rechaza con 400 (.strict()).
  assert.equal(
    (await api('POST', '/schedules', {
      token: adminSanJose,
      body: {
        clinicId: 2,
        professionalId: p1.professionalId,
        date: day,
        startTime: '08:00',
        endTime: '12:00',
      },
    })).status,
    400,
  );
});
