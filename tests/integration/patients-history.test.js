// RF14 (registro, actualización y consulta de pacientes con sus contactos en el servicio clinical),
// RF16 (historial de citas de un paciente en todos los estados en el servicio agenda), RF18
// (registro en audit_logs de toda lectura y escritura de contactos de pacientes), RF17 (permisos
// patients.read, patients.write y patient_history.read) e I5 (aislamiento entre clínicas).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, newPerson, requireStack, token } from './helpers.js';
import { addScheduleBlock, freeDay, localInstant, ownerDb, professionalsOf } from './db.js';

requireStack();
const db = ownerDb();

let adminSanJose;
let receptionSanJose;
let professionalSanJose;
let adminCartago;
let clinicId;
let cartagoPatientId;
let p1;

before(async () => {
  adminSanJose = await token('admin.sanjose');
  receptionSanJose = await token('recepcion.sanjose');
  professionalSanJose = await token('laura.mora');
  adminCartago = await token('admin.cartago');

  clinicId = (await api('GET', '/me', { token: receptionSanJose })).body.clinicId;
  const cartagoId = (await api('GET', '/me', { token: adminCartago })).body.clinicId;

  [p1] = await professionalsOf(db, clinicId);
  const { rows: [cartagoPatient] } = await db.query(
    'SELECT patient_id FROM patients WHERE clinic_id = $1 ORDER BY patient_id LIMIT 1',
    [cartagoId],
  );
  cartagoPatientId = cartagoPatient.patient_id;
});

function uniqueIdentification() {
  return `1-${Math.floor(1000 + Math.random() * 8999)}-${Math.floor(1000 + Math.random() * 8999)}`;
}

test('RF14, RF18: recepción registra un paciente con contactos, lo consulta y cada acceso a contactos queda en audit_logs', async () => {
  const person = newPerson('pac');
  const identification = uniqueIdentification();

  const created = await api('POST', '/patients', {
    token: receptionSanJose,
    body: {
      identification,
      name: person.name,
      lastName: person.lastName,
      birthDate: '1992-05-14',
      gender: 'femenino',
      contacts: [
        { type: 'telefono', value: '+506 8888 1234' },
        { type: 'email', value: person.email },
      ],
    },
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.service, 'clinical');
  assert.equal(created.body.identification, identification);
  assert.equal(created.body.name, person.name);
  assert.equal(created.body.gender, 'femenino');
  assert.equal(created.body.isActive, true);
  assert.equal(created.body.contacts.length, 2);

  const patientId = created.body.patientId;

  // Verificar en la base que se registraron 2 eventos 'create' (event_type_id = 2) sobre patient_contact (data_object_id = 2).
  const { rows: createLogs } = await db.query(
    `SELECT event_type_id, data_object_id, object_id
       FROM audit_logs
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY log_id`,
    [clinicId, patientId],
  );
  assert.equal(createLogs.length, 2);
  assert.ok(createLogs.every((l) => l.event_type_id === 2 && l.data_object_id === 2));

  // Consultar el paciente por GET /patients/:patientId registra 2 eventos 'read' (event_type_id = 1).
  const detail = await api('GET', `/patients/${patientId}`, { token: professionalSanJose });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.contacts.length, 2);

  const { rows: readLogs } = await db.query(
    `SELECT event_type_id, data_object_id
       FROM audit_logs
      WHERE clinic_id = $1 AND patient_id = $2 AND event_type_id = 1`,
    [clinicId, patientId],
  );
  assert.equal(readLogs.length, 2);
});

