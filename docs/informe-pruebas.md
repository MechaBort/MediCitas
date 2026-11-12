# Informe de pruebas de MediCitas (Etapa 1)

Este informe responde lo que pide el enunciado (§3, §6 y §12): **qué prueba cubre cada requisito funcional y cada
invariante**, cómo se ejecutan las pruebas, qué resultado dan, y qué se midió antes y después de la caché.

## 1. Cómo se ejecutan

Todas las pruebas, unitarias y de integración, corren con **un solo comando**. Las de integración van contra la pila
real, siempre a través del gateway y con tokens reales de Keycloak.

| Dónde | Comando | Qué necesita |
|---|---|---|
| Compose, en un contenedor (el camino del evaluador) | `docker compose --profile test run --build --rm tests` | Solo Docker; levanta la pila si no está arriba |
| Compose, desde la máquina | `npm ci && npm test` | Node 24 y la pila arriba (`docker compose up`) |
| Kubernetes, dentro del clúster | `./k8s/run-tests.sh` | `./k8s/deploy.sh` ejecutado en minikube |
| Solo las unitarias | `npm run test:unit` | Node 24; no necesita la pila |

`--build` importa: sin él, `docker compose run` puede reutilizar una imagen de pruebas vieja y correr pruebas
desactualizadas.

## 2. Resultado

Corrida oficial del 2026-11-12 sobre `main` (`fe3b212`):

| Entorno | Cómo | Pruebas | Pasan | Fallan | Duración |
|---|---|---|---|---|---|
| Docker Compose | Clon limpio en una copia aislada, `docker compose --profile test run --build --rm tests` | 163 | **163** | 0 | 7,1 s |
| Kubernetes (minikube) | `./k8s/deploy.sh` y después `./k8s/run-tests.sh`, dentro del clúster | 163 | **163** | 0 | 7,4 s |

Hay 161 pruebas declaradas en 20 archivos: 3 de pruebas unitarias y 17 de integración. Se ejecutan 163, porque
`gateway.test.js` crea una prueba por cada servicio. **La misma suite pasa igual en los dos entornos.**

Las pruebas no borran lo que crean, porque el dominio no tiene borrados físicos, así que se pueden repetir sobre la
misma base. Cada dato que crean lleva un sufijo único, y nunca modifican los datos del seed.

## 3. Cómo están organizadas

- **Herramienta:** `node:test`, el ejecutor que trae Node, con `assert` y `fetch`. No agrega dependencias.
- **Unitarias** (`packages/common/test/`, `services/agenda/test/`), sin la pila:
  - la traducción de los errores de la base a HTTP (`MC001`–`MC006` y los `23P01` por restricción);
  - la validación de entradas;
  - la validación del rol de `withTransaction`;
  - el corte de los huecos libres en espacios (`slots.js`).
- **De integración** (`tests/integration/`), contra la pila real, con utilidades comunes en `helpers.js`. Para preparar
  datos y verificarlos en la base, como contar las filas de una tabla, `db.js` abre una conexión directa como
  `mc_owner`. **La operación que se prueba siempre pasa por la API.**
- **Trazabilidad.** El nombre de cada prueba empieza con los requisitos e invariantes que cubre, por ejemplo
  `RF9, I5: un paciente, un profesional o un servicio de otra clínica responde 404`. Con esa convención,
  `tests/tools/matriz-cobertura.mjs` genera la matriz de la sección 5 a partir del código; no se escribe a mano.

## 4. Las pruebas que más importan

**La prueba de carrera (RF9, I1),** en `appointments.test.js`. Varios clientes reservan **a la vez** el último espacio
libre de un profesional. Exactamente uno recibe 201, los demás reciben 409, y en la base queda **una sola cita**
reservada.
- **Se comprobó que la prueba discrimina.** En una copia aislada se quitó la restricción
  `ex_appointments_professional`: la API concedió las dos reservas (`[201, 201]`) y, con diez clientes, las diez. Así
  que la prueba falla si se quita lo que garantiza I1.

**La reprogramación (RF10),** en `appointment-reschedule.test.js`:
- **una sola transacción:** la cita original pasa a "reprogramada" y la nueva se crea juntas. Si el nuevo espacio está
  ocupado, responde 409 y el `ROLLBACK` deja la original reservada;
- **dos recepcionistas reprograman a la vez la misma cita,** hacia horas distintas, y gana una sola (se repite 5
  rondas);
