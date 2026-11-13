# Declaración de uso de inteligencia artificial

El enunciado pide declarar cómo se usó la IA, en qué partes y qué se verificó de forma manual. Esta declaración
responde a las tres cosas, y agrega las decisiones que tomó el grupo, para que se distinga la aportación propia de
la de la herramienta.

**Herramienta:** Claude Code (Anthropic), un asistente que trabaja en la terminal con acceso al repositorio, a
Docker y a minikube.

## 1. Cómo se usó

- **La IA propone y el grupo decide.** Antes de implementar, la IA proponía un plan por etapas, y en cada decisión
  explicaba el problema, la opción elegida, las alternativas descartadas y lo que se sacrifica. No empezaba a
  programar hasta que el integrante aprobaba el plan, lo cambiaba o pedía más explicación. Esas explicaciones
  quedaron en `docs/diseno-servicios.md` y `docs/comparacion-arquitecturas.md`. Varias propuestas se rechazaron o se
  cambiaron (sección 3).
- **Por etapas, con parada y revisión.** Al terminar cada etapa, la IA se detenía y entregaba un reporte con los
  archivos cambiados, el diff y las decisiones. En el trabajo de Sebastián y de Emmanuel, la IA nunca hizo commits,
  push, PR ni merges: los hizo el integrante después de revisar los cambios.
- **Código escrito por el integrante.** En algunas partes, la IA dejó preparada la estructura y el integrante
  escribió la lógica; después la IA la revisó (ejemplos en la sección 3).
- **Para entender lo generado.** Se construyó `docs/guia-de-estudio.md`: explica cada parte desde lo básico, con
  experimentos que se pueden repetir sobre la base y preguntas de autoevaluación. Cada integrante debe poder
  defender todo el sistema.
- **Verificación aislada.** Todo cambio se probó en una copia aparte de la pila (otro proyecto de Docker, con otros
  puertos), sin tocar la pila local de nadie.
- **Trello.** La IA revisaba el tablero y proponía qué mover, y solo escribía en él con la aprobación explícita del
  integrante.

## 2. En qué partes

### Diseño inicial (grupo, octubre)

- Revisión del diseño inicial de la base de datos contra el enunciado: señaló requisitos no cubiertos e inconsistencias.
- Propuestas de diseño que el grupo discutió y aceptó, modificó o rechazó: restricciones `EXCLUDE` con `tstzrange` para I1/I2, FKs compuestas con `clinicId` para I5, tabla `Professionals` como especialización de `Users`, roles de base de datos e índices.
- Redacción de borradores de las secciones de decisiones de diseño del README.

### Sebastián Chaves

