// I5: "Ningún dato de una clínica resulta accesible desde otra, por ninguna ruta ni combinación de
// parámetros." Prueba las tres capas de defensa multi-tenant documentadas en el README:
//   1. La clínica sale siempre del token (users.clinic_id) y cualquier intento de enviar clinicId o
//      clinic_id en el body o en los query params se rechaza con 400.
//   2. Toda lectura o escritura en la API filtra por req.user.clinicId: un recurso de otra clínica
//      (Cartago o Bogotá visto desde San José) responde exactamente el mismo 404 que un id inexistente,
//      y ninguna combinación cruzada (paciente de A con profesional o servicio de B) surte efecto.
//   3. En el motor PostgreSQL, las llaves foráneas compuestas (clinic_id, ...) impiden con 23503
//      asociar filas de clínicas distintas incluso si una consulta del backend olvidara validar.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { addScheduleBlock, appointmentStatus, freeDay, localInstant, ownerDb, patientsOf, professionalsOf } from './db.js';

requireStack();
const db = ownerDb();

let adminSJ;
let receptionSJ;
let adminCartago;
let receptionCartago;
let adminBogota;

let sjClinicId;
let cartagoClinicId;
let bogotaClinicId;

let sjProf;
let cartagoProf;
let bogotaProf;

let sjPatientId;
let cartagoPatientId;
let bogotaPatientId;

let cartagoUserId;
let cartagoApptId;

