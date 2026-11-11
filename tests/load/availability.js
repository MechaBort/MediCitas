// Medición de carga de RF7 (espacios libres de un profesional en una fecha) con k6, una herramienta de pruebas de
// carga. Corre en Docker, sin instalar nada, dentro de la red de Compose de la pila que se mide:
//
//   docker run --rm -i --network medicitas_default grafana/k6:1.3.0 run - < tests/load/availability.js
//
// Contra la copia aislada (AGENTS.md, "Verificación aislada"), la red es medicitas-verify_default. Las variables
// VUS (usuarios simultáneos, 50 por omisión), DURATION (30s) y SERVICE_ID (2) se cambian con -e, por ejemplo
// -e VUS=10. No es una prueba de node --test: el nombre no termina en .test.js y npm test no la ejecuta.
//
// setup() pide un token de recepción y, con RF8, arma la lista de pares (profesional, día) con espacio en las
// próximas dos semanas del seed. Después, cada usuario virtual consulta RF7 sobre un par al azar, sin pausas, durante
// todo el tiempo de la prueba. Lo que importa del resultado: http_reqs (consultas por segundo) y el p95 de
// http_req_duration, el tiempo dentro del cual responde el 95 % de las consultas. Es la línea base para comparar con la
// caché de RF7: la misma prueba, en la misma máquina, antes y después.
import http from 'k6/http';
import { check } from 'k6';

const API_URL = __ENV.API_URL || 'http://gateway:3000';
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://keycloak:8080';
const SERVICE_ID = __ENV.SERVICE_ID || '2';

export const options = {
  scenarios: {
    rf7: { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '30s' },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    checks: ['rate==1'],   // toda consulta debe responder 200; si no, la medición no vale
  },
};

export function setup() {
  const auth = http.post(`${KEYCLOAK_URL}/realms/medicitas/protocol/openid-connect/token`, {
    grant_type: 'password', client_id: 'medicitas-api', username: 'recepcion.sanjose', password: 'medicitas',
  });
  const token = auth.json('access_token');
  if (!token) throw new Error(`Keycloak no dio el token: ${auth.status} ${auth.body}`);

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const res = http.get(`${API_URL}/availability/services/${SERVICE_ID}?from=${from}&to=${to}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) throw new Error(`RF8 respondió ${res.status}: ${res.body}`);

  const pairs = [];
  for (const p of res.json('professionals')) {
    for (const d of p.days) pairs.push({ professionalId: p.professionalId, date: d.date });
  }
  if (pairs.length === 0) throw new Error(`El servicio ${SERVICE_ID} no tiene espacios en las próximas dos semanas`);
  console.log(`${pairs.length} pares (profesional, día) con espacio para el servicio ${SERVICE_ID}`);
  return { token, pairs };
}

export default function ({ token, pairs }) {
  const { professionalId, date } = pairs[Math.floor(Math.random() * pairs.length)];
  const res = http.get(
    `${API_URL}/availability/professionals/${professionalId}?serviceId=${SERVICE_ID}&date=${date}`,
    { headers: { authorization: `Bearer ${token}` }, tags: { name: 'RF7' } },
  );
  check(res, { 'RF7 responde 200': (r) => r.status === 200 });
}
