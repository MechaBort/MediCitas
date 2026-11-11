import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '@medicitas/common/auth';
import { withTransaction } from '@medicitas/common/db';
import { HttpError, parse } from '@medicitas/common/errors';
import { daysBetween } from '../agenda-version.js';
import { computeGaps, gapsOf, readCachedGaps, storeGaps } from '../availability-cache.js';
import { sliceGaps } from '../slots.js';

// Disponibilidad (RF7, RF8): solo lectura. Todas las consultas filtran por req.user.clinicId: un profesional o un
// servicio de otra clínica responde 404, igual que uno que no existe (I5). Las fechas son días en la hora local de la
// clínica ('YYYY-MM-DD'); los espacios salen como instantes ISO 8601, en el mismo formato que la reserva, así que un
// espacio devuelto se puede mandar tal cual a POST /appointments.
//
// Los huecos pasan por la caché de Redis (availability-cache.js): primero Redis, luego la base solo para lo que falte,
// y después del COMMIT se guarda lo calculado. El header X-MediCitas-Cache dice de dónde salió la respuesta: 'hit'
// (todo de Redis), 'miss' (algo se calculó en la base y se guardó) u 'off' (Redis no disponible; todo de la base).
export const availabilityRouter = Router();
const CACHE_HEADER = 'X-MediCitas-Cache';

const id = z.coerce.number().int().positive().max(2147483647);

// Rango máximo de RF8. El costo crece con profesionales × días; sin tope, una sola petición de un año entero podría
// costar lo que cientos de peticiones normales, y en la etapa de la caché llenaría Redis de entradas que nadie vuelve a
// leer. 31 días alcanzan para consultar un mes completo.
const MAX_RANGE_DAYS = 31;

const professionalParams = z.object({ professionalId: id });
const professionalQuery = z.object({ serviceId: id, date: z.iso.date() }).strict();
const serviceParams = z.object({ serviceId: id });
const serviceQuery = z.object({ from: z.iso.date(), to: z.iso.date() }).strict();

// Las mismas revisiones que la reserva (RF9): profesional y servicio activos de la clínica, y que el profesional
// atienda ese servicio. Trae también la duración del servicio, que decide el largo de cada espacio (I4).
const PROFESSIONAL_CHECK_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM users u JOIN professionals p ON p.user_id = u.user_id
             WHERE u.clinic_id = $1 AND u.user_id = $2 AND u.is_active AND p.is_active) AS professional_ok,
    (SELECT duration_minutes FROM services
      WHERE clinic_id = $1 AND service_id = $3 AND is_active) AS duration,
    EXISTS (SELECT 1 FROM services_per_professionals
             WHERE clinic_id = $1 AND professional_id = $2 AND service_id = $3 AND is_active) AS offered`;

// RF7: espacios libres de un profesional en una fecha, para un servicio. Es la consulta más frecuente del sistema.
availabilityRouter.get('/professionals/:professionalId', requirePermission('availability.read'), async (req, res) => {
  const { professionalId } = parse(professionalParams, req.params);
  const { serviceId, date } = parse(professionalQuery, req.query);
  const { clinicId, dbRole } = req.user;

  // 1. Redis, antes de la base: la versión vigente y su copia.
  const cached = await readCachedGaps(clinicId, [{ professionalId, day: date }]);

  // 2. Una sola transacción: la validación siempre; el cálculo de los huecos solo si no había copia.
  const { duration, computed } = await withTransaction(dbRole, async (client) => {
    const { rows: [check] } = await client.query(PROFESSIONAL_CHECK_SQL, [clinicId, professionalId, serviceId]);
    if (!check.professional_ok) throw new HttpError(404, 'Profesional no encontrado');
    if (check.duration === null) throw new HttpError(404, 'Servicio no encontrado');
    if (!check.offered) throw new HttpError(400, 'El profesional no atiende ese servicio');

    return { duration: check.duration, computed: await computeGaps(client, clinicId, cached.missing) };
  });

  // 3. Después del COMMIT, se guarda lo calculado con la versión leída en el paso 1.
  await storeGaps(clinicId, cached, computed);

  res.set(CACHE_HEADER, cached.status).json({
    professionalId,
    serviceId,
    date,
    durationMinutes: duration,
    slots: sliceGaps(gapsOf(cached, computed, professionalId, date), duration),
  });
});

// Profesionales activos de la clínica que atienden el servicio (índice ix_spp_clinic_service).
const SERVICE_PROFESSIONALS_SQL = `
  SELECT spp.professional_id, u.name || ' ' || u.last_name AS name
    FROM services_per_professionals spp
    JOIN users u         ON u.user_id = spp.professional_id AND u.is_active
    JOIN professionals p ON p.user_id = spp.professional_id AND p.is_active
   WHERE spp.clinic_id = $1 AND spp.service_id = $2 AND spp.is_active
   ORDER BY spp.professional_id`;

// RF8: disponibilidad de un servicio en un rango de fechas. Usa el mismo cálculo que RF7, para todos los profesionales
// del servicio y todos los días del rango en una sola consulta. Solo aparecen los profesionales con al menos un
// espacio, y de cada uno solo los días que tienen espacios.
availabilityRouter.get('/services/:serviceId', requirePermission('availability.read'), async (req, res) => {
  const { serviceId } = parse(serviceParams, req.params);
  const { from, to } = parse(serviceQuery, req.query);
  const days = daysBetween(from, to);
  if (days.length === 0) throw new HttpError(400, 'La fecha final no puede ser anterior a la inicial');
  if (days.length > MAX_RANGE_DAYS) throw new HttpError(400, `El rango no puede pasar de ${MAX_RANGE_DAYS} días`);
  const { clinicId, dbRole } = req.user;

  // Los profesionales salen de la base, así que aquí la validación va primero y la caché después.
  const { duration, professionals } = await withTransaction(dbRole, async (client) => {
    const { rows: [service] } = await client.query(
      'SELECT duration_minutes FROM services WHERE clinic_id = $1 AND service_id = $2 AND is_active',
      [clinicId, serviceId]);
    if (!service) throw new HttpError(404, 'Servicio no encontrado');

    const { rows: professionals } = await client.query(SERVICE_PROFESSIONALS_SQL, [clinicId, serviceId]);
    return { duration: service.duration_minutes, professionals };
  });

  // Las mismas copias que RF7, una por (profesional, día): Redis primero; una segunda transacción solo si falta
  // alguna; después de su COMMIT, se guarda lo calculado.
  const pairs = professionals.flatMap(({ professional_id: professionalId }) =>
    days.map((day) => ({ professionalId, day })));
  const cached = await readCachedGaps(clinicId, pairs);
  const computed = cached.missing.length === 0
    ? new Map()
    : await withTransaction(dbRole, (client) => computeGaps(client, clinicId, cached.missing));
  await storeGaps(clinicId, cached, computed);

  const now = new Date();
  const available = [];
  for (const { professional_id: professionalId, name } of professionals) {
    const withSlots = days
      .map((date) => ({ date, slots: sliceGaps(gapsOf(cached, computed, professionalId, date), duration, now) }))
      .filter((day) => day.slots.length > 0);
    if (withSlots.length > 0) available.push({ professionalId, name, days: withSlots });
  }

  res.set(CACHE_HEADER, cached.status)
    .json({ serviceId, from, to, durationMinutes: duration, professionals: available });
});
