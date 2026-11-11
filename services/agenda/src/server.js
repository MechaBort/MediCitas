import { app } from './app.js';
import { pool } from '@medicitas/common/db';
import { closeAgendaVersion } from './agenda-version.js';

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`MediCitas agenda escuchando en el puerto ${port}`);
});

// docker compose stop envía SIGTERM: se dejan de aceptar peticiones y se cierran
// las conexiones a la base y a Redis antes de salir.
function shutdown() {
  server.close(() => Promise.allSettled([pool.end(), closeAgendaVersion()]).then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
