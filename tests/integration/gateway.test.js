// El gateway reparte cada prefijo al servicio que le toca (gateway/nginx.conf). Quién contestó se
// sabe por el header X-MediCitas-Service, que agrega cada servicio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack } from './helpers.js';

requireStack();

const ROUTES = {
  admin: ['/health', '/me', '/clinics', '/users', '/users/1', '/services', '/professionals'],
  agenda: ['/schedules', '/blockades', '/availability', '/appointments', '/appointments/1', '/agenda', '/reports'],
  clinical: ['/patients', '/patients/1', '/clinical-notes', '/audit'],
};

for (const [service, paths] of Object.entries(ROUTES)) {
  test(`Gateway: ${paths.join(', ')} llegan a ${service}`, async () => {
    for (const path of paths) {
      const { service: answeredBy } = await api('GET', path);
      assert.equal(answeredBy, service, `${path} lo contestó ${answeredBy ?? 'el gateway'}`);
    }
  });
}

test('Gateway: un prefijo desconocido responde 404 en JSON, desde el propio gateway', async () => {
  for (const path of ['/no-existe', '/usersx', '/']) {
    const res = await api('GET', path);
    assert.equal(res.status, 404, path);
    assert.equal(res.service, null, `${path} no debió llegar a un servicio`);
    assert.deepEqual(res.body, { error: 'Ruta no encontrada' });
  }
});

test('Gateway: /health responde 200 con la base arriba', async () => {
  const res = await api('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', db: 'up' });
});
