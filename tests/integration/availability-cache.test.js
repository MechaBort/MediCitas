// I8: la caché de disponibilidad nunca contradice a la base. RF7 y RF8 leen de Redis los huecos de cada (profesional,
// día) guardados bajo la versión vigente de esa agenda; reservar, cancelar o reprogramar sube la versión después del
// COMMIT, así que la siguiente consulta ya no encuentra la copia vieja y recalcula desde la base.
// El header X-MediCitas-Cache dice de dónde salió cada respuesta: 'hit' (Redis), 'miss' (calculada en la base y
// guardada) u 'off' (Redis no disponible). Estas pruebas exigen 'hit' y 'miss': con Redis caído fallan, a propósito.
//
// Cada prueba usa días nuevos (freeDay) y crea los horarios antes de la primera consulta: los helpers de db.js
// escriben directo en la base y no suben la versión, así que un horario agregado después de consultar no se vería
// hasta que la copia venza. En producción lo hace la ruta de RF5, que sí sube la versión.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { addScheduleBlock, freeDay, freeDays, ownerDb, patientsOf, professionalsOf } from './db.js';

requireStack();
const db = ownerDb();

let reception;      // recepcion.sanjose
let clinicId;       // San José
let p1;             // { professionalId, serviceId, duration }
let patients;
let shared;         // { serviceId, professionalIds }: un servicio que atienden dos o más profesionales

before(async () => {
  reception = await token('recepcion.sanjose');
  clinicId = (await api('GET', '/me', { token: reception })).body.clinicId;
  [p1] = await professionalsOf(db, clinicId);
  patients = await patientsOf(db, clinicId);

  // Los mismos filtros que RF8: servicio, asignación, usuario y profesional activos.
  const { rows: [row] } = await db.query(`
    SELECT spp.service_id AS "serviceId",
           array_agg(spp.professional_id ORDER BY spp.professional_id) AS "professionalIds"
      FROM services_per_professionals spp
      JOIN services s       ON s.service_id = spp.service_id AND s.is_active
      JOIN users u          ON u.user_id = spp.professional_id AND u.is_active
      JOIN professionals pr ON pr.user_id = spp.professional_id AND pr.is_active
     WHERE spp.clinic_id = $1 AND spp.is_active
     GROUP BY spp.service_id
    HAVING count(*) >= 2
     LIMIT 1`, [clinicId]);
  shared = row;
});

// RF7: devuelve { cache, slots } y exige 200.
async function rf7(professionalId, serviceId, date) {
  const res = await api('GET', `/availability/professionals/${professionalId}?${new URLSearchParams({ serviceId, date })}`,
    { token: reception });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { cache: res.headers.get('x-medicitas-cache'), slots: res.body.slots };
}

async function rf8(serviceId, from, to) {
  const res = await api('GET', `/availability/services/${serviceId}?${new URLSearchParams({ from, to })}`,
    { token: reception });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { cache: res.headers.get('x-medicitas-cache'), professionals: res.body.professionals };
}

const starts = (slots) => slots.map((s) => s.start);
const withSchedule = async (professionalId, day) =>
  addScheduleBlock(db, { clinicId, professionalId, day, from: '08:00', to: '12:00' });

