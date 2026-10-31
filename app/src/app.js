import express from 'express';
import { pool } from './db.js';

// La app se exporta sin escuchar en un puerto para poder probarla con supertest.
export const app = express();

app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Express 5 envía aquí también los errores de los handlers async.
// Un JSON mal formado llega con status 400; lo demás es un 500 sin detalles internos.
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
});