- **reprogramaciones cruzadas a la vez** (A al espacio de B y B al de A), el caso que provoca deadlocks: no hay
  ningún 500, ni citas perdidas ni duplicadas, gracias al reintento de `withTransaction` (se repite 3 rondas).

**La caché no miente (I8),** en `availability-cache.test.js` y `availability.test.js`.
- **La secuencia.** La primera consulta es `miss` (se calcula en la base) y la segunda `hit` (sale de Redis), según el
  header `X-MediCitas-Cache`. Después de reservar, cancelar o reprogramar un espacio devuelto, la siguiente consulta
  vuelve a ser `miss` y ya refleja el cambio, **sin esperar a que venza nada**.
- **Se comprobó que las pruebas detectan el error.** Al apagar la invalidación (el `INCR` de la versión), fallaron
  justo las cinco pruebas de invalidación, y las demás siguieron pasando.

**El aislamiento entre clínicas (I5),** probado en tres capas. `tenant-isolation.test.js` lo prueba entre las tres
clínicas del seed, y cada ruta tiene además sus propias pruebas de I5:
1. un `clinicId` o `clinic_id` enviado por el cliente se rechaza con 400;
2. un recurso de otra clínica responde 404, igual que uno inexistente, y los listados nunca mezclan clínicas;
3. en la base, las FKs compuestas `(clinic_id, id)` rechazan con `23503` cualquier fila que apunte a otra clínica,
   aunque el código tuviera un error.

**La bitácora (RF18, I6 y el módulo del §9):**
- `patients-history.test.js` y `clinical-notes.test.js` cuentan **exactamente una fila** de bitácora por cada lectura
  o escritura de un contacto o de una nota, y comprueban que el texto de la nota nunca llega a la bitácora;
- `audit-verify.test.js` comprueba que ningún rol de la aplicación puede modificarla, y que si `mc_owner` desactiva el
  trigger y altera o borra un registro, `GET /audit/verify` señala exactamente ese registro.

## 5. Matriz de cobertura

Generada con `node tests/tools/matriz-cobertura.mjs --write`. Hay que volver a ejecutarla al agregar pruebas.

