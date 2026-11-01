import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import { withTransaction } from './db.js';

// Llaves públicas del realm. jose las descarga la primera vez, las guarda en memoria
// y solo vuelve a pedirlas si llega un token firmado con una llave que no conoce
// (p. ej. después de que Keycloak rote sus llaves).
// Se piden por la red interna de Compose (keycloak:8080); el issuer del token, en
// cambio, es la URL pública (localhost:8080) porque así la fija KC_HOSTNAME.
const jwks = createRemoteJWKSet(new URL(process.env.KEYCLOAK_JWKS_URL));

const verifyOptions = {
  issuer: process.env.KEYCLOAK_ISSUER,      // el token lo emitió nuestro realm
  audience: process.env.KEYCLOAK_AUDIENCE,  // y va dirigido a esta API
  algorithms: ['RS256'],                    // el algoritmo con que firma Keycloak; rechaza "none" y similares
};

// RF17: toda ruta protegida exige un access token válido de Keycloak.
// Sin token, o con uno mal formado, vencido, de otro emisor o con firma inválida: 401.
// Si pasa, el contenido del token queda en req.token para los siguientes middlewares.
export async function authenticate(req, res, next) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  if (!match) {
    return unauthorized(res, 'Falta el token de acceso');
  }

  try {
    const { payload } = await jwtVerify(match[1], jwks, verifyOptions);
    req.token = payload;
    next();
  } catch (err) {
    // Un JOSEError es un problema del token. Cualquier otro error (Keycloak caído,
    // falla de red al pedir las llaves) no es culpa del cliente: sigue como 500.
    if (err instanceof errors.JOSEError && !(err instanceof errors.JWKSTimeout)) {
      return unauthorized(res, err instanceof errors.JWTExpired ? 'El token expiró' : 'Token inválido');
    }
    next(err);
  }
}

// Roles del dominio (realm roles de Keycloak) y el rol de base de datos con que trabaja
// cada uno. Keycloak puede agregar otros roles al token (offline_access, default-roles-...);
// esos se ignoran.
const DB_ROLE_BY_TOKEN_ROLE = {
  platform_admin: 'mc_platform',
  clinic_admin: 'mc_clinic_admin',
  reception: 'mc_reception',
  professional: 'mc_professional',
};

// Usuario de MediCitas que corresponde al sub del token, con su clínica, su rol registrado
// y los permisos de ese rol (tabla permissions_per_roles).
const IDENTITY_SQL = `
  SELECT u.user_id, u.clinic_id, u.is_active, c.is_active AS clinic_is_active, r.role_name,
         array_remove(array_agg(p.permission_name ORDER BY p.permission_name), NULL) AS permissions
    FROM users u
    JOIN roles r                       ON r.role_id = u.role_id
    LEFT JOIN clinics c                ON c.clinic_id = u.clinic_id
    LEFT JOIN permissions_per_roles pr ON pr.role_id = u.role_id AND pr.is_active
    LEFT JOIN permissions p            ON p.permission_id = pr.permission_id AND p.is_active
   WHERE u.keycloak_sub = $1
   GROUP BY u.user_id, c.is_active, r.role_name`;

// Asocia la identidad del token con su usuario en la base. La clínica sale de aquí y no de la
// petición: a partir de este punto toda consulta filtra por req.user.clinicId (I5).
// 403 si el token no trae exactamente un rol del dominio, si el sub no está registrado,
// si el usuario o su clínica están dados de baja, o si el rol registrado no es el del token.
export async function identify(req, res, next) {
  const tokenRoles = (req.token.realm_access?.roles ?? []).filter((r) => Object.hasOwn(DB_ROLE_BY_TOKEN_ROLE, r));
  if (tokenRoles.length !== 1) {
    return forbidden(res, 'El token debe traer exactamente un rol de MediCitas');
  }
  const [role] = tokenRoles;
  const dbRole = DB_ROLE_BY_TOKEN_ROLE[role];

  try {
    const user = await withTransaction(dbRole, async (client) =>
      (await client.query(IDENTITY_SQL, [req.token.sub])).rows[0]);

    if (!user) {
      return forbidden(res, 'La identidad no está registrada en MediCitas');
    }
    if (!user.is_active || user.clinic_is_active === false) {
      return forbidden(res, 'El usuario o su clínica están dados de baja');
    }
    if (user.role_name !== role) {
      return forbidden(res, 'El rol del token no coincide con el rol registrado');
    }

    req.user = {
      userId: user.user_id,
      clinicId: user.clinic_id,   // null solo para el administrador de plataforma
      role,
      dbRole,                     // el rol que usa withTransaction en las rutas
      permissions: new Set(user.permissions),
    };
    next();
  } catch (err) {
    next(err);
  }
}

// RF17: cada ruta declara el permiso del dominio que exige (ver la tabla permissions).
// Si el rol del usuario no lo tiene: 403. Se usa después de authenticate e identify.
export function requirePermission(permission) {
  return (req, res, next) =>
    req.user.permissions.has(permission) ? next() : forbidden(res, 'No tiene permiso para esta operación');
}

// RFC 6750: la respuesta 401 de un recurso protegido con Bearer lleva WWW-Authenticate.
function unauthorized(res, message) {
  res.set('WWW-Authenticate', 'Bearer realm="medicitas", error="invalid_token"');
  res.status(401).json({ error: message });
}

function forbidden(res, message) {
  res.status(403).json({ error: message });
}