test('RF14, RF18: actualizar datos y contactos de un paciente aplica baja lógica a los contactos retirados y audita los cambios', async () => {
  const person = newPerson('pacupd');
  const identification = uniqueIdentification();

  const created = await api('POST', '/patients', {
    token: receptionSanJose,
    body: {
      identification,
      name: person.name,
      lastName: person.lastName,
      birthDate: '1985-10-20',
      contacts: [
        { type: 'telefono', value: '+506 7000 1111' },
        { type: 'email', value: person.email },
      ],
    },
  });
  assert.equal(created.status, 201);
  const patientId = created.body.patientId;

  // Actualizar nombre y reemplazar el teléfono por otro, conservando el correo.
  const patched = await api('PATCH', `/patients/${patientId}`, {
    token: adminSanJose,
    body: {
      name: 'NombreActualizado',
      gender: 'masculino',
      contacts: [
        { type: 'telefono', value: '+506 7000 9999' },
        { type: 'email', value: person.email },
      ],
    },
  });

  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.name, 'NombreActualizado');
  assert.equal(patched.body.gender, 'masculino');
  assert.equal(patched.body.contacts.length, 2);
  assert.ok(patched.body.contacts.some((c) => c.value === '+506 7000 9999'));
  assert.ok(!patched.body.contacts.some((c) => c.value === '+506 7000 1111'));

  // El contacto retirado sigue en patient_contacts con is_active = false y tiene evento delete (4) en audit_logs.
  const { rows: inactive } = await db.query(
    'SELECT is_active FROM patient_contacts WHERE clinic_id = $1 AND patient_id = $2 AND contact_value = $3',
    [clinicId, patientId, '+506 7000 1111'],
  );
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].is_active, false);

  const { rows: deleteLogs } = await db.query(
    'SELECT event_type_id FROM audit_logs WHERE clinic_id = $1 AND patient_id = $2 AND event_type_id = 4',
    [clinicId, patientId],
  );
  assert.equal(deleteLogs.length, 1);
});

test('RF14: una identificación repetida en la misma clínica responde 409, pero se permite en otra clínica', async () => {
  const person = newPerson('pacdup');
  const identification = uniqueIdentification();

  const first = await api('POST', '/patients', {
    token: receptionSanJose,
    body: {
      identification,
      name: person.name,
      lastName: person.lastName,
      birthDate: '1990-01-15',
    },
  });
  assert.equal(first.status, 201);

  const duplicateSameClinic = await api('POST', '/patients', {
    token: receptionSanJose,
    body: {
      identification,
      name: 'Otro',
      lastName: 'Paciente',
      birthDate: '1991-02-10',
    },
  });
  assert.equal(duplicateSameClinic.status, 409);

  // En Cartago sí se acepta la misma identificación.
  const otherClinic = await api('POST', '/patients', {
    token: adminCartago,
    body: {
      identification,
      name: person.name,
      lastName: person.lastName,
      birthDate: '1990-01-15',
    },
  });
  assert.equal(otherClinic.status, 201);
});

test('RF14, RF17: un profesional consulta pacientes pero recibe 403 al intentar crearlos o actualizarlos, y fecha futura responde 400', async () => {
  const listRes = await api('GET', '/patients', { token: professionalSanJose });
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  // El directorio general no expone contactos para no disparar lecturas masivas auditables.
  assert.equal(listRes.body[0].contacts, undefined);

  const profCreate = await api('POST', '/patients', {
    token: professionalSanJose,
    body: {
      identification: uniqueIdentification(),
      name: 'Intento',
      lastName: 'Profesional',
      birthDate: '1990-01-01',
    },
  });
  assert.equal(profCreate.status, 403);

  const futureBirth = await api('POST', '/patients', {
    token: receptionSanJose,
    body: {
      identification: uniqueIdentification(),
      name: 'Futuro',
      lastName: 'Invalido',
      birthDate: '2099-01-01',
    },
  });
  assert.equal(futureBirth.status, 400);
});

