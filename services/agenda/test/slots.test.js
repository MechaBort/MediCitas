// Pruebas unitarias del corte de huecos en espacios (services/agenda/src/slots.js): no necesitan la pila.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceGaps } from '../src/slots.js';

const at = (hhmm) => new Date(`2030-01-07T${hhmm}:00Z`);
const gap = (from, to) => ({ start: at(from), end: at(to) });
const starts = (slots) => slots.map((s) => s.start.toISOString().slice(11, 16));
const longAgo = at('00:00');

test('RF7: un hueco exacto se corta en espacios seguidos de la duración del servicio', () => {
  const slots = sliceGaps([gap('08:00', '10:00')], 30, longAgo);
  assert.deepEqual(starts(slots), ['08:00', '08:30', '09:00', '09:30']);
  assert.ok(slots.every((s) => s.end - s.start === 30 * 60_000));
});

test('RF7: lo que sobra al final de un hueco no alcanza para un espacio', () => {
  assert.deepEqual(starts(sliceGaps([gap('08:00', '09:40')], 45, longAgo)), ['08:00', '08:45']);
  assert.deepEqual(sliceGaps([gap('08:00', '08:20')], 30, longAgo), []);
});

test('RF7: cada hueco se corta desde su propio inicio', () => {
  const slots = sliceGaps([gap('08:00', '09:00'), gap('09:20', '10:30')], 30, longAgo);
  assert.deepEqual(starts(slots), ['08:00', '08:30', '09:20', '09:50']);
});

test('RF7, RF9: un espacio que ya empezó, o empieza justo ahora, no se devuelve', () => {
  assert.deepEqual(starts(sliceGaps([gap('08:00', '10:00')], 30, at('08:30'))), ['09:00', '09:30']);
  assert.deepEqual(starts(sliceGaps([gap('08:00', '10:00')], 30, at('08:31'))), ['09:00', '09:30']);
  assert.deepEqual(sliceGaps([gap('08:00', '10:00')], 30, at('12:00')), []);
});

test('RF7: los huecos pueden venir como texto ISO 8601 (así los guardará la caché)', () => {
  const slots = sliceGaps([{ start: '2030-01-07T08:00:00.000Z', end: '2030-01-07T09:00:00.000Z' }], 60, longAgo);
  assert.deepEqual(slots, [{ start: at('08:00'), end: at('09:00') }]);
});
