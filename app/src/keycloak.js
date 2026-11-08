import { HttpError } from './errors.js';

// Cliente de la Admin REST API de Keycloak. La API se autentica como el client confidencial
// medicitas-user-admin (client_credentials), cuya service account solo tiene el rol
// manage-users de realm-management: puede administrar usuarios, no el realm.
const BASE = process.env.KEYCLOAK_URL;
const REALM = process.env.KEYCLOAK_REALM;
const ADMIN = `${BASE}/admin/realms/${REALM}`;

// Los cuatro roles del dominio. Un usuario debe tener exactamente uno (ver identify).
const DOMAIN_ROLES = ['platform_admin', 'clinic_admin', 'reception', 'professional'];

let cachedToken = null;   // { value, expiresAt }

// Token de la service account; se reutiliza hasta 30 s antes de que expire.
async function serviceToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }
  const res = await fetch(`${BASE}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.KEYCLOAK_USER_ADMIN_CLIENT_ID,
      client_secret: process.env.KEYCLOAK_USER_ADMIN_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Keycloak rechazó las credenciales del client de servicio (${res.status})`);
  }
  const body = await res.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 };
  return cachedToken.value;
}

async function adminRequest(method, path, body) {
  const res = await fetch(ADMIN + path, {
    method,
    headers: {
      authorization: `Bearer ${await serviceToken()}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Keycloak ${method} ${path} respondió ${res.status}: ${await res.text()}`);
    err.keycloakStatus = res.status;
    throw err;
  }
  return res;
}

// Crea el usuario habilitado y con contraseña. Devuelve su id, que es el `sub` de sus tokens.
// Con temporaryPassword, Keycloak obliga a cambiarla en el primer inicio de sesión (desde la
// consola de cuenta del realm) antes de entregarle tokens.
export async function createUser({ username, email, name, lastName, password, temporaryPassword }) {
  try {
    const res = await adminRequest('POST', '/users', {
      username,
      email,
      firstName: name,
      lastName,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: password, temporary: temporaryPassword }],
    });
    return res.headers.get('location').split('/').pop();
  } catch (err) {
    if (err.keycloakStatus === 409) {
      throw new HttpError(409, 'Ya existe un usuario con ese nombre de usuario o correo');
    }
    if (err.keycloakStatus === 400) {
      throw new HttpError(400, 'Keycloak rechazó los datos del usuario');
    }
    throw err;
  }
}

// Deja al usuario con exactamente el rol del dominio indicado. Es idempotente: repetirla no
// cambia nada, así que una sincronización que falló a medias se corrige repitiendo la petición.
export async function setRealmRole(userId, role) {
  const current = await (await adminRequest('GET', `/users/${userId}/role-mappings/realm`)).json();

  const others = current.filter((r) => DOMAIN_ROLES.includes(r.name) && r.name !== role);
  if (others.length > 0) {
    await adminRequest('DELETE', `/users/${userId}/role-mappings/realm`, others);
  }

  if (!current.some((r) => r.name === role)) {
    // Los roles asignables al usuario; leer /roles/{nombre} exigiría además el permiso view-realm.
    const available = await (await adminRequest('GET', `/users/${userId}/role-mappings/realm/available`)).json();
    const target = available.find((r) => r.name === role);
    if (!target) {
      throw new Error(`El rol ${role} no existe en el realm ${REALM}`);
    }
    await adminRequest('POST', `/users/${userId}/role-mappings/realm`, [target]);
  }
}

// Habilita o deshabilita el usuario. Deshabilitado, Keycloak ya no le entrega tokens.
// Se envía la representación completa porque un PUT parcial puede borrar atributos del perfil.
export async function setEnabled(userId, enabled) {
  const user = await (await adminRequest('GET', `/users/${userId}`)).json();
  await adminRequest('PUT', `/users/${userId}`, { ...user, enabled });
}

// Se usa para deshacer un alta cuando la base falló después de crear el usuario en Keycloak.
export async function deleteUser(userId) {
  try {
    await adminRequest('DELETE', `/users/${userId}`);
  } catch (err) {
    if (err.keycloakStatus !== 404) {
      throw err;
    }
  }
}