<!-- matriz:inicio -->
| Requisito | Qué exige | Pruebas | Archivos |
|---|---|---|---|
| **RF1** | Alta de una clínica con su primer administrador | 7 | `clinics.test.js` |
| **RF2** | Usuarios de la clínica: alta, baja lógica y rol | 10 | `auth.test.js`, `tenant-isolation.test.js`, `users.test.js` |
| **RF3** | Catálogo de servicios | 5 | `services-professionals.test.js` |
| **RF4** | Profesionales, especialidades y servicios habilitados | 7 | `appointments.test.js`, `availability.test.js`, `services-professionals.test.js` |
| **RF5** | Horario de atención semanal | 6 | `availability.test.js`, `schedules-blockades.test.js` |
| **RF6** | Bloqueos de agenda y citas en conflicto | 5 | `appointments.test.js`, `availability.test.js`, `schedules-blockades.test.js` |
| **RF7** | Espacios disponibles de un profesional en una fecha | 23 | `slots.test.js`, `availability-cache.test.js`, `availability.test.js`, `schedules-blockades.test.js`, `tenant-isolation.test.js` |
| **RF8** | Disponibilidad por servicio en un rango de fechas | 5 | `availability-cache.test.js`, `availability.test.js`, `tenant-isolation.test.js` |
| **RF9** | Reservar una cita | 17 | `slots.test.js`, `appointments.test.js`, `availability-cache.test.js`, `availability.test.js`, `tenant-isolation.test.js` |
| **RF10** | Reprogramar en una sola transacción | 14 | `agenda-reports.test.js`, `appointment-reschedule.test.js`, `availability-cache.test.js`, `availability.test.js`, `tenant-isolation.test.js` |
| **RF11** | Cancelar con motivo y usuario | 9 | `agenda-reports.test.js`, `appointment-status.test.js`, `availability-cache.test.js`, `availability.test.js`, `tenant-isolation.test.js` |
| **RF12** | Registrar el desenlace (atendida o ausente) | 8 | `errors.test.js`, `agenda-reports.test.js`, `appointment-status.test.js`, `tenant-isolation.test.js` |
| **RF13** | Estados de la cita y transiciones permitidas | 4 | `errors.test.js`, `appointment-reschedule.test.js`, `appointment-status.test.js` |
| **RF14** | Pacientes y sus datos de contacto | 5 | `patients-history.test.js` |
| **RF15** | Nota clínica del profesional que atendió | 7 | `clinical-notes.test.js` |
| **RF16** | Historial de citas de un paciente | 2 | `patients-history.test.js` |
| **RF17** | Autenticación con Keycloak y matriz de permisos | 24 | `agenda-reports.test.js`, `appointment-reschedule.test.js`, `appointment-status.test.js`, `appointments.test.js`, `audit-query.test.js`, `audit-verify.test.js`, `auth.test.js`, `availability.test.js`, `clinical-notes.test.js`, `clinics.test.js`, `patients-history.test.js`, `schedules-blockades.test.js`, `services-professionals.test.js`, `users.test.js` |
| **RF18** | Bitácora de lecturas y escrituras sensibles | 6 | `audit-query.test.js`, `clinical-notes.test.js`, `patients-history.test.js` |
| **RF19** | Consulta de la bitácora con filtros | 8 | `audit-query.test.js` |
| **RF20** | Agenda del día | 5 | `agenda-reports.test.js` |
| **RF21** | Conteo de citas por estado en un rango | 4 | `agenda-reports.test.js` |
| **I1** | Un profesional nunca tiene dos citas vigentes solapadas | 7 | `errors.test.js`, `appointment-reschedule.test.js`, `appointments.test.js` |
| **I2** | Un paciente nunca tiene dos citas vigentes solapadas en la clínica | 3 | `errors.test.js`, `appointment-reschedule.test.js`, `appointments.test.js` |
| **I3** | Toda cita vigente cae en el horario y fuera de los bloqueos | 7 | `errors.test.js`, `appointment-reschedule.test.js`, `appointments.test.js`, `schedules-blockades.test.js` |
| **I4** | La duración la determina el servicio | 5 | `errors.test.js`, `appointment-reschedule.test.js`, `appointments.test.js` |
| **I5** | Ningún dato de una clínica es accesible desde otra | 32 | `errors.test.js`, `agenda-reports.test.js`, `appointment-reschedule.test.js`, `appointment-status.test.js`, `appointments.test.js`, `audit-query.test.js`, `audit-verify.test.js`, `availability.test.js`, `clinical-notes.test.js`, `patients-history.test.js`, `schedules-blockades.test.js`, `services-professionals.test.js`, `tenant-isolation.test.js`, `users.test.js` |
| **I6** | La bitácora no admite modificación ni borrado | 6 | `errors.test.js`, `audit-verify.test.js`, `clinical-notes.test.js` |
| **I7** | Cancelar o reprogramar libera el espacio de inmediato | 5 | `appointment-reschedule.test.js`, `appointment-status.test.js`, `availability-cache.test.js`, `availability.test.js` |
| **I8** | La disponibilidad servida nunca contradice la base, aunque venga de la caché | 8 | `availability-cache.test.js`, `availability.test.js`, `schedules-blockades.test.js` |
| **Módulo §9** | Auditoría verificable: cadena de huellas SHA-256 | 5 | `audit-verify.test.js` |

### Lista completa, por archivo


**`packages/common/test/db.test.js`** (unitaria)

- withTransaction rechaza un rol fuera de la lista antes de tocar la base

**`packages/common/test/errors.test.js`** (unitaria)

- I3: MC001 (fuera del horario o dentro de un bloqueo) → 400
- RF13: MC002 (cambiar una cita en estado final) → 409
- RF12: MC003 (desenlace antes de la hora de inicio) → 409
- I3: MC006 (borrar un bloque de horario con citas) → 409
- I4, I6: MC004 y MC005 son inalcanzables desde la API → 500
- I1, I2: el 23P01 se distingue por la restricción que falló
- Una restricción EXCLUDE desconocida responde el 23P01 genérico
- Códigos estándar de Postgres: 23505 → 409, 23514 → 400, 42501 → 403
- Un error desconocido responde 500 sin filtrar su mensaje interno
- Un código heredado de Object.prototype ("constructor") no encuentra nada en las tablas
- Un error de Express con status 4xx conserva su status y su mensaje
- HttpError responde su status, su mensaje y sus detalles
- I5: parse rechaza con 400 un campo que el esquema no espera (por ejemplo, clinicId)
- parse devuelve los datos ya limpios

**`services/agenda/test/slots.test.js`** (unitaria)

