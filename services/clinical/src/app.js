import express from 'express';
import { pool } from '@medicitas/common/db';
import { authenticate, identify } from '@medicitas/common/auth';
import { toResponse } from '@medicitas/common/errors';

// Servicio clinical: pacientes, notas clínicas y bitácora de auditoría (RF14, RF15, RF18, RF19).
// Todavía no tiene rutas propias: llegan en el bloque B.
// La app se exporta sin escuchar en un puerto para poder probarla con supertest.
export const app = express();

app.use(express.json());

// Nombre del servicio en cada respuesta, para saber quién contestó detrás del gateway.
app.use((req, res, next) => {
  res.set('X-MediCitas-Service', 'clinical');
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

// Los prefijos que el gateway envía a este servicio (gateway/nginx.conf). Todos exigen un token
// válido de un usuario registrado (RF17), aunque todavía no tengan rutas: sin token responden 401,
// con un rol que este servicio no atiende 403, y con un usuario válido 404.
const protect = [authenticate, identify];
app.use(['/patients', '/clinical-notes', '/audit'], protect);

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
