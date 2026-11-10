// Pruebas unitarias de packages/common/src/db.js que no necesitan la base: la validación del
// rol ocurre antes de pedir una conexión.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTransaction } from '../src/db.js';

after(() => pool.end());

test('withTransaction rechaza un rol fuera de la lista antes de tocar la base', async () => {
  for (const role of ['postgres', 'mc_owner', 'mc_reception; DROP TABLE users', '']) {
    await assert.rejects(withTransaction(role, async () => {}), /Rol de base de datos no permitido/);
  }
  assert.equal(pool.totalCount, 0, 'no debió abrirse ninguna conexión');
});
