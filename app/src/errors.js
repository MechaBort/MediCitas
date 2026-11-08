import { z } from 'zod';

z.config(z.locales.es());

// Error con código HTTP. Las rutas lo lanzan y el manejador de errores de app.js lo
// convierte en la respuesta { error, details? } con ese status.
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
const PG_ERRORS = {
  '23505': [409, 'Ya existe un registro con esos datos'],                  // unique_violation
  '23503': [409, 'La operación rompe una referencia entre registros'],     // foreign_key_violation
  '23514': [400, 'Los datos no cumplen una regla del modelo'],             // check_violation
  '23P01': [409, 'Se cruza con otro registro vigente'],                    // exclusion_violation
  '22P02': [400, 'Formato de dato inválido'],                              // invalid_text_representation
  '42501': [403, 'El rol no tiene permiso para esta operación'],          // insufficient_privilege
};

// Traduce cualquier error a { status, body } para responder.
export function toResponse(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, ...(err.details && { details: err.details }) } };
  }
  const pg = PG_ERRORS[err.code];
  if (pg) {
    return { status: pg[0], body: { error: pg[1] } };
  }
  // Errores de Express, como un JSON mal formado, traen su propio status 4xx.
  const status = err.status ?? 500;
  return { status, body: { error: status >= 500 ? 'Error interno' : err.message } };
}
