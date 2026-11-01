import { createRemoteJWKSet, jwtVerify, errors } from 'jose';

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

// RFC 6750: la respuesta 401 de un recurso protegido con Bearer lleva WWW-Authenticate.
function unauthorized(res, message) {
  res.set('WWW-Authenticate', 'Bearer realm="medicitas", error="invalid_token"');
  res.status(401).json({ error: message });
}