- RF7: un hueco exacto se corta en espacios seguidos de la duración del servicio
- RF7: lo que sobra al final de un hueco no alcanza para un espacio
- RF7: cada hueco se corta desde su propio inicio
- RF7, RF9: un espacio que ya empezó, o empieza justo ahora, no se devuelve
- RF7: los huecos pueden venir como texto ISO 8601 (así los guardará la caché)

**`tests/integration/agenda-reports.test.js`**

- RF20: la agenda de un profesional lista sus citas del día en orden, con estado y nombres, también las canceladas
- RF20: la agenda de toda la clínica incluye a todos sus profesionales, ordenada por hora
- RF20, I5: una cita de otra clínica el mismo día no aparece, y un profesional de otra clínica responde 404
- RF20, RF17: recepción y el profesional consultan la agenda (200); la plataforma 403 y sin token 401
- RF20, I5: los parámetros se validan: sin fecha, fecha imposible, profesional no numérico o con clinicId responden 400
- RF21, RF10, RF11, RF12: cuenta por estado las citas de un profesional en un rango de fechas
- RF21: el conteo de toda la clínica trae los cinco estados e incluye los de cada profesional
- RF21: el rango se valida: al revés, de más de 366 días o sin fin responde 400; 366 días exactos, 200
- RF21, RF17, I5: solo el administrador de la clínica cuenta citas, y un profesional de otra clínica responde 404

**`tests/integration/appointment-reschedule.test.js`**

- RF10, I4, I7: recepción reprograma una cita; la original queda reprogramada y su espacio, libre
- RF10, I1, I2: la nueva hora puede cruzarse con la original, porque la original deja su espacio primero
- RF10, I1: si el nuevo espacio está ocupado responde 409, y el ROLLBACK deja la original reservada
- RF10, I3: una hora nueva fuera del horario, o en el pasado, responde 400 y la original sigue reservada
- RF10, RF13: una cita ya reprogramada o cancelada no se puede reprogramar (409)
- RF10, I1: dos recepcionistas reprograman la misma cita a la vez, a horas distintas: una sola gana (5 rondas)
- RF10: reprogramaciones cruzadas a la vez (A al espacio de B, B al de A): sin 500, sin citas perdidas ni duplicadas (3 rondas)
- RF10: se puede reprogramar con otro profesional que atiende el mismo servicio
- RF10, I5: una cita de otra clínica, o un profesional de otra clínica, responde 404 y nada cambia
- RF10, RF17, I4: un profesional no puede reprogramar (403), y el cuerpo se valida (400)

**`tests/integration/appointment-status.test.js`**

- RF11, I7: recepción cancela una cita con su motivo, y el espacio queda libre para otra reserva
- RF11: cancelar exige un motivo
- RF12: registrar como atendida una cita que ya empezó
- RF12, RF17: el profesional también registra el desenlace, por ejemplo una ausencia
- RF12: el desenlace antes de la hora de inicio responde 409 y la cita no cambia
- RF12: el desenlace solo puede ser atendida o ausente
- RF13: una cita cancelada no admite cambios: ni otra cancelación ni un desenlace (409)
- RF13: una cita atendida no admite cambios: ni cancelarla ni cambiar su desenlace (409)
- RF11, RF17: un profesional no puede cancelar citas (403)
- RF11, RF12, I5: una cita de otra clínica responde 404, igual que una inexistente, y no cambia
- RF11: un id de cita que no es un número responde 400

**`tests/integration/appointments.test.js`**

- RF9, I4: recepción reserva una cita; el fin lo calcula la base con la duración del servicio
- RF9, I4: el cliente no puede mandar el fin de la cita
- RF9, I1: dos citas seguidas del mismo profesional se conceden (los periodos [inicio, fin) no se cruzan)
- RF9, I1: pregunta rectora: dos recepcionistas por el último espacio, exactamente una reserva (5 rondas)
- RF9, I1: diez clientes simultáneos por el último espacio: uno solo gana
- RF9, I2: un paciente no puede tener dos citas a la misma hora, aunque sea con otro profesional
- RF9, I3: una cita fuera del horario del profesional, o que se sale de él, responde 400
- RF9, RF6, I3: una cita dentro de un bloqueo del profesional responde 400
- RF9: una cita que empieza en el pasado responde 400
- RF4, RF9: un servicio que el profesional no atiende responde 400
- RF9, I5: un paciente, un profesional o un servicio de otra clínica responde 404
- RF9, RF17: sin token responde 401, y un profesional no puede reservar (403)
- RF9, I5: el body se valida: sin inicio, inicio sin zona horaria o un clinicId responden 400