- Implementación de la primera versión de la pila a partir del diseño del grupo: el script de inicialización de la base, el esquema SQL, los permisos, los catálogos y el seed, el realm de Keycloak, el `docker-compose.yml` y la aplicación Node inicial. Después de esto se escribió la guía de estudio, para repasar y entender ese código.
- Comparación de tres enfoques de arquitectura (servicios con una base dividida en schemas, la agenda con su propia base, y microservicios estrictos) y diseño de la caché de disponibilidad (`docs/comparacion-arquitecturas.md`), y diseño detallado de los servicios (`docs/diseno-servicios.md`).
- Reestructuración del repositorio en npm workspaces, separación de las tablas en los schemas `admin`, `agenda` y `clinical`, un usuario de base por servicio con su `CONNECTION LIMIT`, y la corrección de la política de expulsión de Redis (`volatile-lru`).
- Integración en `main` de las seis ramas de Fabricio, un PR por rama (#13 a #18): la IA resolvió los conflictos, casi todos de documentación, y verificó cada rama antes del merge.
- Implementación asistida de las notas clínicas (`RF15`, `/clinical-notes`) y de su registro en la bitácora (`RF18`) en `services/clinical`, con sus pruebas de integración (`tests/integration/clinical-notes.test.js`). La regla de acceso (solo citas propias y atendidas) la escribió Sebastián; Claude preparó la estructura, las pruebas y la documentación.
- Implementación asistida de la consulta de la bitácora (`RF19`, `GET /audit`) con filtros por usuario, paciente y fechas, paginada por cursor, con sus pruebas (`tests/integration/audit-query.test.js`). Claude la implementó completa, incluidas la política de paginación (50 por defecto, 200 como máximo) y la validación del rango; Sebastián revisó y aprobó las decisiones.
- Diseño e implementación asistida del paso 1 de Kubernetes (`k8s/`): PostgreSQL con el operador CloudNativePG, su inicialización con el mismo `db/init/00-init.sh` de Compose en un Job, y PgBouncer en modo transacción, más el script de despliegue `k8s/deploy.sh`. También se corrigió una prueba del §9 que fallaba de forma intermitente al correr en paralelo con otras.
- Diseño e implementación asistida del paso 2 de Kubernetes: Deployments y Services de `admin`, `agenda`, `clinical`, el gateway, Keycloak y Redis; imágenes construidas dentro de minikube; un Secret por componente; y `k8s/run-tests.sh`, que corre la suite completa dentro del clúster.
- Diseño e implementación asistida del paso 3 de Kubernetes: `metrics-server`, el HPA de `agenda` (entre 2 y 6 copias según la CPU) y `k8s/load-test.sh`, que corre la prueba de carga de RF7 dentro del clúster y registra cómo escala `agenda`.
- Diseño e implementación asistida del paso 4 de Kubernetes: una base secundaria con replicación síncrona y failover automático (`instances: 2` en el Cluster), la respuesta 503 cuando la base no está disponible (`isDatabaseUnavailable` en `packages/common/src/errors.js`), dos parámetros de PgBouncer que acortan la recuperación, y `k8s/failover-test.sh`, que simula la caída de la principal y comprueba que no se pierde ninguna escritura confirmada. Claude escribió todo el código y las mediciones; Sebastián tomó las decisiones de diseño.
- Restricción de la agenda del día (`RF20`) para que el profesional solo vea la suya, con el permiso nuevo `agenda.read_own` y su prueba.
- Generación asistida del informe de pruebas (`docs/informe-pruebas.md`), con una matriz de cobertura que se genera desde los nombres de las pruebas (`tests/tools/matriz-cobertura.mjs`), y del documento de diseño (`docs/diseno.md`), que reúne el modelo, el multi-tenancy y el aislamiento.
- Completar la colección de peticiones (`requests/medicitas.http`) con las rutas que faltaban, y `tests/tools/correr-coleccion.mjs`, que la ejecuta desde la terminal y compara cada respuesta con el código esperado.
- Ensayo de cierre: repetir la suite más de veinte veces encontró cuatro fallas intermitentes. Con la IA se diagnosticó cada una a partir de los registros de PostgreSQL y de los servicios, y se corrigieron: las reservas simultáneas del mismo bloque de horario hacen fila (`FOR NO KEY UPDATE` en el trigger de I3) y `withTransaction` espera al azar entre reintentos; además, tres pruebas que se pisaban entre archivos (el §9, la paginación de RF19 y la elección de días libres).

### Fabricio Hernández

- Implementación de las rutas de catálogo de servicios (`RF3`, `/services`) y profesionales con sus especialidades y servicios habilitados (`RF4`, `/professionals`) en `services/admin`, junto con sus pruebas de integración y de aislamiento entre clínicas (`I5`) en `tests/integration/services-professionals.test.js`.
- Implementación asistida de las rutas de horarios de atención (`RF5`, `/schedules`) y bloqueos de agenda con detección de citas en conflicto (`RF6`, `/blockades`) en `services/agenda`, junto con sus pruebas de integración (`tests/integration/schedules-blockades.test.js`) para `RF5`, `RF6`, `I3`, `I5`, `I8` y `RF17`.
- Implementación asistida de las rutas de pacientes (`RF14`, `/patients`) con registro de auditoría de contactos (`RF18`) en `services/clinical` y del historial de citas de un paciente (`RF16`, `GET /appointments?patientId=…`) en `services/agenda`, junto con sus pruebas de integración (`tests/integration/patients-history.test.js`).
- Implementación del Módulo §9 (auditoría verificable con cadena de huellas SHA-256 por clínica en `clinical.audit_logs`, trigger `BEFORE INSERT` con `pg_advisory_xact_lock`, función `clinical.verify_audit_chain` y ruta `GET /audit/verify`) y sus pruebas automatizadas de integración (`I6` y detección de manipulación).
- Diseño e implementación asistida de la suite de pruebas automatizadas de aislamiento multi-tenant (`tests/integration/tenant-isolation.test.js`) para validar las tres capas de defensa de la invariante `I5` entre clínicas.
- Extracción y documentación de los planes de ejecución `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)` sobre los datos semilla y creación de la colección versionada de peticiones (`requests/medicitas.http`).

### Emmanuel Blanco

Sus cambios del 2026-11-09 al 2026-11-12: las etapas 4, 5 y 6 de la hoja de ruta (los cimientos) y el carril del
servicio `agenda` (RF7 a RF13, RF20, RF21 y la caché de Redis). Claude escribió el código, las pruebas y la
documentación de cada etapa, y Emmanuel lo revisó y lo integró.

| Etapa | Commit | Lo que escribió Claude |
|---|---|---|
| 4. Errores de la base | `a0f9fda` | En `errors.js`, la distinción de los `23P01` según la restricción violada. La tabla `MC001`–`MC006` es de Emmanuel |
| 5. Servicios y gateway | `c29b855` | Los servicios `agenda` y `clinical` (Dockerfile, `app.js`, `server.js`), el gateway Nginx (`gateway/nginx.conf`) y sus entradas en `docker-compose.yml` |
| 6. Arnés de pruebas | `88896c4` | El comando `npm test` con `node:test`, el contenedor de pruebas y las primeras 46 pruebas (15 unitarias y 31 de integración) |
| RF9: reservar | `b4963c1` | `POST /appointments`, la prueba de carrera (dos y diez clientes por el último espacio) y la versión de agenda en Redis (`agenda-version.js`) |
| RF11–RF13: cancelar y desenlace | `31a051d` | `POST /appointments/{id}/cancel` y `/outcome`, con sus pruebas de transiciones de estado |
| RF10: reprogramar | `4512d0d` | `POST /appointments/{id}/reschedule` en una sola transacción, con 10 pruebas, entre ellas una carrera y un deadlock provocado a propósito |
| RF7, RF8: disponibilidad | `8d14f59` | El cálculo de huecos libres en SQL con rangos múltiples, el corte en espacios, las dos rutas, 18 pruebas y el script de carga con k6 |
| Caché de RF7 | `1bddcf9` | La lectura y escritura de copias en Redis (`availability-cache.js`, `redis.js`), 4 pruebas de la caché y la medición antes y después |
| RF20, RF21: agenda y conteo | `0d47dd6` | `GET /agenda` y `GET /reports/appointments-by-status`, con 9 pruebas |

En todas las etapas, Claude además:
- documentó el contrato de cada ruta en el README, el porqué de cada decisión en `docs/diseno-servicios.md` y
  `docs/comparacion-arquitecturas.md`, y la guía de estudio;
- verificó cada etapa en una copia aislada de la pila y confirmó con `EXPLAIN ANALYZE` que las consultas usan sus
  índices;
- midió la carga de la consulta de disponibilidad con k6, antes y después de la caché;
- mantuvo el contexto del proyecto en un archivo para los asistentes (`AGENTS.md`), fuera del repositorio entregado.

**Lo que no hizo la IA:** commits, push ni fusiones (los hizo Emmanuel); la decisión final de ninguna etapa (cada plan
se aprobó antes de implementarlo); mover tarjetas del Trello sin aprobación; ni la tabla de traducción de errores de
la etapa 4.

**Responsabilidad.** Emmanuel revisó cada etapa antes de su commit y asume la responsabilidad de lo entregado. Pidió
explicaciones en prosa de las decisiones que no le quedaban claras antes de aprobarlas, por ejemplo el vencimiento de
la caché y los topes de días de RF8 y RF21.

## 3. Decisiones del grupo

Estas decisiones las tomó el grupo, muchas veces en contra de la primera propuesta de la IA o preguntando por casos
que la propuesta no cubría.

**Sebastián:**
- **La arquitectura.** Pidió separar el sistema en servicios con un schema por servicio, para poder escalar el
  servicio de más demanda (la agenda) sin escalar todo. Cuando la IA empezó a mover tablas a schemas, la detuvo y
  pidió comparar primero las arquitecturas (microservicios contra basada en servicios). Se inclinó por la base única
  con un schema por servicio, que el equipo aprobó, y propuso usar réplicas de lectura en Kubernetes, de donde salió
  el plan de CloudNativePG por pasos. También cuestionó si el servicio de citas no quedaba demasiado grande.
- **La reserva es síncrona y transaccional.** Ante la opción de resolver reservas de forma asíncrona, la rechazó:
  "prefiero que una reserva se tenga que hacer dos veces" antes que confirmar una cita que después resulte inválida.
- **Una cita reservada no cambia de duración ni de horario.** Argumentó que un administrador que cambia la duración
  de una cita ya reservada podría sacarla del horario, meterla en un bloqueo o solaparla con la siguiente. Por eso el
  trigger de I4 lo prohíbe (`MC004`).
- **La caché.** Eligió guardar los huecos libres. Antes de aceptar la invalidación por versión, pidió analizar los
  casos extremos: dos escrituras simultáneas que invalidan a la vez, y la posible estampida de consultas a la base.
- **Los `CONNECTION LIMIT`.** Cuestionó que un tope de conexiones contradijera la meta de 200 000 peticiones por
  minuto, y antepuso la escala. Así quedaron los topes calculados con una regla explícita, con PgBouncer delante.
- **El paso 4 de Kubernetes, primero descartado y después retomado.** Al principio descartó la réplica con failover
  al cuestionar su costo: un segundo PostgreSQL encendido que solo sirve si el primero se cae. El 2026-11-12 la retomó
  como una base secundaria que solo espera, para que el sistema sobreviva a la caída de la principal. Pidió discutir
  antes cada decisión, y eligió entre las opciones que presentó la IA:
  - **solo en Kubernetes**, y no en Compose;
  - **replicación síncrona** (`preferred`) en lugar de la consistencia eventual que había planteado, después de que la
    IA le mostró que con la asíncrona se puede perder una reserva ya confirmada;
  - **503 sin reintentos** durante el corte, por el riesgo del commit ambiguo;
  - documentar como límite conocido que Keycloak tarda en recuperarse, en lugar de cambiar su configuración cerca del
    congelamiento;
  - y probar los dos parámetros de PgBouncer con una medición antes de adoptarlos.
- **El cierre.** Integrar él las ramas de Fabricio, con un PR por rama, en vez de esperar. Las notas clínicas se
  pueden corregir con un `PATCH` que queda en la bitácora. Primero los requisitos funcionales y después Kubernetes. El
  profesional solo ve su propia agenda (RF20), como dice el §2 del enunciado.
- **Código propio.** Escribió los mensajes de `MC001` y `MC003`, y la primera versión de la regla de acceso de las
  notas clínicas (`loadOwnAttendedAppointment`). La IA señaló sus errores (tabla equivocada, un `await` faltante, una
  comparación con `=` y una condición invertida), y se corrigieron juntos.
- **Revisión del diseño de la base.** Pidió justificar restricciones como `uq_users_user_role` con ejemplos, y a raíz
  de esa revisión se quitó un `ON UPDATE CASCADE`.

**Emmanuel, en su carril:**
- **La traducción de errores de la base (etapa 4).** Escribió él mismo la tabla que traduce `MC001`–`MC006` a códigos
  HTTP. Claude explicó cada código y su criterio, sin escribirla.
- **Los cambios de estado (RF11–RF13).** Aprobó rutas de acción separadas (`/cancel` y `/outcome`), cada una con su
  permiso, en lugar de un `PATCH` genérico del estado.
- **Reprogramar (RF10).** Aprobó que la reprogramación reutilice las revisiones de la reserva y permita cambiar de
  profesional.
- **La disponibilidad (RF7, RF8).** La idea de que la consulta parta de los horarios, para que los días sin horario no
  cuesten nada, es suya. Aprobó el tope de 31 días de RF8 después de discutir por qué hacía falta.
- **La caché de RF7.** Aprobó, después de pedir que se le explicaran una por una: que la validación del profesional y
  el servicio siga consultando la base en cada petición; el vencimiento de 60 segundos; el header
  `X-MediCitas-Cache`, para que las pruebas vean de dónde sale cada respuesta; la conexión a Redis en su propio
  archivo; y medir con una y con tres copias del servicio. También decidió hacer la caché en su propia rama.
- **La agenda del día y los reportes (RF20, RF21).** Aprobó rutas propias (`/agenda` y `/reports`), mostrar las citas
  en todos los estados, y el tope de 366 días del conteo, después de cuestionar si no sería lento frente a los 31 días
  de RF8. También aprobó que el profesional viera la agenda de toda la clínica, como permitía la matriz; el
  2026-11-12 el grupo cambió esa regla para que solo vea la suya, como dice el §2 del enunciado.
- **Una regla de trabajo propia:** antes de mover o borrar código que ya estaba en `main`, la IA debía explicar por qué.

**El grupo:**
- aprobó el 2026-11-08 la arquitectura (tres servicios con una base dividida en un schema por servicio, frente a los
  microservicios con bases separadas) y la caché con invalidación por versión después del COMMIT y `volatile-lru`;
- definió la hoja de ruta por etapas y el reparto del trabajo, y eligió el módulo del §9 (auditoría verificable) el
  2026-11-10;
- fijó las reglas de trabajo con la IA: pasos pequeños y explicables, cada decisión explicada, nada se implementa sin
  aprobar el plan, y los commits los hace el integrante.

## 4. Qué se verificó de forma manual

Además de la suite automática (166 pruebas, que pasan en Compose y en Kubernetes), se comprobó a mano, ejecutando y
revisando la salida:

- **El arranque desde un clon limpio**, con `cp .env.example .env` y `docker compose up`, sin pasos manuales.
- **La identidad y el aislamiento:** con `curl`, sin token (401), con un rol sin permiso (403) y pidiendo recursos de
  otra clínica (404).
- **La carrera:** dos `INSERT` simultáneos sobre el mismo espacio dejan una sola cita reservada.
- **Que las pruebas importantes detectan el error** (Emmanuel, en su carril). En cada caso se introdujo el fallo a
  propósito en una copia aislada:
  - sin la restricción que impide citas solapadas, la prueba de carrera concedió dos reservas del mismo espacio (y,
    con diez clientes, las diez) y falló;
  - sin el reintento ante un deadlock, la prueba de reprogramaciones cruzadas recibió un 500 y falló;
  - contando también las citas canceladas, fallaron las pruebas de "cancelar libera el espacio" (I7);
  - sin subir la versión de la agenda en Redis, fallaron las cinco pruebas de invalidación de la caché (I8).
- **La medición de carga es reproducible:** el script está en `tests/load/availability.js` y los resultados, en el
  README (de ~716 consultas por segundo con una copia y sin caché a ~2 415 con tres copias y caché).
- **La bitácora:** la base rechaza `UPDATE`, `DELETE` y `TRUNCATE`, incluso al dueño de las tablas (I6).
- **Los experimentos de la guía de estudio,** sobre la base, comprobando que no dejan cambios.
- **Las mediciones:** la caché antes y después, con k6; el costo del candado del §9; y en Kubernetes, el HPA
  subiendo de 2 a 6 copias y volviendo a bajar.
- **Kubernetes:** que una copia de `agenda` borrada se recrea sola, y que el gateway reparte por prefijo
  (`X-MediCitas-Service`).
- **El failover (paso 4):** con `k8s/failover-test.sh`, seis veces, borrando de golpe el pod de la principal. En todas
  se perdieron cero escrituras confirmadas y la API nunca respondió 500. En Compose, con la base detenida, los tres
  servicios respondieron 503 y volvieron solos al encenderla. Las mediciones encontraron dos cosas que se corrigieron
  o documentaron: PgBouncer tardaba ~13 s de más en volver (se corrigió con `server_login_retry`) y Keycloak tarda en
  recuperarse (límite conocido). También se encontraron y corrigieron tres errores del propio script de medición.
- **RF20:** con tokens reales, el profesional recibe solo su agenda, y 403 al pedir la de otro.
- **La colección completa** (59 peticiones) sobre una base recién creada: cada respuesta tuvo el código esperado.
- **La estabilidad de la suite:** se repitió más de veinte veces seguidas, y la prueba de diez clientes, quince veces
  sola. Al quitar la restricción `EXCLUDE`, la prueba de carrera falla (las diez reservas ganan), así que sigue
  discriminando después del cambio del candado.
- **Antes de cada commit,** el integrante revisaba el reporte de la etapa y el diff.
