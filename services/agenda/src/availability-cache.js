import { redis } from './redis.js';
import { versionKey } from './agenda-version.js';
import { freeGaps, gapsKey } from './availability.js';

// Caché de disponibilidad (RF7, RF8), invariante I8: la caché nunca contradice a la base.
//
// Se guardan los huecos libres de cada (profesional, día) bajo la versión vigente de esa agenda:
//   ver:{clínica}:{profesional}:{fecha}         versión vigente; la sube bumpAgendaVersion después de cada COMMIT
//   disp:{clínica}:{profesional}:{fecha}:v{n}   huecos de ese día calculados con la versión n; vence en 60 s
// La clínica va en las dos claves, así que la caché nunca mezcla datos de dos clínicas (I5).
//
// Una consulta sigue tres pasos, en este orden:
//   1. readCachedGaps: lee de Redis las versiones vigentes y las copias de esas versiones. Antes de tocar la base.
//   2. computeGaps: dentro de una transacción, calcula en la base solo los pares que faltaron.
//   3. storeGaps: después del COMMIT, guarda lo calculado con la versión leída en el paso 1.
// El orden es lo que garantiza I8. Si una consulta lee la base justo antes de que se confirme una reserva, la
// versión que leyó en el paso 1 es la anterior, así que guarda el dato viejo con el número viejo; la reserva sube el
// número después de su COMMIT y nadie vuelve a leer esa copia. La copia vieja no se borra: vence sola.
//
// Si Redis no está disponible, todo se calcula en la base y no se guarda nada ('off'): más lento, pero correcto.

// Cuánto dura una copia. En el funcionamiento normal la invalidación es inmediata, por versión, y no depende de este
// vencimiento. Solo importa si una reserva se confirmó pero no se pudo subir su versión (Redis no respondió en ese
// instante): entonces la copia vieja deja de leerse, a más tardar, cuando vence. Además libera la memoria de las
// copias de versiones viejas, y es lo único que Redis puede expulsar con volatile-lru: las versiones no vencen.
export const COPY_TTL_SECONDS = 60;

export const copyKey = (clinicId, professionalId, day, version) => `disp:${clinicId}:${professionalId}:${day}:v${version}`;

// pairs: [{ professionalId, day }]. Devuelve:
//   status: 'hit' (estaban todas), 'miss' (faltó alguna) u 'off' (Redis no disponible);
//   found: gapsKey → huecos leídos de Redis; missing: los pares que faltan; versions: gapsKey → versión leída.
export async function readCachedGaps(clinicId, pairs) {
  const offline = { status: 'off', found: new Map(), missing: pairs, versions: new Map() };
  if (!redis.isReady) return offline;
  if (pairs.length === 0) return { status: 'hit', found: new Map(), missing: [], versions: new Map() };

  try {
    const keys = pairs.map(({ professionalId, day }) => gapsKey(professionalId, day));
    const current = await redis.mGet(pairs.map(({ professionalId, day }) => versionKey(clinicId, professionalId, day)));
    const versions = new Map(keys.map((key, i) => [key, Number(current[i] ?? 0)]));

    const copies = await redis.mGet(pairs.map(({ professionalId, day }, i) =>
      copyKey(clinicId, professionalId, day, versions.get(keys[i]))));

    const found = new Map();
    const missing = [];
    pairs.forEach((pair, i) => {
      if (copies[i] === null) missing.push(pair);
      else found.set(keys[i], JSON.parse(copies[i]));
    });
    return { status: missing.length === 0 ? 'hit' : 'miss', found, missing, versions };
  } catch (err) {
    console.error('Redis: no se pudo leer la caché de disponibilidad:', err.message);
    return offline;
  }
}

// Calcula en la base los huecos de los pares que faltaron, dentro de una transacción ya abierta. Devuelve un Map
// gapsKey → huecos para cada uno de esos pares; un día sin huecos queda como [] y también se guarda, para que la
// siguiente consulta no vuelva a la base por un día sin horario.
export async function computeGaps(client, clinicId, missing) {
  const computed = new Map(missing.map(({ professionalId, day }) => [gapsKey(professionalId, day), []]));
  if (missing.length === 0) return computed;

  const days = missing.map(({ day }) => day).sort();
  const gaps = await freeGaps(client, {
    clinicId,
    professionalIds: [...new Set(missing.map(({ professionalId }) => professionalId))],
    firstDay: days[0],
    lastDay: days.at(-1),
  });
  for (const key of computed.keys()) computed.set(key, gaps.get(key) ?? []);
  return computed;
}

// Guarda en Redis lo calculado, con la versión leída antes de consultar la base. Se llama después del COMMIT. Si
// Redis no estaba disponible al leer (no hay versión) no guarda nada, y si falla al guardar solo lo registra: la
// respuesta ya está calculada desde la base.
export async function storeGaps(clinicId, cached, computed) {
  const toStore = cached.missing.filter(({ professionalId, day }) => cached.versions.has(gapsKey(professionalId, day)));
  if (toStore.length === 0 || !redis.isReady) return;
  try {
    const multi = redis.multi();
    for (const { professionalId, day } of toStore) {
      const key = gapsKey(professionalId, day);
      multi.setEx(copyKey(clinicId, professionalId, day, cached.versions.get(key)), COPY_TTL_SECONDS,
        JSON.stringify(computed.get(key)));
    }
    await multi.exec();
  } catch (err) {
    console.error('Redis: no se pudo guardar la caché de disponibilidad:', err.message);
  }
}

// Los huecos de un par: los leídos de Redis o los recién calculados.
export function gapsOf(cached, computed, professionalId, day) {
  const key = gapsKey(professionalId, day);
  return cached.found.get(key) ?? computed.get(key) ?? [];
}
