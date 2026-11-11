import { createClient } from 'redis';

// Versión de la agenda de cada profesional por día, en Redis (caché de RF7, invariante I8).
//
// La caché de disponibilidad guarda los huecos libres de un profesional en un día bajo una clave que incluye
// la versión vigente de esa agenda (ver "Caché de RF7" en docs/diseno-servicios.md). Cuando la agenda cambia,
// se sube la versión: las copias guardadas con la versión anterior dejan de leerse, aunque sigan en Redis.
//
// Clave: ver:{clínica}:{profesional}:{fecha}, con la fecha local de la clínica (YYYY-MM-DD). No vence.

const client = createClient({
  url: process.env.REDIS_URL,
  // Sin conexión, un comando falla enseguida en vez de quedar en cola esperando a Redis.
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 1000,
    reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
  },
});

// Sin este manejador, un error de conexión tumbaría el proceso.
client.on('error', (err) => console.error('Redis:', err.message));

// Se conecta al arrancar; si Redis no está, sigue reintentando por su cuenta (reconnectStrategy).
client.connect().catch((err) => console.error('Redis: no se pudo conectar al arrancar:', err.message));

export const versionKey = (clinicId, professionalId, day) => `ver:${clinicId}:${professionalId}:${day}`;

// Sube la versión de la agenda de un profesional para cada día entre firstDay y lastDay, inclusive. Las fechas
// son 'YYYY-MM-DD' en la hora local de la clínica; en SQL salen de un periodo así:
//   (lower(period) AT TIME ZONE c.time_zone)::date
//   ((upper(period) - interval '1 microsecond') AT TIME ZONE c.time_zone)::date
//
// La llama toda ruta que cambia una agenda: reservar, cancelar, reprogramar, registrar el desenlace, y crear,
// cambiar o borrar horarios y bloqueos. Siempre DESPUÉS de que withTransaction termine (el COMMIT) y antes de
// responder; nunca dentro de withTransaction, porque un reintento por deadlock la ejecutaría dos veces.
//
// Si Redis no responde, el cambio ya está confirmado en la base, que es la fuente de verdad: se registra el
// error y la petición sigue. Qué pasa entonces con las copias viejas lo resuelve la etapa de la caché.
export async function bumpAgendaVersion({ clinicId, professionalId, firstDay, lastDay = firstDay }) {
  const keys = daysBetween(firstDay, lastDay).map((day) => versionKey(clinicId, professionalId, day));
  if (!client.isReady) {
    console.error(`Redis no disponible: no se subió la versión de ${keys.join(', ')}`);
    return;
  }
  try {
    const multi = client.multi();
    for (const key of keys) multi.incr(key);
    await multi.exec();
  } catch (err) {
    console.error(`No se pudo subir la versión de ${keys.join(', ')}:`, err.message);
  }
}

// Cierra la conexión al apagar el servicio (server.js).
export async function closeAgendaVersion() {
  if (client.isOpen) await client.close();
}

// Días 'YYYY-MM-DD' entre dos fechas, inclusive. Se cuentan en UTC solo para avanzar de a un día: las fechas
// ya vienen en la hora local de la clínica. También la usa RF8 para recorrer su rango (routes/availability.js).
export function daysBetween(firstDay, lastDay) {
  const days = [];
  const last = Date.parse(`${lastDay}T00:00:00Z`);
  for (let t = Date.parse(`${firstDay}T00:00:00Z`); t <= last && days.length < 366; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
