import { z } from 'zod';

z.config(z.locales.es());

// Error con código HTTP. Las rutas lo lanzan y el manejador de errores de cada servicio
// (su app.js) lo convierte en la respuesta { error, details? } con ese status.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Valida data con un esquema de zod y devuelve los datos ya limpios (trim, coerción de tipos).
// Si no cumple: 400 con la lista de campos y su problema.
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || null,
      problem: issue.message,
    }));
    throw new HttpError(400, 'Solicitud inválida', details);
  }
  return result.data;
}

// Errores de PostgreSQL que se deben a los datos de la petición y no a una falla del
// servidor. Cualquier otro código (incluido un error de sintaxis nuestro) sigue siendo 500.
// Cada entrada es [status, mensaje]. Con null como mensaje se responde el texto del
// RAISE EXCEPTION que lanzó la base (err.message).
const PG_ERRORS = {
  '23505': [409, 'Ya existe un registro con esos datos'],                  // unique_violation
  '23503': [409, 'La operación rompe una referencia entre registros'],     // foreign_key_violation
  '23514': [400, 'Los datos no cumplen una regla del modelo'],             // check_violation
  '23P01': [409, 'Se cruza con otro registro vigente'],                    // exclusion_violation
  '22P02': [400, 'Formato de dato inválido'],                              // invalid_text_representation
  '42501': [403, 'El rol no tiene permiso para esta operación'],          // insufficient_privilege
  'MC001': [400, 'Cita solicitada en ubicacion prohibida'],  // La cita no cabe completa en los bloques de horario del profesional, o se cruza con uno de sus bloqueos.
  'MC002': [409, 'Cambio de estado de una cita en estado final'],  // Cambiar una cita que ya está en un estado final.
  'MC003': [409, 'Cambio de estado de una cita sin permiso'],  // Registrar atendida o ausente antes de la hora de inicio.
  'MC004': [500, 'Cambio de horario de una cita ya existente'],  // Cambiar el horario, el servicio, el profesional o el paciente de una cita existente.
  'MC005': [500, 'Modificación de bitácora inválida'],  // Modificar, borrar o vaciar la bitácora.
  'MC006': [409, 'Bloqueo de horario inválido'],  // Borrar o recortar un bloque de horario que dejaría citas reservadas fuera del horario.
};

// Todas las restricciones EXCLUDE fallan con 23P01. El nombre de la que falló (err.constraint) dice
// con qué fue el choque; una restricción que no esté aquí responde el 23P01 genérico de PG_ERRORS.
const EXCLUSION_ERRORS = {
  'ex_schedules_overlap': [409, 'Bloques de horario solapados'],
  'ex_appointments_professional': [409, 'Se cruza el profesional con otro registro vigente'],
  'ex_appointments_patient': [409, 'Se cruza el paciente con otro registro vigente'],
};

// La entrada de una tabla de traducción, o undefined. Object.hasOwn evita que una clave como
// "constructor" encuentre algo heredado de Object.prototype.
function lookup(table, key) {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// Traduce cualquier error a { status, body } para responder.
export function toResponse(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, ...(err.details && { details: err.details }) } };
  }
  const pg = (err.code === '23P01' && lookup(EXCLUSION_ERRORS, err.constraint)) || lookup(PG_ERRORS, err.code);
  if (pg) {
    return { status: pg[0], body: { error: pg[1] ?? err.message } };
  }
  // Errores de Express, como un JSON mal formado, traen su propio status 4xx.
  const status = err.status ?? 500;
  return { status, body: { error: status >= 500 ? 'Error interno' : err.message } };
}
