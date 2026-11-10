// RF2: gestión de usuarios de la clínica (alta, cambio de rol, baja lógica), e I5: ninguna ruta de
// usuarios deja ver ni tocar los de otra clínica. Las pruebas solo modifican usuarios que ellas mismas
// crean; los usuarios del seed no cambian.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, newPerson, requestToken, requireStack, token } from './helpers.js';

requireStack();

let adminSanJose;       // token
let adminSanJoseMe;     // su identidad (/me)
let adminCartagoMe;

before(async () => {
  adminSanJose = await token('admin.sanjose');
  adminSanJoseMe = (await api('GET', '/me', { token: adminSanJose })).body;
  adminCartagoMe = (await api('GET', '/me', { token: await token('admin.cartago') })).body;
});

// Crea un usuario de recepción en San José y devuelve sus datos, su id y su token.
async function createReceptionist() {
  const person = newPerson('rec.');
  const res = await api('POST', '/users', { token: adminSanJose, body: { ...person, role: 'reception' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...person, userId: res.body.userId, token: await token(person.username, person.password) };
}

test('RF2: alta de un usuario de recepción, que inicia sesión con su rol en la clínica de quien lo creó', async () => {
  const user = await createReceptionist();
  const me = await api('GET', '/me', { token: user.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'reception');
  assert.equal(me.body.clinicId, adminSanJoseMe.clinicId);
});

test('RF2: cambio de rol: el token viejo deja de servir y el nuevo trae el rol nuevo', async () => {
  const user = await createReceptionist();
  const res = await api('PATCH', `/users/${user.userId}`, { token: adminSanJose, body: { role: 'clinic_admin' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'clinic_admin');

  assert.equal((await api('GET', '/me', { token: user.token })).status, 403);
  const fresh = await api('GET', '/me', { token: await token(user.username, user.password) });
  assert.equal(fresh.body.role, 'clinic_admin');
});

test('RF2: baja lógica: el usuario ya no obtiene token y el que tenía deja de servir', async () => {
  const user = await createReceptionist();
  const res = await api('PATCH', `/users/${user.userId}`, { token: adminSanJose, body: { isActive: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.isActive, false);

  assert.notEqual((await requestToken(user.username, user.password)).status, 200);
  assert.equal((await api('GET', '/me', { token: user.token })).status, 403);
});

test('RF2: un administrador no puede darse de baja ni cambiarse el rol a sí mismo', async () => {
  const res = await api('PATCH', `/users/${adminSanJoseMe.userId}`, { token: adminSanJose, body: { isActive: false } });
  assert.equal(res.status, 409);
});

test('RF2: el rol de un profesional no se cambia por /users', async () => {
  const users = (await api('GET', '/users', { token: adminSanJose })).body;
  const professional = users.find((u) => u.role === 'professional');
  assert.ok(professional, 'el seed debería tener profesionales en San José');
  const res = await api('PATCH', `/users/${professional.userId}`, { token: adminSanJose, body: { role: 'reception' } });
  assert.equal(res.status, 409);
});

test('RF2: el alta no acepta los roles professional ni platform_admin', async () => {
  for (const role of ['professional', 'platform_admin']) {
    const res = await api('POST', '/users', { token: adminSanJose, body: { ...newPerson('rol.'), role } });
    assert.equal(res.status, 400, role);
  }
});

test('RF2, RF17: recepción no gestiona usuarios', async () => {
  const res = await api('GET', '/users', { token: await token('recepcion.sanjose') });
  assert.equal(res.status, 403);
});

test('I5: el listado de usuarios solo trae los de la clínica del token', async () => {
  const ids = (await api('GET', '/users', { token: adminSanJose })).body.map((u) => u.userId);
  assert.ok(ids.includes(adminSanJoseMe.userId));
  assert.ok(!ids.includes(adminCartagoMe.userId), 'apareció un usuario de Cartago en el listado de San José');
});

test('I5: un usuario de otra clínica responde 404, igual que uno inexistente, y no se modifica', async () => {
  const other = `/users/${adminCartagoMe.userId}`;
  assert.equal((await api('GET', other, { token: adminSanJose })).status, 404);
  assert.equal((await api('GET', '/users/2147483647', { token: adminSanJose })).status, 404);
  assert.equal((await api('PATCH', other, { token: adminSanJose, body: { isActive: false } })).status, 404);
  // El administrador de Cartago sigue activo.
  assert.equal((await api('GET', '/me', { token: await token('admin.cartago') })).status, 200);
});

test('I5: un clinicId en el body se rechaza con 400', async () => {
  const user = await createReceptionist();
  const res = await api('PATCH', `/users/${user.userId}`, {
    token: adminSanJose,
    body: { isActive: false, clinicId: adminCartagoMe.clinicId },
  });
  assert.equal(res.status, 400);
});

test('RF2: un id de usuario que no es un número responde 400', async () => {
  assert.equal((await api('GET', '/users/abc', { token: adminSanJose })).status, 400);
});