before(async () => {
  adminSJ = await token('admin.sanjose');
  receptionSJ = await token('recepcion.sanjose');
  adminCartago = await token('admin.cartago');
  receptionCartago = await token('recepcion.cartago');
  adminBogota = await token('admin.bogota');

  sjClinicId = (await api('GET', '/me', { token: adminSJ })).body.clinicId;
  cartagoClinicId = (await api('GET', '/me', { token: adminCartago })).body.clinicId;
  bogotaClinicId = (await api('GET', '/me', { token: adminBogota })).body.clinicId;

  [sjProf] = await professionalsOf(db, sjClinicId);
  [cartagoProf] = await professionalsOf(db, cartagoClinicId);
  [bogotaProf] = await professionalsOf(db, bogotaClinicId);

  [sjPatientId] = await patientsOf(db, sjClinicId);
  [cartagoPatientId] = await patientsOf(db, cartagoClinicId);
  [bogotaPatientId] = await patientsOf(db, bogotaClinicId);

  cartagoUserId = cartagoProf.professionalId;

  // Preparar una cita reservada en Cartago para intentar atacarla desde San José.
  const day = await freeDay(db, [cartagoProf.professionalId]);
  await addScheduleBlock(db, {
    clinicId: cartagoClinicId,
    professionalId: cartagoProf.professionalId,
    day,
    from: '08:00',
    to: '12:00',
  });
  const start = await localInstant(db, cartagoClinicId, day, '09:00');
  const booked = await api('POST', '/appointments', {
    token: receptionCartago,
    body: {
      patientId: cartagoPatientId,
      professionalId: cartagoProf.professionalId,
      serviceId: cartagoProf.serviceId,
      start,
      description: 'Cita privada de Cartago',
    },
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  cartagoApptId = booked.body.appointmentId;
});

test('I5, RF2: los listados y detalles de usuarios de San José, Cartago y Bogotá están estrictamente aislados entre sí', async () => {
  const [sjUsers, cartagoUsers, bogotaUsers] = await Promise.all([
    api('GET', '/users', { token: adminSJ }),
    api('GET', '/users', { token: adminCartago }),
    api('GET', '/users', { token: adminBogota }),
  ]);

  assert.equal(sjUsers.status, 200);
  assert.equal(cartagoUsers.status, 200);
  assert.equal(bogotaUsers.status, 200);

  const sjIds = new Set(sjUsers.body.map((u) => u.userId));
  const cartagoIds = new Set(cartagoUsers.body.map((u) => u.userId));
  const bogotaIds = new Set(bogotaUsers.body.map((u) => u.userId));

  // Ningún usuario aparece en más de una clínica.
  for (const id of sjIds) {
    assert.ok(!cartagoIds.has(id), `El usuario ${id} apareció en San José y Cartago`);
    assert.ok(!bogotaIds.has(id), `El usuario ${id} apareció en San José y Bogotá`);
  }
  for (const id of cartagoIds) {
    assert.ok(!bogotaIds.has(id), `El usuario ${id} apareció en Cartago y Bogotá`);
  }

  // Consultar un usuario de Cartago desde San José devuelve exactamente el mismo 404 que un id inexistente.
  const crossGet = await api('GET', `/users/${cartagoUserId}`, { token: adminSJ });
  const nonExistentGet = await api('GET', '/users/999999', { token: adminSJ });
  assert.equal(crossGet.status, 404);
  assert.deepEqual(crossGet.body, nonExistentGet.body);

  // Intentar dar de baja un usuario de Cartago desde San José responde 404 y lo deja activo.
  const crossPatch = await api('PATCH', `/users/${cartagoUserId}`, {
    token: adminSJ,
    body: { isActive: false },
  });
  assert.equal(crossPatch.status, 404);
  const { rows: [stillActive] } = await db.query('SELECT is_active FROM users WHERE user_id = $1', [cartagoUserId]);
  assert.equal(stillActive.is_active, true);
});

test('I5, RF7, RF8: consultar disponibilidad con profesionales o servicios de otra clínica responde 404 sin revelar su existencia', async () => {
  const day = await freeDay(db, [sjProf.professionalId, cartagoProf.professionalId]);

  // Profesional de Cartago con servicio de Cartago, visto desde San José -> 404.
  const res1 = await api(
    'GET',
    `/availability/professionals/${cartagoProf.professionalId}?serviceId=${cartagoProf.serviceId}&date=${day}`,
    { token: receptionSJ },
  );
  assert.equal(res1.status, 404);

  // Profesional de San José con servicio de Cartago -> 404.
  const res2 = await api(
    'GET',
    `/availability/professionals/${sjProf.professionalId}?serviceId=${cartagoProf.serviceId}&date=${day}`,
    { token: receptionSJ },
  );
  assert.equal(res2.status, 404);

  // Profesional de Bogotá con servicio de San José -> 404.
  const res3 = await api(
    'GET',
    `/availability/professionals/${bogotaProf.professionalId}?serviceId=${sjProf.serviceId}&date=${day}`,
    { token: receptionSJ },
  );
  assert.equal(res3.status, 404);

  // Disponibilidad por servicio (RF8) de un servicio de Cartago o Bogotá vista desde San José -> 404.
  const res4 = await api(
    'GET',
    `/availability/services/${cartagoProf.serviceId}?from=${day}&to=${day}`,
    { token: receptionSJ },
  );
  assert.equal(res4.status, 404);
});

test('I5, RF9, RF10, RF11, RF12: ninguna combinación de recursos entre clínicas permite reservar, reprogramar, cancelar ni registrar desenlace', async () => {
  const day = await freeDay(db, [sjProf.professionalId]);
  await addScheduleBlock(db, {
    clinicId: sjClinicId,
    professionalId: sjProf.professionalId,
    day,
    from: '08:00',
    to: '12:00',
  });
  const start = await localInstant(db, sjClinicId, day, '09:00');

  // Combinaciones cruzadas en POST /appointments (RF9):
  // 1) Paciente de Cartago + profesional y servicio de San José -> 404.
  assert.equal(
    (await api('POST', '/appointments', {
      token: receptionSJ,
      body: {
        patientId: cartagoPatientId,
        professionalId: sjProf.professionalId,
        serviceId: sjProf.serviceId,
        start,
      },
    })).status,
    404,
  );

  // 2) Paciente de San José + profesional de Cartago + servicio de San José -> 404.
  assert.equal(
    (await api('POST', '/appointments', {
      token: receptionSJ,
      body: {
        patientId: sjPatientId,
        professionalId: cartagoProf.professionalId,
        serviceId: sjProf.serviceId,
        start,
      },
    })).status,
    404,
  );

  // 3) Paciente y profesional de San José + servicio de Bogotá -> 404.
  assert.equal(
    (await api('POST', '/appointments', {
      token: receptionSJ,
      body: {
        patientId: sjPatientId,
        professionalId: sjProf.professionalId,
        serviceId: bogotaProf.serviceId,
        start,
      },
    })).status,
    404,
  );

  // Atacar la cita de Cartago desde San José:
  // 4) Cancelar cita de Cartago con token de San José -> 404.
  assert.equal(
    (await api('POST', `/appointments/${cartagoApptId}/cancel`, {
      token: receptionSJ,
      body: { reason: 'Intento de sabotaje desde otra clínica' },
    })).status,
    404,
  );

  // 5) Registrar desenlace de cita de Cartago con token de San José -> 404.
  assert.equal(
    (await api('POST', `/appointments/${cartagoApptId}/outcome`, {
      token: receptionSJ,
      body: { outcome: 'atendida' },
    })).status,
    404,
  );

  // 6) Reprogramar cita de Cartago con token de San José -> 404.
  assert.equal(
    (await api('POST', `/appointments/${cartagoApptId}/reschedule`, {
      token: receptionSJ,
      body: { start },
    })).status,
    404,
  );

  // Verificar en la base que la cita de Cartago sigue intacta y reservada.
  assert.equal(await appointmentStatus(db, cartagoApptId), 'reservada');
});

test('I5: inyectar clinicId o clinic_id en el body o en los query params se rechaza con 400', async () => {
  const day = await freeDay(db, [sjProf.professionalId]);
  const start = await localInstant(db, sjClinicId, day, '09:00');

  // En query params de disponibilidad (RF7 y RF8).
  assert.equal(
    (await api(
      'GET',
      `/availability/professionals/${sjProf.professionalId}?serviceId=${sjProf.serviceId}&date=${day}&clinicId=${cartagoClinicId}`,
      { token: receptionSJ },
    )).status,
    400,
  );
  assert.equal(
    (await api(
      'GET',
      `/availability/services/${sjProf.serviceId}?from=${day}&to=${day}&clinic_id=${cartagoClinicId}`,
      { token: receptionSJ },
    )).status,
    400,
  );

  // En el body de POST /appointments, cancel, outcome y reschedule.
  assert.equal(
    (await api('POST', '/appointments', {
      token: receptionSJ,
      body: {
        clinicId: cartagoClinicId,
        patientId: sjPatientId,
        professionalId: sjProf.professionalId,
        serviceId: sjProf.serviceId,
        start,
      },
    })).status,
    400,
  );
  assert.equal(
    (await api('POST', `/appointments/${cartagoApptId}/cancel`, {
      token: receptionSJ,
      body: { reason: 'Con clinicId infiltrado', clinicId: cartagoClinicId },
    })).status,
    400,
  );
  assert.equal(
    (await api('POST', `/appointments/${cartagoApptId}/outcome`, {
      token: receptionSJ,
      body: { outcome: 'atendida', clinic_id: cartagoClinicId },
    })).status,
    400,
  );
});

test('I5: las llaves foráneas compuestas (clinic_id, ...) en PostgreSQL rechazan con 23503 cualquier referencia entre clínicas distintas', async () => {
  const client = await db.connect();

  async function expectFkViolation(sql, params) {
    await client.query('SAVEPOINT fk_check');
    try {
      await assert.rejects(client.query(sql, params), { code: '23503' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT fk_check');
    }
  }

  try {
    await client.query('BEGIN');

    // 1. Contacto en San José apuntando a un paciente de Cartago.
    await expectFkViolation(
      `INSERT INTO patient_contacts (clinic_id, patient_id, contact_type_id, contact_value, updated_by)
       VALUES ($1, $2, 1, '+506 8888 0000', 2)`,
      [sjClinicId, cartagoPatientId],
    );

    // 2. Bloque de horario en San José apuntando a un profesional de Cartago.
    await expectFkViolation(
      `INSERT INTO professional_schedules (clinic_id, professional_id, period, updated_by)
       VALUES ($1, $2, tstzrange('2035-01-01 08:00+00', '2035-01-01 12:00+00'), 2)`,
      [sjClinicId, cartagoProf.professionalId],
    );

    // 3. Bloqueo de agenda en San José apuntando a un profesional de Bogotá.
    await expectFkViolation(
      `INSERT INTO blockades (clinic_id, professional_id, period, reason, updated_by)
       VALUES ($1, $2, tstzrange('2035-01-01 08:00+00', '2035-01-01 10:00+00'), 'Cruce', 2)`,
      [sjClinicId, bogotaProf.professionalId],
    );

    // 4. Asignación de servicio en San José con servicio de Cartago.
    await expectFkViolation(
      `INSERT INTO services_per_professionals (clinic_id, professional_id, service_id, updated_by)
       VALUES ($1, $2, $3, 2)`,
      [sjClinicId, sjProf.professionalId, cartagoProf.serviceId],
    );

    // 5. Entrada de bitácora en San José apuntando a un paciente de Cartago.
    await expectFkViolation(
      `INSERT INTO audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description)
       VALUES ($1, 2, 1, 2, 1, $2, 'Intento de bitácora cruzada')`,
      [sjClinicId, cartagoPatientId],
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
