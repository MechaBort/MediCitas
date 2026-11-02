import { z } from 'zod';
import * as keycloak from './keycloak.js';

// role_id fijos de db/sql/03-catalogs.sql.
export const ROLE_ID = { platform_admin: 1, clinic_admin: 2, reception: 3, professional: 4 };

// Datos de la persona para crear su cuenta. Usuario, correo y contraseña solo viven en
// Keycloak; nombre y apellido se guardan en ambos lados.
export const personSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,50}$/, 'Entre 3 y 50 caracteres: letras, números, punto, guion o guion bajo'),
  email: z.email().max(320),
  name: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  password: z.string().min(8).max(128),
  temporaryPassword: z.boolean().default(true),
}).strict();

// Crea la cuenta en Keycloak (usuario + rol) y después, con su id como keycloak_sub, ejecuta
// insertInDb(sub), que hace los INSERT en la base dentro de su propia transacción.
//
// Keycloak y Postgres no comparten una transacción. Si la parte de la base falla, se borra el
// usuario recién creado en Keycloak (compensación) y el error sigue hacia arriba. Si hasta la
// compensación falla, queda en Keycloak un usuario sin fila en users: puede pedir un token,
// pero identify le responde 403 porque no está registrado. El sistema falla cerrado.
export async function createAccount(person, role, insertInDb) {
  const sub = await keycloak.createUser(person);
  try {
    await keycloak.setRealmRole(sub, role);
    return await insertInDb(sub);
  } catch (err) {
    await keycloak.deleteUser(sub).catch((cleanupErr) => {
      console.error(`No se pudo borrar de Keycloak el usuario ${sub}; quedó sin fila en users`, cleanupErr);
    });
    throw err;
  }
}
