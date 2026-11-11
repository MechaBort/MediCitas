import { createClient } from 'redis';

// Conexión a Redis del servicio agenda: una sola por proceso, compartida por las versiones de agenda
// (agenda-version.js) y las copias de disponibilidad (availability-cache.js). Redis es solo una copia rápida:
// PostgreSQL sigue siendo la fuente de verdad, y si Redis no responde, todo sigue funcionando contra la base.

export const redis = createClient({
  url: process.env.REDIS_URL,
  // Sin conexión, un comando falla enseguida en vez de quedar en cola esperando a Redis.
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 1000,
    reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
  },
});

// Sin este manejador, un error de conexión tumbaría el proceso.
redis.on('error', (err) => console.error('Redis:', err.message));

// Se conecta al arrancar; si Redis no está, sigue reintentando por su cuenta (reconnectStrategy).
redis.connect().catch((err) => console.error('Redis: no se pudo conectar al arrancar:', err.message));

// Cierra la conexión al apagar el servicio (server.js).
export async function closeRedis() {
  if (redis.isOpen) await redis.close();
}