async function booked(start) {
  const res = await api('POST', '/appointments', {
    token: reception,
    body: { patientId: patients[0], professionalId: p1.professionalId, serviceId: p1.serviceId, start },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('RF7, I8: la primera consulta se calcula en la base (miss) y la segunda sale de la caché (hit), igual', async () => {
  const day = await freeDay(db, [p1.professionalId]);
  await withSchedule(p1.professionalId, day);

  const first = await rf7(p1.professionalId, p1.serviceId, day);
  const second = await rf7(p1.professionalId, p1.serviceId, day);

  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.ok(first.slots.length > 0);
  assert.deepEqual(second.slots, first.slots);
});

test('RF7, RF9, I8: reservar un espacio devuelto invalida la copia: la siguiente consulta es miss y ya no lo muestra', async () => {
  const day = await freeDay(db, [p1.professionalId]);
  await withSchedule(p1.professionalId, day);
  await rf7(p1.professionalId, p1.serviceId, day);
  const cached = await rf7(p1.professionalId, p1.serviceId, day);
  assert.equal(cached.cache, 'hit');

  const chosen = cached.slots[1];
  await booked(chosen.start);

  const after = await rf7(p1.professionalId, p1.serviceId, day);
  assert.equal(after.cache, 'miss', 'la reserva debe subir la versión de la agenda de ese día');
  assert.deepEqual(starts(after.slots), starts(cached.slots).filter((s) => s !== chosen.start));
  assert.equal((await rf7(p1.professionalId, p1.serviceId, day)).cache, 'hit');
});

test('RF7, RF11, RF10, I7, I8: cancelar y reprogramar invalidan la copia, y la siguiente consulta refleja el cambio', async () => {
  const day = await freeDay(db, [p1.professionalId]);
  await withSchedule(p1.professionalId, day);
  const initial = (await rf7(p1.professionalId, p1.serviceId, day)).slots;

  // Cancelar devuelve el espacio.
  const appointment = await booked(initial[0].start);
  await rf7(p1.professionalId, p1.serviceId, day);
  assert.equal((await rf7(p1.professionalId, p1.serviceId, day)).cache, 'hit');
  const cancel = await api('POST', `/appointments/${appointment.appointmentId}/cancel`, {
    token: reception, body: { reason: 'Prueba de la caché' },
  });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const afterCancel = await rf7(p1.professionalId, p1.serviceId, day);
  assert.equal(afterCancel.cache, 'miss');
  assert.deepEqual(afterCancel.slots, initial);

  // Reprogramar libera el espacio viejo y ocupa el nuevo.
  const again = await booked(initial[0].start);
  await rf7(p1.professionalId, p1.serviceId, day);
  assert.equal((await rf7(p1.professionalId, p1.serviceId, day)).cache, 'hit');
  const reschedule = await api('POST', `/appointments/${again.appointmentId}/reschedule`, {
    token: reception, body: { start: initial[2].start },
  });
  assert.equal(reschedule.status, 201, JSON.stringify(reschedule.body));
  const afterReschedule = await rf7(p1.professionalId, p1.serviceId, day);
  assert.equal(afterReschedule.cache, 'miss');
  assert.deepEqual(starts(afterReschedule.slots), starts(initial).filter((s) => s !== initial[2].start));
});

test('RF7, RF8, I8: RF7 y RF8 comparten las copias de cada profesional y día', async () => {
  const [a, b] = shared.professionalIds;
  const ids = shared.professionalIds;

  // RF8 primero: guarda todos los pares del rango, y RF7 los encuentra.
  const days = await freeDays(db, ids, 2);
  await withSchedule(a, days[0]);
  await withSchedule(b, days[1]);
  assert.equal((await rf8(shared.serviceId, days[0], days[1])).cache, 'miss');
  assert.equal((await rf8(shared.serviceId, days[0], days[1])).cache, 'hit');
  const fromRf7 = await rf7(a, shared.serviceId, days[0]);
  assert.equal(fromRf7.cache, 'hit');
  assert.ok(fromRf7.slots.length > 0);
  assert.equal((await rf7(b, shared.serviceId, days[0])).cache, 'hit', 'un día sin horario también queda guardado');

  // RF7 primero: cuando RF7 ya calculó a todos los profesionales de ese día, RF8 sale entero de la caché.
  const [day] = await freeDays(db, ids, 1);
  for (const id of ids) await withSchedule(id, day);
  for (const id of ids) assert.equal((await rf7(id, shared.serviceId, day)).cache, 'miss');
  const fromRf8 = await rf8(shared.serviceId, day, day);
  assert.equal(fromRf8.cache, 'hit');
  assert.deepEqual(fromRf8.professionals.map((p) => p.professionalId), ids);
});