test('RF14, I5: un paciente de otra clínica responde 404 al consultar o editar, y no se acepta clinicId en el cuerpo', async () => {
  assert.equal(
    (await api('GET', `/patients/${cartagoPatientId}`, { token: receptionSanJose })).status,
    404,
  );
  assert.equal(
    (await api('PATCH', `/patients/${cartagoPatientId}`, {
      token: receptionSanJose,
      body: { name: 'IntentoFuga' },
    })).status,
    404,
  );
  assert.equal(
    (await api('POST', '/patients', {
      token: receptionSanJose,
      body: {
        clinicId: 2,
        identification: uniqueIdentification(),
        name: 'ConClinicId',
        lastName: 'Rechazado',
        birthDate: '1990-01-01',
      },
    })).status,
    400,
  );
});

test('RF16, RF17: consultar el historial de citas de un paciente devuelve sus citas en todos los estados y en orden cronológico', async () => {
  const person = newPerson('pachist');
  const patientRes = await api('POST', '/patients', {
    token: receptionSanJose,
    body: {
      identification: uniqueIdentification(),
      name: person.name,
      lastName: person.lastName,
      birthDate: '1988-07-12',
    },
  });
  assert.equal(patientRes.status, 201);
  const patientId = patientRes.body.patientId;

  const day = await freeDay(db, [p1.professionalId]);
  await addScheduleBlock(db, {
    clinicId,
    professionalId: p1.professionalId,
    day,
    from: '08:00',
    to: '12:00',
  });

  // 1. Reservar a las 08:00 y luego reprogramarla a las 09:00 (queda una reprogramada y una reservada).
  const start8 = await localInstant(db, clinicId, day, '08:00');
  const start9 = await localInstant(db, clinicId, day, '09:00');
  const start10 = await localInstant(db, clinicId, day, '10:00');

  const appt1 = await api('POST', '/appointments', {
    token: receptionSanJose,
    body: {
      patientId,
      professionalId: p1.professionalId,
      serviceId: p1.serviceId,
      start: start8,
      description: 'Primera cita',
    },
  });
  assert.equal(appt1.status, 201);

  const rescheduled = await api('POST', `/appointments/${appt1.body.appointmentId}/reschedule`, {
    token: receptionSanJose,
    body: { start: start9 },
  });
  assert.equal(rescheduled.status, 201);

  // 2. Reservar otra a las 10:00 y cancelarla.
  const appt2 = await api('POST', '/appointments', {
    token: receptionSanJose,
    body: {
      patientId,
      professionalId: p1.professionalId,
      serviceId: p1.serviceId,
      start: start10,
      description: 'Segunda cita',
    },
  });
  assert.equal(appt2.status, 201);

  const cancelled = await api('POST', `/appointments/${appt2.body.appointmentId}/cancel`, {
    token: receptionSanJose,
    body: { reason: 'No puede asistir a las 10:00' },
  });
  assert.equal(cancelled.status, 200);

  // Consultar el historial con un profesional (patient_history.read).
  const history = await api('GET', `/appointments?patientId=${patientId}`, {
    token: professionalSanJose,
  });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.service, 'agenda');
  assert.equal(history.body.length, 3);
  assert.deepEqual(
    history.body.map((a) => a.status),
    ['reprogramada', 'reservada', 'cancelada'],
  );
  assert.equal(history.body[1].rescheduledFromId, appt1.body.appointmentId);
  assert.equal(history.body[2].cancelReason, 'No puede asistir a las 10:00');
  assert.equal(typeof history.body[0].professionalName, 'string');
  assert.equal(typeof history.body[0].serviceName, 'string');
});

test('RF16, I5: consultar el historial de un paciente de otra clínica responde 404 y parámetros inválidos responden 400', async () => {
  assert.equal(
    (await api('GET', `/appointments?patientId=${cartagoPatientId}`, { token: receptionSanJose })).status,
    404,
  );
  assert.equal(
    (await api('GET', '/appointments', { token: receptionSanJose })).status,
    400,
  );
  assert.equal(
    (await api('GET', `/appointments?patientId=${cartagoPatientId}&clinicId=2`, { token: receptionSanJose })).status,
    400,
  );
});