**`tests/integration/audit-query.test.js`**

- RF19, RF18: el administrador ve las lecturas recientes de su clínica, de la más nueva a la más antigua
- RF19: el filtro por usuario solo trae lo que hizo ese usuario
- RF19: el filtro por paciente solo trae lo que se hizo sobre ese paciente
- RF19: el rango de fechas incluye el día de hoy en la hora de la clínica, y un rango antiguo sale vacío
- RF19: la paginación con limit y beforeId recorre la bitácora sin repetir ni saltar entradas
- RF19, RF17: solo el administrador de la clínica consulta la bitácora
- RF19, I5: el administrador de otra clínica no ve nada de esta, ni filtrando por sus pacientes o usuarios
- RF19, I5: los parámetros se validan y un clinicId se rechaza con 400

**`tests/integration/audit-verify.test.js`**

- I6: ningún rol de la aplicación tiene UPDATE, DELETE ni TRUNCATE sobre audit_logs, y los triggers rechazan cambios con MC005
- Módulo §9, I6: GET /audit/verify confirma que la cadena de huellas SHA-256 nace íntegra en cada clínica
- Módulo §9: inserciones concurrentes en la misma clínica serializan con pg_advisory_xact_lock sin bifurcar la cadena
- Módulo §9, I6, I5: si mc_owner desactiva el trigger y altera un registro, GET /audit/verify señala exactamente ese log_id sin afectar a otras clínicas
- Módulo §9, I6: si mc_owner desactiva el trigger y borra un eslabón intermedio, GET /audit/verify detecta la ruptura en el registro siguiente
- Módulo §9, RF17, I5: GET /audit/verify exige el permiso audit.read (401/403) y rechaza query params desconocidos (400)

**`tests/integration/auth.test.js`**

- RF17: sin token, las rutas protegidas de los tres servicios responden 401
- RF17: un token con la firma alterada responde 401
- RF17: con un token válido del rol adecuado responde 200 con la identidad resuelta
- RF17: con un token válido pero sin el permiso responde 403
- RF17: un token válido cuyo sub no está registrado en MediCitas responde 403
- RF2, RF17: un usuario dado de baja en la base responde 403 aunque Keycloak le dé token
- RF17: un token de plataforma recibe 403 en agenda y clinical, que no atienden ese rol
- RF17: un usuario válido de la clínica pasa la identidad en agenda y clinical

**`tests/integration/availability-cache.test.js`**

- RF7, I8: la primera consulta se calcula en la base (miss) y la segunda sale de la caché (hit), igual
- RF7, RF9, I8: reservar un espacio devuelto invalida la copia: la siguiente consulta es miss y ya no lo muestra
- RF7, RF11, RF10, I7, I8: cancelar y reprogramar invalidan la copia, y la siguiente consulta refleja el cambio
- RF7, RF8, I8: RF7 y RF8 comparten las copias de cada profesional y día

**`tests/integration/availability.test.js`**

- RF7: un día con horario de 08:00 a 12:00 devuelve espacios seguidos, del largo del servicio
- RF5, RF7: una jornada partida no da espacios en el corte, y dos bloques seguidos se unen
- RF6, RF7: un bloqueo quita los espacios que toca
- RF7: un día sin horario, o con horario pero ya pasado, no tiene espacios
- RF7, RF9, I8: un espacio devuelto se reserva (201), y la siguiente consulta ya no lo muestra
- RF7, RF11, I7: cancelar una cita devuelve su espacio a la siguiente consulta
- RF7, RF10, I7: reprogramar libera el espacio viejo y ocupa el nuevo
- RF7, I5: un profesional o un servicio de otra clínica responde 404, igual que uno inexistente
- RF4, RF7: un servicio que el profesional no atiende responde 400
- RF7, RF8, RF17: sin token responde 401, la plataforma 403, y el profesional sí consulta (200)
- RF7, I5: los parámetros se validan: sin fecha, fecha imposible, sin servicio o con clinicId responden 400
- RF8: solo aparecen los profesionales con espacio, y cada día coincide con RF7
- RF8, I5: el rango se valida: al revés o de más de 31 días responde 400; de otra clínica, 404

**`tests/integration/clinical-notes.test.js`**

