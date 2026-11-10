// Utilidades de las pruebas de integración: llaman a la API real a través del gateway, con tokens
// reales de Keycloak. Las direcciones salen de variables de entorno para que las mismas pruebas
// corran contra la pila local, contra una copia aislada o dentro del contenedor de pruebas.
import { before } from 'node:test';

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
export const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

// Todos los usuarios del realm de prueba usan esta contraseña (keycloak/medicitas-realm.json).
export const SEED_PASSWORD = 'medicitas';

// Si la pila no está arriba, todas las pruebas fallarían con errores de conexión. Se revisa una
// vez por archivo y se falla con un mensaje que dice qué hacer.
export function requireStack() {
  before(async () => {
    try {
      const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // se informa abajo
    }
    throw new Error(`La API no responde en ${API_URL}/health. Levante la pila con "docker compose up -d --wait" `
      + 'o ejecute las pruebas con "docker compose --profile test run --rm tests".');
  });
}

// Pide un token con usuario y contraseña. Devuelve la respuesta completa de Keycloak, porque
// algunas pruebas verifican justamente que el token se niegue (usuario dado de baja).
export async function requestToken(username, password = SEED_PASSWORD) {
  const res = await fetch(`${KEYCLOAK_URL}/realms/medicitas/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'medicitas-api', username, password }),
  });
  return { status: res.status, body: await res.json() };
}

// Token de acceso de un usuario. Lanza un error si Keycloak lo niega.
export async function token(username, password = SEED_PASSWORD) {
  const { status, body } = await requestToken(username, password);
  if (status !== 200) {
    throw new Error(`Keycloak negó el token de ${username}: ${status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

// Llama a la API. Devuelve el código, el cuerpo (JSON, si lo es) y el servicio que contestó
// (header X-MediCitas-Service; null si contestó el gateway).
export async function api(method, path, { token: bearer, body, headers = {} } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      ...(bearer && { authorization: `Bearer ${bearer}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // no era JSON: queda el texto
  }
  return { status: res.status, body: parsed, service: res.headers.get('x-medicitas-service'), headers: res.headers };
}

// Sufijo único por llamada, para que lo que crea una prueba no choque con corridas anteriores.
export function unique(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Datos de una persona nueva, con nombre de usuario y correo únicos y contraseña no temporal,
// para poder pedir su token enseguida.
export function newPerson(prefix) {
  const username = unique(prefix);
  return {
    username,
    email: `${username}@example.com`,
    name: 'Prueba',
    lastName: 'Automatizada',
    password: 'prueba-12345',
    temporaryPassword: false,
  };
}
