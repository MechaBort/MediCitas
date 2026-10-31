import { app } from './app.js';
import { pool } from './db.js';

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`MediCitas API escuchando en el puerto ${port}`);
});

// docker compose stop envía SIGTERM: se dejan de aceptar peticiones y se cierran
// las conexiones a la base antes de salir.
function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
