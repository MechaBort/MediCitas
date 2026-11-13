// Pruebas unitarias de packages/common/src/errors.js: no necesitan la pila.
// Los objetos de error imitan lo que entrega node-postgres (code, constraint, message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { HttpError, parse, toResponse } from '../src/errors.js';

const pgError = (code, extra = {}) => Object.assign(new Error('mensaje interno de la base'), { code, ...extra });

test('I3: MC001 (fuera del horario o dentro de un bloqueo) → 400', () => {
  assert.equal(toResponse(pgError('MC001')).status, 400);
});

test('RF13: MC002 (cambiar una cita en estado final) → 409', () => {
  assert.equal(toResponse(pgError('MC002')).status, 409);
});

test('RF12: MC003 (desenlace antes de la hora de inicio) → 409', () => {
  assert.equal(toResponse(pgError('MC003')).status, 409);
});

test('I3: MC006 (borrar un bloque de horario con citas) → 409', () => {
  assert.equal(toResponse(pgError('MC006')).status, 409);
});

test('I4, I6: MC004 y MC005 son inalcanzables desde la API → 500', () => {
  assert.equal(toResponse(pgError('MC004')).status, 500);
  assert.equal(toResponse(pgError('MC005')).status, 500);
});

test('I1, I2: el 23P01 se distingue por la restricción que falló', () => {
  const professional = toResponse(pgError('23P01', { constraint: 'ex_appointments_professional' }));
  const patient = toResponse(pgError('23P01', { constraint: 'ex_appointments_patient' }));
  assert.equal(professional.status, 409);
  assert.equal(patient.status, 409);
  assert.notEqual(professional.body.error, patient.body.error);
});

test('Una restricción EXCLUDE desconocida responde el 23P01 genérico', () => {
  const generic = toResponse(pgError('23P01'));
  const unknown = toResponse(pgError('23P01', { constraint: 'ex_otra_restriccion' }));
  assert.deepEqual(unknown, generic);
  assert.equal(unknown.status, 409);
});

test('Códigos estándar de Postgres: 23505 → 409, 23514 → 400, 42501 → 403', () => {
  assert.equal(toResponse(pgError('23505')).status, 409);
  assert.equal(toResponse(pgError('23514')).status, 400);
  assert.equal(toResponse(pgError('42501')).status, 403);
});

test('Un error desconocido responde 500 sin filtrar su mensaje interno', () => {
  const { status, body } = toResponse(new Error('detalle interno: password=abc'));
  assert.equal(status, 500);
  assert.deepEqual(body, { error: 'Error interno' });
});

test('Base no disponible (failover, arranque, conexión caída) → 503 sin filtrar el mensaje interno', () => {
  const cases = [
    pgError('57P01'), // la principal se apaga
    pgError('57P02'),
    pgError('57P03'), // la base está arrancando
    pgError('25006'), // escritura en una instancia que ya no es la principal
    pgError('08006'), // connection_failure
    pgError('08P01'), // PgBouncer no alcanza la base
    pgError('ECONNREFUSED'),
    pgError('ECONNRESET'),
    new Error('Connection terminated unexpectedly'),
  ];
  for (const err of cases) {
    const { status, body } = toResponse(err);
    assert.equal(status, 503, `${err.code ?? err.message} debería dar 503`);
    assert.doesNotMatch(body.error, /mensaje interno|terminated/);
  }
});

test('Los errores de datos y los desconocidos no se confunden con "base no disponible"', () => {
  assert.equal(toResponse(pgError('23505')).status, 409);
  assert.equal(toResponse(pgError('42P01')).status, 500); // tabla inexistente: error nuestro
  assert.equal(toResponse(pgError('53300')).status, 500); // sin conexiones libres: error de configuración
  assert.equal(toResponse(new Error('Connection refused por otra cosa')).status, 500);
  // fetch (Keycloak) deja el código del socket en err.cause, no arriba: sigue siendo 500.
  assert.equal(toResponse(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })).status, 500);
});

test('Un código heredado de Object.prototype ("constructor") no encuentra nada en las tablas', () => {
  assert.equal(toResponse(pgError('constructor')).status, 500);
});

test('Un error de Express con status 4xx conserva su status y su mensaje', () => {
  const { status, body } = toResponse(Object.assign(new Error('Unexpected end of JSON input'), { status: 400 }));
  assert.equal(status, 400);
  assert.equal(body.error, 'Unexpected end of JSON input');
});

test('HttpError responde su status, su mensaje y sus detalles', () => {
  const { status, body } = toResponse(new HttpError(404, 'Usuario no encontrado', [{ field: 'userId' }]));
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'Usuario no encontrado', details: [{ field: 'userId' }] });
});

test('I5: parse rechaza con 400 un campo que el esquema no espera (por ejemplo, clinicId)', () => {
  const schema = z.object({ name: z.string() }).strict();
  assert.throws(
    () => parse(schema, { name: 'Ana', clinicId: 2 }),
    (err) => err instanceof HttpError && err.status === 400 && err.details.some((d) => d.problem.includes('clinicId')),
  );
});

test('parse devuelve los datos ya limpios', () => {
  const schema = z.object({ name: z.string().trim(), age: z.coerce.number().int() }).strict();
  assert.deepEqual(parse(schema, { name: '  Ana  ', age: '30' }), { name: 'Ana', age: 30 });
});
