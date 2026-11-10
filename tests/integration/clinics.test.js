// RF1: alta de una clínica junto con su primer administrador (en la base y en Keycloak).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, newPerson, requestToken, requireStack, token, unique } from './helpers.js';

requireStack();

let platform;
before(async () => {
  platform = await token('plataforma');
});

const newClinic = (admin = newPerson('admin.')) => ({
  clinicCode: unique('clinica'),
  clinicName: 'Clínica de prueba',
  timeZone: 'America/Costa_Rica',
  admin,
});

test('RF1: la plataforma da de alta una clínica, y su administrador inicia sesión en ella', async () => {
  const body = newClinic();
  const res = await api('POST', '/clinics', { token: platform, body });
  assert.equal(res.status, 201);
  assert.equal(res.body.clinicCode, body.clinicCode);
  assert.equal(res.body.clinicName, 'Clínica de prueba');
  assert.equal(res.body.admin.role, 'clinic_admin');

  const me = await api('GET', '/me', { token: await token(body.admin.username, body.admin.password) });
  assert.equal(me.status, 200);
  assert.equal(me.body.clinicId, res.body.clinicId);
  assert.equal(me.body.role, 'clinic_admin');
});

test('RF1: un código de clínica repetido responde 409', async () => {
  const first = newClinic();
  assert.equal((await api('POST', '/clinics', { token: platform, body: first })).status, 201);
  const again = { ...newClinic(), clinicCode: first.clinicCode };
  assert.equal((await api('POST', '/clinics', { token: platform, body: again })).status, 409);
});

test('RF1: una zona horaria que no es un nombre IANA responde 400', async () => {
  const res = await api('POST', '/clinics', { token: platform, body: { ...newClinic(), timeZone: 'Marte/Olympus' } });
  assert.equal(res.status, 400);
});

test('RF1: un usuario que ya existe en Keycloak responde 409 y no deja la clínica creada', async () => {
  const body = newClinic({ ...newPerson('admin.'), username: 'admin.sanjose' });
  assert.equal((await api('POST', '/clinics', { token: platform, body })).status, 409);
  // El código quedó libre: la misma clínica con otro administrador sí se crea.
  const retry = await api('POST', '/clinics', { token: platform, body: { ...body, admin: newPerson('admin.') } });
  assert.equal(retry.status, 201);
});

test('RF1: dos altas simultáneas con el mismo código: una se concede y la otra no deja usuario en Keycloak', async () => {
  const clinicCode = unique('carrera');
  const admins = [newPerson('carrera.'), newPerson('carrera.')];
  const results = await Promise.all(admins.map((admin) =>
    api('POST', '/clinics', { token: platform, body: { ...newClinic(admin), clinicCode } })));

  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const loser = admins[results.findIndex((r) => r.status === 409)];
  // Si la base rechazó el alta después de crear el usuario en Keycloak, ese usuario se borró.
  assert.notEqual((await requestToken(loser.username, loser.password)).status, 200);
});

test('RF1, RF17: solo la plataforma da de alta clínicas', async () => {
  for (const username of ['admin.sanjose', 'recepcion.sanjose']) {
    const res = await api('POST', '/clinics', { token: await token(username), body: newClinic() });
    assert.equal(res.status, 403, username);
  }
});

test('RF1: un body con un campo que la ruta no espera responde 400', async () => {
  const res = await api('POST', '/clinics', { token: platform, body: { ...newClinic(), extra: 1 } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.details));
});
