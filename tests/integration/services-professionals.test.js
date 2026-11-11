// RF3: catálogo de servicios de la clínica (nombre, duración y especialidad), RF4: registro de
// profesionales con sus especialidades y servicios habilitados, RF17: permisos, e I5: ninguna ruta
// deja ver ni usar servicios o profesionales de otra clínica. Las pruebas no modifican datos del seed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, newPerson, requestToken, requireStack, token, unique } from './helpers.js';

requireStack();

let adminSanJose;
let adminSanJoseMe;
let adminCartago;
let specialties;

before(async () => {
  adminSanJose = await token('admin.sanjose');
  adminCartago = await token('admin.cartago');
  adminSanJoseMe = (await api('GET', '/me', { token: adminSanJose })).body;

  const specRes = await api('GET', '/services/specialties', { token: adminSanJose });
  assert.equal(specRes.status, 200);
  specialties = specRes.body;
  assert.ok(specialties.length >= 2, 'el seed debe tener al menos dos especialidades');
});

async function createService(bearer = adminSanJose, overrides = {}) {
  const body = {
    serviceName: unique('Servicio '),
    durationMinutes: 35,
    specialtyId: specialties[0].specialtyId,
    ...overrides,
  };
  const res = await api('POST', '/services', { token: bearer, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function createProfessional(bearer = adminSanJose, overrides = {}) {
  const person = newPerson('prof.');
  const body = {
    ...person,
    licenseNumber: unique('MED-'),
    specialtyIds: [specialties[0].specialtyId],
    serviceIds: [],
    phone: '+506 8888 0000',
    ...overrides,
  };
  const res = await api('POST', '/professionals', { token: bearer, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return {
    ...res.body,
    password: person.password,
    token: await token(person.username, person.password),
  };
}

// --- RF3: Catálogo de servicios -----------------------------------------------------------------------------

test('RF3: alta y consulta de un servicio con nombre, duración en minutos y especialidad requerida', async () => {
  const spec = specialties[0];
  const created = await createService(adminSanJose, {
    serviceName: unique('Control '),
    durationMinutes: 45,
    specialtyId: spec.specialtyId,
  });

  assert.equal(created.durationMinutes, 45);
  assert.equal(created.specialtyId, spec.specialtyId);
  assert.equal(created.specialtyName, spec.specialtyName);
  assert.equal(created.isActive, true);

  const single = await api('GET', `/services/${created.serviceId}`, { token: adminSanJose });
  assert.equal(single.status, 200);
  assert.equal(single.body.serviceName, created.serviceName);

  const list = await api('GET', '/services', { token: adminSanJose });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((s) => s.serviceId === created.serviceId));
});

test('RF3: actualización de nombre, duración, especialidad y baja lógica de un servicio', async () => {
  const created = await createService();
  const nextSpec = specialties[1];

  const updated = await api('PATCH', `/services/${created.serviceId}`, {
    token: adminSanJose,
    body: {
      serviceName: `${created.serviceName} editado`,
      durationMinutes: 50,
      specialtyId: nextSpec.specialtyId,
      isActive: false,
    },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.durationMinutes, 50);
  assert.equal(updated.body.specialtyId, nextSpec.specialtyId);
  assert.equal(updated.body.isActive, false);
});

test('RF3: duración no positiva o especialidad inexistente se rechazan', async () => {
  for (const durationMinutes of [0, -15]) {
    const bad = await api('POST', '/services', {
      token: adminSanJose,
      body: { serviceName: unique('Inv '), durationMinutes, specialtyId: specialties[0].specialtyId },
    });
    assert.equal(bad.status, 400, `durationMinutes=${durationMinutes}`);
  }

  const missingSpec = await api('POST', '/services', {
    token: adminSanJose,
    body: { serviceName: unique('Inv '), durationMinutes: 30, specialtyId: 2147483647 },
  });
  assert.equal(missingSpec.status, 404);
});

// --- RF4: Profesionales, especialidades y servicios habilitados ---------------------------------------------

test('RF4: alta de un profesional con su especialidad y servicios habilitados; inicia sesión en su clínica', async () => {
  const svc = await createService(adminSanJose, { specialtyId: specialties[0].specialtyId });
  const prof = await createProfessional(adminSanJose, {
    specialtyIds: [specialties[0].specialtyId],
    serviceIds: [svc.serviceId],
  });

  assert.equal(prof.role, 'professional');
  assert.deepEqual(prof.specialties.map((s) => s.specialtyId), [specialties[0].specialtyId]);
  assert.deepEqual(prof.services.map((s) => s.serviceId), [svc.serviceId]);
  assert.equal(prof.contacts.length, 2);

  const me = await api('GET', '/me', { token: prof.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'professional');
  assert.equal(me.body.clinicId, adminSanJoseMe.clinicId);
});

test('RF4: asociar y actualizar los servicios habilitados y las especialidades de un profesional', async () => {
  const svc1 = await createService(adminSanJose, { specialtyId: specialties[0].specialtyId });
  const svc2 = await createService(adminSanJose, { specialtyId: specialties[1].specialtyId });
  const prof = await createProfessional(adminSanJose, {
    specialtyIds: [specialties[0].specialtyId, specialties[1].specialtyId],
    serviceIds: [svc1.serviceId],
  });

  const putRes = await api('PUT', `/professionals/${prof.professionalId}/services`, {
    token: adminSanJose,
    body: { serviceIds: [svc1.serviceId, svc2.serviceId] },
  });
  assert.equal(putRes.status, 200);
  assert.deepEqual(
    putRes.body.services.map((s) => s.serviceId).sort((a, b) => a - b),
    [svc1.serviceId, svc2.serviceId].sort((a, b) => a - b),
  );

  // Dejar solo el segundo servicio y su especialidad mediante PATCH.
  const patchRes = await api('PATCH', `/professionals/${prof.professionalId}`, {
    token: adminSanJose,
    body: {
      licenseNumber: unique('MED-NUEVA-'),
      specialtyIds: [specialties[1].specialtyId],
      serviceIds: [svc2.serviceId],
    },
  });
  assert.equal(patchRes.status, 200);
  assert.deepEqual(patchRes.body.specialties.map((s) => s.specialtyId), [specialties[1].specialtyId]);
  assert.deepEqual(patchRes.body.services.map((s) => s.serviceId), [svc2.serviceId]);
});

test('RF3, RF4: no se puede asociar un servicio a un profesional que no tiene la especialidad requerida', async () => {
  const svcOtherSpec = await createService(adminSanJose, { specialtyId: specialties[1].specialtyId });
  const prof = await createProfessional(adminSanJose, {
    specialtyIds: [specialties[0].specialtyId],
  });

  const putRes = await api('PUT', `/professionals/${prof.professionalId}/services`, {
    token: adminSanJose,
    body: { serviceIds: [svcOtherSpec.serviceId] },
  });
  assert.equal(putRes.status, 400);
});

test('RF4: baja lógica de un profesional revoca su acceso en la API y en Keycloak', async () => {
  const prof = await createProfessional();
  const res = await api('PATCH', `/professionals/${prof.professionalId}`, {
    token: adminSanJose,
    body: { isActive: false },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.isActive, false);

  assert.notEqual((await requestToken(prof.username, prof.password)).status, 200);
  assert.equal((await api('GET', '/me', { token: prof.token })).status, 403);
});

// --- RF17: Permisos -----------------------------------------------------------------------------------------

test('RF3, RF4, RF17: recepción y profesionales no gestionan el catálogo de servicios ni los profesionales', async () => {
  for (const user of ['recepcion.sanjose', 'laura.mora']) {
    const bearer = await token(user);
    assert.equal((await api('GET', '/services', { token: bearer })).status, 403, `${user} en /services`);
    assert.equal((await api('GET', '/professionals', { token: bearer })).status, 403, `${user} en /professionals`);
  }
});

// --- I5: Aislamiento entre clínicas (fuga de datos) ---------------------------------------------------------

test('I5: los listados de /services y /professionals solo devuelven registros de la clínica del token', async () => {
  const cartagoService = await createService(adminCartago);
  const cartagoProf = await createProfessional(adminCartago);

  const sjServices = (await api('GET', '/services', { token: adminSanJose })).body.map((s) => s.serviceId);
  assert.ok(!sjServices.includes(cartagoService.serviceId), 'apareció un servicio de Cartago en San José');

  const sjProfs = (await api('GET', '/professionals', { token: adminSanJose })).body.map((p) => p.professionalId);
  assert.ok(!sjProfs.includes(cartagoProf.professionalId), 'apareció un profesional de Cartago en San José');
});

test('I5: un servicio o profesional de otra clínica responde 404, igual que uno inexistente, y no se modifica', async () => {
  const cartagoService = await createService(adminCartago);
  const cartagoProf = await createProfessional(adminCartago);

  assert.equal((await api('GET', `/services/${cartagoService.serviceId}`, { token: adminSanJose })).status, 404);
  assert.equal((await api('GET', '/services/2147483647', { token: adminSanJose })).status, 404);
  assert.equal((await api('PATCH', `/services/${cartagoService.serviceId}`, {
    token: adminSanJose,
    body: { isActive: false },
  })).status, 404);

  assert.equal((await api('GET', `/professionals/${cartagoProf.professionalId}`, { token: adminSanJose })).status, 404);
  assert.equal((await api('GET', '/professionals/2147483647', { token: adminSanJose })).status, 404);
  assert.equal((await api('PATCH', `/professionals/${cartagoProf.professionalId}`, {
    token: adminSanJose,
    body: { isActive: false },
  })).status, 404);

  // Tampoco se puede asociar un servicio de Cartago a un profesional de San José.
  const sjProf = await createProfessional(adminSanJose, { specialtyIds: [cartagoService.specialtyId] });
  assert.equal((await api('PUT', `/professionals/${sjProf.professionalId}/services`, {
    token: adminSanJose,
    body: { serviceIds: [cartagoService.serviceId] },
  })).status, 404);
});

test('I5: un clinicId enviado en el body de /services o /professionals se rechaza con 400', async () => {
  const badService = await api('POST', '/services', {
    token: adminSanJose,
    body: {
      serviceName: unique('Fuga '),
      durationMinutes: 30,
      specialtyId: specialties[0].specialtyId,
      clinicId: 2,
    },
  });
  assert.equal(badService.status, 400);

  const badProf = await api('POST', '/professionals', {
    token: adminSanJose,
    body: {
      ...newPerson('fuga.'),
      licenseNumber: unique('MED-'),
      specialtyIds: [specialties[0].specialtyId],
      clinicId: 2,
    },
  });
  assert.equal(badProf.status, 400);
});
