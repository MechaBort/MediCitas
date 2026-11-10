// RF17: autenticación contra Keycloak y autorización según el rol del token, en los tres servicios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';

requireStack();

test('RF17: sin token, las rutas protegidas de los tres servicios responden 401', async () => {
  for (const path of ['/me', '/users', '/appointments', '/patients']) {
    const res = await api('GET', path);
    assert.equal(res.status, 401, path);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer /, `${path} sin WWW-Authenticate`);
  }
});

test('RF17: un token con la firma alterada responde 401', async () => {
  const [header, payload, signature] = (await token('recepcion.sanjose')).split('.');
  const forged = [header, payload, [...signature].reverse().join('')].join('.');
  assert.equal((await api('GET', '/me', { token: forged })).status, 401);
});

test('RF17: con un token válido del rol adecuado responde 200 con la identidad resuelta', async () => {
  const res = await api('GET', '/me', { token: await token('admin.sanjose') });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'clinic_admin');
  assert.equal(typeof res.body.clinicId, 'number');
  assert.ok(res.body.permissions.includes('users.manage'));
});

test('RF17: con un token válido pero sin el permiso responde 403', async () => {
  const res = await api('GET', '/users', { token: await token('recepcion.sanjose') });
  assert.equal(res.status, 403);
});

test('RF17: un token válido cuyo sub no está registrado en MediCitas responde 403', async () => {
  const res = await api('GET', '/me', { token: await token('sinregistro') });
  assert.equal(res.status, 403);
});

test('RF2, RF17: un usuario dado de baja en la base responde 403 aunque Keycloak le dé token', async () => {
  const res = await api('GET', '/me', { token: await token('exrecepcion.sanjose') });
  assert.equal(res.status, 403);
});

test('RF17: un token de plataforma recibe 403 en agenda y clinical, que no atienden ese rol', async () => {
  const platform = await token('plataforma');
  for (const path of ['/appointments', '/patients']) {
    const res = await api('GET', path, { token: platform });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error, 'Este servicio no atiende a su rol');
  }
});

test('RF17: un usuario válido de la clínica pasa la identidad en agenda y clinical', async () => {
  const reception = await token('recepcion.sanjose');
  for (const path of ['/appointments', '/patients']) {
    const res = await api('GET', path, { token: reception });
    // Sin 401 ni 403: la identidad pasó. El código exacto depende de la ruta, que llega en el bloque B.
    assert.ok(![401, 403].includes(res.status), `${path} respondió ${res.status}`);
  }
});
