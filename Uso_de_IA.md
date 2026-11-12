# Declaración de uso de inteligencia artificial

El enunciado pide declarar cómo se usó la IA, en qué partes y qué se verificó de forma manual. Esta declaración
responde a las tres cosas, y agrega las decisiones que tomó el grupo, para que se distinga la aportación propia de
la de la herramienta.

**Herramienta:** Claude Code (Anthropic), un asistente que trabaja en la terminal con acceso al repositorio, a
Docker y a minikube.

## 1. Cómo se usó

- **La IA propone y el grupo decide.** Antes de implementar, la IA proponía un plan por etapas, y en cada decisión
  explicaba el problema, la opción elegida, las alternativas descartadas y lo que se sacrifica. Esas explicaciones
  quedaron en `docs/diseno-servicios.md` y `docs/comparacion-arquitecturas.md`. Varias propuestas se rechazaron o se
  cambiaron (sección 3).
- **Por etapas, con parada y revisión.** Al terminar cada etapa, la IA se detenía y entregaba un reporte con los
  archivos cambiados, el diff y las decisiones. La IA nunca hizo commits, push, PR ni merges: los hizo cada
  integrante, como muestra el historial de Git.
- **Código escrito por el integrante.** En algunas partes, la IA dejó preparada la estructura y el integrante
  escribió la lógica; después la IA la revisó (ejemplos en la sección 3).
- **Para entender lo generado.** Se construyó `docs/guia-de-estudio.md`: explica cada parte desde lo básico, con
  experimentos que se pueden repetir sobre la base y preguntas de autoevaluación. Cada integrante debe poder
  defender todo el sistema.
- **Verificación aislada.** Todo cambio se probó en una copia aparte de la pila (otro proyecto de Docker, con otros
  puertos), sin tocar la pila local de nadie.
- **Trello.** La IA revisaba el tablero y proponía qué mover, y solo escribía en él con la aprobación de Sebastián.

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

> **Pendiente:** Emmanuel completa esta sección con su uso de IA en sus commits: la traducción de `MC001`–`MC006`,
> el gateway, el arnés de pruebas, RF9 con la prueba de carrera, RF10, RF11–RF13, RF7 y RF8, la caché con su
> medición, y RF20 y RF21.

## 3. Decisiones del grupo

Estas decisiones las tomó el grupo, muchas veces en contra de la primera propuesta de la IA o preguntando por casos
que la propuesta no cubría.

**Sebastián:**
- **La arquitectura.** Pidió separar el sistema en servicios con un schema por servicio, para poder escalar el
  servicio de más demanda (la agenda) sin escalar todo. Cuando la IA empezó a mover tablas a schemas, la detuvo y
  pidió comparar primero las arquitecturas (microservicios contra basada en servicios). Eligió la base única con un
  schema por servicio, y propuso usar réplicas de lectura en Kubernetes, de donde salió el plan de CloudNativePG por
  pasos. También cuestionó si el servicio de citas no quedaba demasiado grande.
- **La reserva es síncrona y transaccional.** Ante la opción de resolver reservas de forma asíncrona, la rechazó:
  "prefiero que una reserva se tenga que hacer dos veces" antes que confirmar una cita que después resulte inválida.
- **Una cita reservada no cambia de duración ni de horario.** Argumentó que un administrador que cambia la duración
  de una cita ya reservada podría sacarla del horario, meterla en un bloqueo o solaparla con la siguiente. Por eso el
  trigger de I4 lo prohíbe (`MC004`).
- **La caché.** Eligió guardar los huecos libres. Antes de aceptar la invalidación por versión, pidió analizar los
  casos extremos: dos escrituras simultáneas que invalidan a la vez, y la posible estampida de consultas a la base.
- **Los `CONNECTION LIMIT`.** Cuestionó que un tope de conexiones contradijera la meta de 200 000 peticiones por
  minuto, y antepuso la escala. Así quedaron los topes calculados con una regla explícita, con PgBouncer delante.
- **Kubernetes sin el paso 4.** Descartó la réplica con failover al cuestionar su costo: un segundo PostgreSQL
  encendido que solo sirve si el primero se cae.
- **El cierre.** Integrar él las ramas de Fabricio, con un PR por rama, en vez de esperar. Las notas clínicas se
  pueden corregir con un `PATCH` que queda en la bitácora. Primero los requisitos funcionales y después Kubernetes. El
  profesional solo ve su propia agenda (RF20), como dice el §2 del enunciado.
- **Código propio.** Escribió los mensajes de `MC001` y `MC003`, y la primera versión de la regla de acceso de las
  notas clínicas (`loadOwnAttendedAppointment`). La IA señaló sus errores (tabla equivocada, un `await` faltante, una
  comparación con `=` y una condición invertida), y se corrigieron juntos.
- **Revisión del diseño de la base.** Pidió justificar restricciones como `uq_users_user_role` con ejemplos, y a raíz
  de esa revisión se quitó un `ON UPDATE CASCADE`.

**El grupo:** eligió el módulo del §9 (auditoría verificable) el 2026-11-10, y se repartió el trabajo ese mismo día.

## 4. Qué se verificó de forma manual

Además de la suite automática (164 pruebas, que pasan en Compose y en Kubernetes), se comprobó a mano, ejecutando y
revisando la salida:

- **El arranque desde un clon limpio**, con `cp .env.example .env` y `docker compose up`, sin pasos manuales.
- **La identidad y el aislamiento:** con `curl`, sin token (401), con un rol sin permiso (403) y pidiendo recursos de
  otra clínica (404).
- **La carrera:** dos `INSERT` simultáneos sobre el mismo espacio dejan una sola cita reservada.
- **Que la prueba de carrera discrimina:** sin la restricción `EXCLUDE`, los diez clientes simultáneos obtenían su
  reserva, y la prueba fallaba.
- **La bitácora:** la base rechaza `UPDATE`, `DELETE` y `TRUNCATE`, incluso al dueño de las tablas (I6).
- **Los experimentos de la guía de estudio,** sobre la base, comprobando que no dejan cambios.
- **Las mediciones:** la caché antes y después, con k6; el costo del candado del §9; y en Kubernetes, el HPA
  subiendo de 2 a 6 copias y volviendo a bajar.
- **Kubernetes:** que una copia de `agenda` borrada se recrea sola, y que el gateway reparte por prefijo
  (`X-MediCitas-Service`).
- **RF20:** con tokens reales, el profesional recibe solo su agenda, y 403 al pedir la de otro.
- **La colección completa** (59 peticiones) sobre una base recién creada: cada respuesta tuvo el código esperado.
- **La estabilidad de la suite:** se repitió más de veinte veces seguidas, y la prueba de diez clientes, quince veces
  sola. Al quitar la restricción `EXCLUDE`, la prueba de carrera falla (las diez reservas ganan), así que sigue
  discriminando después del cambio del candado.
- **Antes de cada commit,** el integrante revisaba el reporte de la etapa y el diff.
