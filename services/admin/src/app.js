import express from 'express';
import { pool } from '@medicitas/common/db';
import { authenticate, identify } from '@medicitas/common/auth';
import { toResponse } from '@medicitas/common/errors';
import { clinicsRouter } from './routes/clinics.js';
import { usersRouter } from './routes/users.js';

// La app se exporta sin escuchar en un puerto para poder probarla con supertest.
export const app = express();

app.use(express.json());

// Nombre del servicio en cada respuesta, para saber quién contestó detrás del gateway.
app.use((req, res, next) => {
  res.set('X-MediCitas-Service', 'admin');
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// Toda ruta del dominio exige un token válido de un usuario registrado (RF17). El permiso
// específico lo pide cada router con requirePermission.
const protect = [authenticate, identify];

// Identidad de quien hace la petición, tal como la resolvió el backend: usuario, clínica,
// rol y permisos. No exige ningún permiso, solo un token válido de un usuario registrado.
app.get('/me', protect, (req, res) => {
  const { userId, clinicId, role, permissions } = req.user;
  res.json({ userId, clinicId, role, permissions: [...permissions] });
});

app.use('/clinics', protect, clinicsRouter);
app.use('/users', protect, usersRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Express 5 envía aquí también los errores de los handlers async. toResponse traduce los
// errores conocidos (HttpError, errores de datos de Postgres, JSON mal formado) a su código;
// lo demás es un 500 sin detalles internos.
app.use((err, req, res, next) => {
  const { status, body } = toResponse(err);
  if (status >= 500) console.error(err);
  res.status(status).json(body);
});