- RF15, RF18: el profesional que atendió la cita escribe su nota, la lee y la corrige; cada acceso deja una fila en la bitácora
- RF18: la bitácora registra quién, sobre cuál paciente y cuándo, pero nunca el texto de la nota
- RF15, RF17: recepción y el administrador de la clínica no escriben ni leen notas (403)
- RF15, I5: otro profesional de la misma clínica no escribe, no lee ni corrige la nota de una cita ajena (404)
- RF15, I5: un profesional de otra clínica recibe 404, igual que con una cita o una nota que no existe
- RF15: una cita que no está atendida responde 409 y no crea la nota
- RF15: una segunda nota para la misma cita responde 409, y la primera no cambia
- RF15, I5: el cuerpo y los parámetros se validan: sin texto, texto vacío, ids inválidos o con clinicId responden 400
- RF18, I6: la cadena de huellas de la bitácora sigue íntegra después de escribir, leer y corregir notas

**`tests/integration/clinics.test.js`**

- RF1: la plataforma da de alta una clínica, y su administrador inicia sesión en ella
- RF1: un código de clínica repetido responde 409
- RF1: una zona horaria que no es un nombre IANA responde 400
- RF1: un usuario que ya existe en Keycloak responde 409 y no deja la clínica creada
- RF1: dos altas simultáneas con el mismo código: una se concede y la otra no deja usuario en Keycloak
- RF1, RF17: solo la plataforma da de alta clínicas
- RF1: un body con un campo que la ruta no espera responde 400

**`tests/integration/gateway.test.js`**

- Gateway: … llegan a …
- Gateway: un prefijo desconocido responde 404 en JSON, desde el propio gateway
- Gateway: /health responde 200 con la base arriba

**`tests/integration/patients-history.test.js`**

- RF14, RF18: recepción registra un paciente con contactos, lo consulta y cada acceso a contactos queda en audit_logs
- RF14, RF18: actualizar datos y contactos de un paciente aplica baja lógica a los contactos retirados y audita los cambios
- RF14: una identificación repetida en la misma clínica responde 409, pero se permite en otra clínica
- RF14, RF17: un profesional consulta pacientes pero recibe 403 al intentar crearlos o actualizarlos, y fecha futura responde 400
- RF14, I5: un paciente de otra clínica responde 404 al consultar o editar, y no se acepta clinicId en el cuerpo
- RF16, RF17: consultar el historial de citas de un paciente devuelve sus citas en todos los estados y en orden cronológico
- RF16, I5: consultar el historial de un paciente de otra clínica responde 404 y parámetros inválidos responden 400

**`tests/integration/schedules-blockades.test.js`**

- RF5, RF7, I8: definir jornada partida por la API habilita los espacios de disponibilidad en hora local
- RF5: dos bloques de horario que se solapan para el mismo profesional responden 409 y hora inválida responde 400
- RF5, I3, I8: modificar o borrar un bloque con citas reservadas falla con 409 (MC006), y sin citas reservadas funciona
- RF6, I3, RF7, I8: un bloqueo sobre una cita ya reservada no la cancela, la lista en conflicts y retira disponibilidad
- RF5, RF6, RF17: un profesional con schedules.manage_own gestiona su propia agenda pero recibe 403 sobre otro profesional, y recepción recibe 403 al escribir
- RF5, RF6, I5: horarios y bloqueos de otra clínica responden 404 y no aceptan clinicId en el cuerpo

**`tests/integration/services-professionals.test.js`**

- RF3: alta y consulta de un servicio con nombre, duración en minutos y especialidad requerida
- RF3: actualización de nombre, duración, especialidad y baja lógica de un servicio
- RF3: duración no positiva o especialidad inexistente se rechazan
- RF4: alta de un profesional con su especialidad y servicios habilitados; inicia sesión en su clínica
- RF4: asociar y actualizar los servicios habilitados y las especialidades de un profesional
- RF3, RF4: no se puede asociar un servicio a un profesional que no tiene la especialidad requerida
- RF4: baja lógica de un profesional revoca su acceso en la API y en Keycloak
- RF3, RF4, RF17: recepción y profesionales no gestionan el catálogo de servicios ni los profesionales
- I5: los listados de /services y /professionals solo devuelven registros de la clínica del token
- I5: un servicio o profesional de otra clínica responde 404, igual que uno inexistente, y no se modifica
- I5: un clinicId enviado en el body de /services o /professionals se rechaza con 400

