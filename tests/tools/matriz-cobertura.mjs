// Genera la matriz de cobertura del informe de pruebas (docs/informe-pruebas.md): qué pruebas cubren cada requisito
// funcional (RF1–RF21) y cada invariante (I1–I8).
//
// La fuente son los nombres de las pruebas: por convención (docs/diseno-servicios.md §9), cada nombre empieza con los
// requisitos e invariantes que cubre, separados por comas y seguidos de dos puntos ("RF9, I5: …"). Así la matriz no
// se escribe a mano y no se desalinea del código.
//
//   node tests/tools/matriz-cobertura.mjs           # imprime la matriz
//   node tests/tools/matriz-cobertura.mjs --write   # la reemplaza en docs/informe-pruebas.md, entre sus marcadores
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

const REQUIREMENTS = {
  RF1: 'Alta de una clínica con su primer administrador',
  RF2: 'Usuarios de la clínica: alta, baja lógica y rol',
  RF3: 'Catálogo de servicios',
  RF4: 'Profesionales, especialidades y servicios habilitados',
  RF5: 'Horario de atención semanal',
  RF6: 'Bloqueos de agenda y citas en conflicto',
  RF7: 'Espacios disponibles de un profesional en una fecha',
  RF8: 'Disponibilidad por servicio en un rango de fechas',
  RF9: 'Reservar una cita',
  RF10: 'Reprogramar en una sola transacción',
  RF11: 'Cancelar con motivo y usuario',
  RF12: 'Registrar el desenlace (atendida o ausente)',
  RF13: 'Estados de la cita y transiciones permitidas',
  RF14: 'Pacientes y sus datos de contacto',
  RF15: 'Nota clínica del profesional que atendió',
  RF16: 'Historial de citas de un paciente',
  RF17: 'Autenticación con Keycloak y matriz de permisos',
  RF18: 'Bitácora de lecturas y escrituras sensibles',
  RF19: 'Consulta de la bitácora con filtros',
  RF20: 'Agenda del día',
  RF21: 'Conteo de citas por estado en un rango',
  I1: 'Un profesional nunca tiene dos citas vigentes solapadas',
  I2: 'Un paciente nunca tiene dos citas vigentes solapadas en la clínica',
  I3: 'Toda cita vigente cae en el horario y fuera de los bloqueos',
  I4: 'La duración la determina el servicio',
  I5: 'Ningún dato de una clínica es accesible desde otra',
  I6: 'La bitácora no admite modificación ni borrado',
  I7: 'Cancelar o reprogramar libera el espacio de inmediato',
  I8: 'La disponibilidad servida nunca contradice la base, aunque venga de la caché',
  'Módulo §9': 'Auditoría verificable: cadena de huellas SHA-256',
};

// Archivos de prueba: unitarias junto al código y de integración en tests/integration.
function testFiles() {
  const dirs = [
    ...readdirSync(join(ROOT, 'packages')).map((p) => join(ROOT, 'packages', p, 'test')),
    ...readdirSync(join(ROOT, 'services')).map((s) => join(ROOT, 'services', s, 'test')),
    join(ROOT, 'tests', 'integration'),
  ];
  return dirs.flatMap((dir) => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => join(dir, f));
    } catch {
      return [];
    }
  }).sort();
}

// Cada test('nombre', …): el nombre entre comillas simples, dobles o invertidas.
const TEST_RE = /\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

const tests = [];
for (const file of testFiles()) {
  const source = readFileSync(file, 'utf8');
  for (const [, , name] of source.matchAll(TEST_RE)) {
    const head = name.includes(':') ? name.slice(0, name.indexOf(':')) : '';
    const tags = head.split(',').map((t) => t.trim()).filter((t) => t in REQUIREMENTS);
    tests.push({ file: relative(ROOT, file), name, tags, unit: !file.includes('tests/integration') });
  }
}

const esc = (s) => s.replace(/\|/g, '\\|');
const lines = [];
lines.push('| Requisito | Qué exige | Pruebas | Archivos |', '|---|---|---|---|');
for (const [id, label] of Object.entries(REQUIREMENTS)) {
  const covering = tests.filter((t) => t.tags.includes(id));
  const files = [...new Set(covering.map((t) => `\`${t.file.split('/').pop()}\``))].join(', ');
  lines.push(`| **${id}** | ${label} | ${covering.length || '**ninguna**'} | ${files || '—'} |`);
}

lines.push('', '### Lista completa, por archivo', '');
let currentFile = '';
for (const t of tests) {
  if (t.file !== currentFile) {
    currentFile = t.file;
    lines.push('', `**\`${t.file}\`**${t.unit ? ' (unitaria)' : ''}`, '');
  }
  lines.push(`- ${esc(t.name.replace(/\$\{[^}]+\}/g, '…'))}`);
}
const uncovered = Object.keys(REQUIREMENTS).filter((id) => !tests.some((t) => t.tags.includes(id)));
lines.push('', `_${tests.length} pruebas declaradas en ${new Set(tests.map((t) => t.file)).size} archivos. ` +
  `Requisitos sin prueba: ${uncovered.length ? uncovered.join(', ') : 'ninguno'}._`);

const matrix = lines.join('\n');
if (process.argv.includes('--write')) {
  const target = join(ROOT, 'docs', 'informe-pruebas.md');
  const doc = readFileSync(target, 'utf8');
  const start = '<!-- matriz:inicio -->';
  const end = '<!-- matriz:fin -->';
  if (!doc.includes(start) || !doc.includes(end)) throw new Error(`Faltan los marcadores ${start} y ${end} en ${target}`);
  writeFileSync(target, `${doc.slice(0, doc.indexOf(start) + start.length)}\n${matrix}\n${doc.slice(doc.indexOf(end))}`);
  console.log(`Matriz actualizada en ${relative(ROOT, target)} (${tests.length} pruebas)`);
} else {
  console.log(matrix);
}
