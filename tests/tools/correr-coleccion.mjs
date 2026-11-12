// Ejecuta en orden la colección requests/medicitas.http y compara cada respuesta con el código que anuncia el título
// de su petición: "[409]" o el último código entre paréntesis, como en "(RF9, 201)". Así la colección se puede correr
// desde la terminal sin instalar nada (Node 24 trae fetch), y se comprueba que sigue al día con la API.
//
//   node tests/tools/correr-coleccion.mjs                       # contra http://localhost:3000 y :8080
//   node tests/tools/correr-coleccion.mjs apiUrl=http://localhost:13000 keycloakUrl=http://localhost:18080 citaPasadaId=812
//
// Entiende el subconjunto del formato de REST Client que usa la colección: variables "@x = valor", "# @name nombre",
// "{{variable}}" y "{{nombre.response.body.$.campo}}" para reutilizar lo que devolvió una petición anterior.
import { readFileSync } from 'node:fs';

const file = new URL('../../requests/medicitas.http', import.meta.url);
const overrides = Object.fromEntries(process.argv.slice(2).map((a) => a.split(/=(.*)/s).slice(0, 2)));
const vars = {};
const responses = {};

function resolve(text) {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const ref = expr.trim().match(/^(\w+)\.response\.body\.\$\.(.+)$/);
    if (ref) {
      const value = ref[2].split('.').reduce((obj, key) => obj?.[key], responses[ref[1]]);
      if (value === undefined) throw new Error(`{{${expr}}}: la petición ${ref[1]} no devolvió ese campo`);
      return String(value);
    }
    const name = expr.trim();
    if (name in overrides) return overrides[name];
    if (name in vars) return resolve(vars[name]);
    throw new Error(`Variable sin definir: {{${name}}}`);
  });
}

// Cada bloque empieza en una línea "###": título, comentarios y variables, la línea de la petición, los headers y el
// cuerpo. Las líneas de comentario que quedan después del cuerpo (los títulos de sección) se descartan.
const blocks = readFileSync(file, 'utf8').split(/^###/m);
let failed = 0;
let sent = 0;
for (const block of blocks) {
  const lines = block.split('\n');
  const title = lines[0].trim();
  let name;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const variable = line.match(/^@(\w+)\s*=\s*(.*)$/);
    const named = line.match(/^#\s*@name\s+(\w+)/);
    if (variable) vars[variable[1]] = variable[2];
    else if (named) name = named[1];
    else if (/^(GET|POST|PUT|PATCH|DELETE) /.test(line)) break;
  }
  // Las variables del encabezado del archivo están en el primer bloque, antes de cualquier "###".
  if (i >= lines.length) continue;

  const [method, url] = lines[i].trim().split(/\s+/);
  const headers = {};
  for (i++; i < lines.length && lines[i].trim() !== ''; i++) {
    const [key, ...rest] = lines[i].split(':');
    headers[key.trim()] = rest.join(':').trim();
  }
  const body = lines.slice(i).filter((l) => !l.trim().startsWith('#')).join('\n').trim();

  const codes = [...title.matchAll(/\[(\d{3})\]|\b([1-5]\d\d)\b(?=[;),])/g)].map((m) => Number(m[1] ?? m[2]));
  const expected = codes.at(-1);
  sent++;
  try {
    const res = await fetch(resolve(url), {
      method,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolve(v)])),
      body: body ? resolve(body) : undefined,
    });
    const text = await res.text();
    if (name) responses[name] = text ? JSON.parse(text) : {};
    const cache = res.headers.get('x-medicitas-cache');
    const ok = expected === undefined || res.status === expected;
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✖'} ${res.status}${cache ? ` cache:${cache}` : ''}  ${title}`);
    if (!ok) console.log(`    esperaba ${expected}: ${text.slice(0, 300)}`);
  } catch (err) {
    failed++;
    console.log(`✖ ---  ${title}\n    ${err.message}`);
  }
}
console.log(`\n${sent} peticiones, ${failed} con un código distinto del anunciado.`);
process.exitCode = failed ? 1 : 0;