**`tests/integration/tenant-isolation.test.js`**

- I5, RF2: los listados y detalles de usuarios de San José, Cartago y Bogotá están estrictamente aislados entre sí
- I5, RF7, RF8: consultar disponibilidad con profesionales o servicios de otra clínica responde 404 sin revelar su existencia
- I5, RF9, RF10, RF11, RF12: ninguna combinación de recursos entre clínicas permite reservar, reprogramar, cancelar ni registrar desenlace
- I5: inyectar clinicId o clinic_id en el body o en los query params se rechaza con 400
- I5: las llaves foráneas compuestas (clinic_id, ...) en PostgreSQL rechazan con 23503 cualquier referencia entre clínicas distintas

**`tests/integration/users.test.js`**

- RF2: alta de un usuario de recepción, que inicia sesión con su rol en la clínica de quien lo creó
- RF2: cambio de rol: el token viejo deja de servir y el nuevo trae el rol nuevo
- RF2: baja lógica: el usuario ya no obtiene token y el que tenía deja de servir
- RF2: un administrador no puede darse de baja ni cambiarse el rol a sí mismo
- RF2: el rol de un profesional no se cambia por /users
- RF2: el alta no acepta los roles professional ni platform_admin
- RF2, RF17: recepción no gestiona usuarios
- I5: el listado de usuarios solo trae los de la clínica del token
- I5: un usuario de otra clínica responde 404, igual que uno inexistente, y no se modifica
- I5: un clinicId en el body se rechaza con 400
- RF2: un id de usuario que no es un número responde 400

_161 pruebas declaradas en 20 archivos. Requisitos sin prueba: ninguno._
<!-- matriz:fin -->

## 6. Mediciones

### Caché de RF7, antes y después (Compose)

`tests/load/availability.js` con k6: 50 usuarios simultáneos durante 30 s sobre RF7, a través del gateway. Resultados
del 2026-11-11, sin errores (detalle en el README, "Medición de carga de RF7"):

| Copias de `agenda` | Caché | Consultas por segundo | p95 | CPU de PostgreSQL |
|---|---|---|---|---|
| 1 | No | ~716 | 111 ms | ~270 % |
| 1 | Sí | ~963 | 81 ms | ~190 % |
| 3 | No | ~1 714 | 46 ms | ~820 % |
| 3 | Sí | ~2 415 | 37 ms | ~560 % |

Con la caché, la base hace cerca de **la mitad del trabajo por consulta**. Con 3 copias atendió un 41 % más de
consultas usando un 30 % menos de CPU.

### Escalado automático en Kubernetes (HPA de `agenda`)

Con `./k8s/load-test.sh` (k6 dentro del clúster, 100 usuarios durante 3 minutos), el 2026-11-12:
- `agenda` subió de 2 a 6 copias en unos 30 segundos y volvió a bajar de a una al terminar la carga;
- hubo 135 577 consultas, **todas correctas**, a ~753 por segundo, con un p95 de 200 ms.

La medición también encontró un cuello de botella, que se corrigió: con un PgBouncer compartido, 6 copias atendían
menos que 2. El detalle está en `docs/diseno-servicios.md` §7.

### Costo de la auditoría verificable (módulo del §9)

Lecturas auditadas (`GET /patients/{id}`) de una sola clínica, con 50 usuarios: ~530 por segundo sin la cadena de
huellas y ~394 con ella. Las clínicas distintas no compiten entre sí. El detalle está en `docs/diseno-servicios.md`
§11.

Todas las cifras se tomaron en una laptop, con k6 en la misma máquina: sirven para comparar entre sí, no como la
capacidad de un clúster real.

## 7. Límites conocidos

- **Las pruebas corren en paralelo** (un proceso por archivo) y comparten la base. Las que miran datos compartidos,
  como la bitácora de una clínica, filtran por lo que ellas mismas crearon o anclan sus consultas, para no depender de
  lo que escriben las demás. Una prueba del §9 que no lo hacía fallaba de forma intermitente, y se corrigió el
  2026-11-12.
- **La prueba de carga no es parte de `npm test`:** es una medición, no una aserción, y tarda minutos. Se corre aparte
  con k6.
- **La caída de Redis se comprobó a mano,** deteniendo Redis en una copia aislada: RF7 respondió 200 con
  `X-MediCitas-Cache: off`. No hay una prueba automatizada para eso, porque exigiría que la suite detuviera
  contenedores.
