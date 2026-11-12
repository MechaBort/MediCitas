# Diseño de los servicios de MediCitas

> **Diseño aprobado el 2026-11-08, pendiente de implementar.** Lo único ya implementado es la política de Redis
> (`volatile-lru` en `docker-compose.yml`).
>
> Este documento explica **cómo** se construye el enfoque elegido. **Por qué** se eligió está en
> [comparacion-arquitecturas.md](comparacion-arquitecturas.md), igual que el diseño de la caché.

## Vista general

```
                      ┌──────────────┐
  cliente ── token ──►│   Keycloak   │  emite los tokens (RF17)
     │                └──────────────┘
     │ petición + token
     ▼
┌──────────────┐   /clinics /users /services /professionals        ┌─────────┐
│   gateway    │──────────────────────────────────────────────────►│  admin  │──┐
│ (Nginx :3000)│   /schedules /blockades /availability             ├─────────┤  │
│ solo enruta  │   /appointments /agenda /reports ────────────────►│ agenda  │──┤──► PgBouncer ──► PostgreSQL
│              │   /patients /clinical-notes /audit                ├─────────┤  │    (pool)        schemas admin,
│              │──────────────────────────────────────────────────►│clinical │──┘                  agenda y clinical
└──────────────┘                                                   └────┬────┘
                                                                        │ agenda
                                                                        ▼
                                                                   ┌─────────┐
                                                                   │  Redis  │  caché de RF7
                                                                   └─────────┘
```

Cada servicio valida el token por su cuenta, consulta la base y responde. Ningún servicio llama a otro por la
red. PgBouncer se agrega en Kubernetes; Compose usa un PostgreSQL simple.

---

## 1. Servicios

| Servicio | Requisitos | Demanda esperada | Copias en Kubernetes |
|---|---|---|---|
| `admin` | RF1–RF4: clínicas, usuarios, servicios y profesionales | Baja | 1 |
| `agenda` | RF5–RF13, RF16, RF20 y RF21: horarios, bloqueos, disponibilidad, citas, historial, agenda del día y conteos | Alta | Varias, con HPA |
| `clinical` | RF14, RF15, RF18 y RF19: pacientes, notas clínicas y bitácora | Media | Se define con los manifiestos |

La autenticación y la matriz de permisos (RF17) no son un servicio aparte: cada servicio las aplica.

**HPA** (*Horizontal Pod Autoscaler*) es el mecanismo de Kubernetes que agrega o quita copias de un servicio
según su uso de CPU.

**Decisión: `agenda` es un solo servicio, dividido por dentro en módulos.** Los módulos son horarios,
disponibilidad, citas y reportes.

- **Problema.** `agenda` es el servicio más grande. Lo natural sería partirlo en varios.
- **Por qué no se parte.** Reservar exige revisar el horario, los bloqueos y las citas existentes en **una misma
  transacción**. Al terminar, además, hay que invalidar la caché de disponibilidad. Si horarios, citas y
  disponibilidad fueran servicios distintos, cada reserva tendría que llamar a otros servicios por la red. La
  validación dejaría de ser atómica.
- **Alternativa descartada.** Servicios separados de horarios, citas y disponibilidad.
- **Lo que se sacrifica.** `agenda` concentra la mayor parte del código. Los módulos internos lo mantienen
  ordenado, y cada módulo puede convertirse en un servicio el día que haga falta.

**Decisión de la rama `reservas`: los cambios de estado de una cita son rutas de acción (RF11, RF12, RF13).**
- **Problema.** Cancelar y registrar el desenlace cambian el mismo campo, el estado, pero los permite gente
  distinta: cancelar es de recepción y del administrador de clínica (`appointments.manage`), y el desenlace también
  lo registra el profesional (`appointments.outcome`).
- **Elegido.** Dos rutas: `POST /appointments/{id}/cancel` y `POST /appointments/{id}/outcome`. Cada una tiene su
  permiso fijo y su cuerpo (el motivo, o `atendida`/`ausente`), y hace un solo `UPDATE` filtrado por la clínica del
  token. Las reglas de las transiciones no se repiten en el código: el trigger `appointments_check_status` las
  aplica sobre la fila ya bloqueada (`MC002` y `MC003`, los dos 409), así que dos peticiones simultáneas sobre la
  misma cita no pueden pasar las dos.
- **Alternativa descartada.** Un `PATCH /appointments/{id}` con `{ status }`: la ruta tendría que elegir el permiso
  según el cuerpo, y un error ahí dejaría a un profesional cancelar. Tampoco se revisa el estado antes del `UPDATE`,
  porque entre la lectura y la escritura otra petición podría cambiarlo.
- **Lo que se sacrifica.** Un contrato menos "REST puro": son verbos sobre el recurso. RF10 (reprogramar) sigue la misma
  forma, con `POST /appointments/{id}/reschedule`.

**Decisión de la rama `reservas`: la reprogramación reutiliza la reserva y admite cambiar de profesional (RF10).**
- **Problema.** La cita nueva de una reprogramación necesita exactamente las mismas revisiones que una reserva.
  Además, RF10 habla de mover la cita "hacia otro espacio", y RF8 devuelve espacios de varios profesionales para un
  mismo servicio.
- **Elegido.** Las revisiones y el `INSERT` de la reserva pasaron a una función, `insertAppointment`, que usan las
  dos rutas. La reprogramación recibe el nuevo inicio y, opcionalmente, otro profesional que atienda el mismo
  servicio. El paciente y el servicio no cambian.
- **Alternativas descartadas.** Copiar las revisiones en la ruta de reprogramar (una corrección futura quedaría en
  un solo lado). Permitir cambiar el servicio: sería otra cita, con otra duración, y no una reprogramación.
- **Lo que se sacrifica.** La ruta de RF9 cambió de forma, aunque no de comportamiento: sus 13 pruebas pasan sin
  cambios.

**Decisión de `RF3` y `RF4`: alta de profesionales reutilizando `createAccount` y sincronización con baja lógica en tablas puente.**
- **Problema.** Un profesional en MediCitas no es solo un registro de catálogo: también es un usuario que inicia sesión
  en Keycloak (`role_id = 4`), tiene especialidades (`specialties_per_professionals`), contactos
  (`professional_contacts`) y servicios habilitados (`services_per_professionals`), a los cuales apuntan las citas
  mediante una llave foránea compuesta.
- **Elegido.** `POST /professionals` valida primero en PostgreSQL que las especialidades existan y que los servicios
  pertenezcan a la clínica (I5) y coincidan con las especialidades del profesional, antes de tocar Keycloak. Luego
  reutiliza `createAccount` con el rol `professional` e inserta en una sola transacción `users`, `professionals`,
  especialidades, servicios y contactos. Al actualizar las especialidades o los servicios habilitados
  (`PATCH /professionals/{id}` o `PUT /professionals/{id}/services`), las filas que se quitan se marcan con
  `is_active = false` y las que se vuelven a habilitar se reactivan con `ON CONFLICT ... DO UPDATE`.
- **Alternativas descartadas.**
  - Crear primero el usuario en `/users` y después convertirlo en profesional en `/professionals`: dejaría el alta en
    dos pasos manuales y chocaría con la regla de que `/users` solo maneja `clinic_admin` y `reception`.
  - Borrar filas (`DELETE`) en `services_per_professionals` al quitar un servicio: fallaría con `23503` si el
    profesional ya tuvo alguna cita histórica para ese servicio.
- **Lo que se sacrifica.** Las tablas puente conservan filas inactivas (`is_active = false`), por lo que las consultas
  de disponibilidad y reserva filtran siempre por `is_active` (como ya hacían `availability.js` y `appointments.js`).

**Decisión de la rama `agenda-reportes`: la agenda del día y el conteo por estado tienen sus propias rutas (RF20,
RF21).**
- **Problema.** RF20 (la agenda del día) y RF21 (contar citas por estado en un rango) leen las mismas citas que el
  resto de `agenda`, pero con otros permisos: `agenda.read` (los tres roles de clínica) y `reports.read` (solo el
  administrador). Además, `GET /appointments` ya lo usa RF16 (historial de un paciente), con `patient_history.read`.
- **Elegido.**
  - RF20: `GET /agenda?date=…`, con un `professionalId` opcional para ver solo a ese profesional.
  - RF21: `GET /reports/appointments-by-status?from=…&to=…`, también con un `professionalId` opcional.
  - Cada una va en su archivo (`routes/agenda.js` y `routes/reports.js`), bajo prefijos que el gateway ya enviaba
    a `agenda`.
  - **"Las citas del día"** son las que empiezan ese día en la hora local de la clínica. Esa condición sobre
    `lower(period)` es la que pueden usar `ix_appointments_clinic_start` e `ix_appointments_prof_start`.
  - **RF20 muestra todos los estados,** también canceladas y reprogramadas, ordenadas por hora, con los nombres del
    paciente, el profesional y el servicio. No lee los contactos del paciente, que exigirían registrar el acceso en
    la bitácora (RF18).
  - **El profesional ve la agenda de toda la clínica,** porque la matriz le da `agenda.read` sin la variante "solo lo
    propio". Es el mismo criterio que con el desenlace (RF12).
  - **RF21 devuelve los cinco estados, aunque den cero,** y el total.
- **Alternativas descartadas.**
  - `GET /appointments?date=…` para RF20: mezclaría dos permisos en la misma ruta, que ya es de RF16.
  - Mostrar solo las reservadas: recepción perdería de vista las cancelaciones del día.
- **Lo que se sacrifica.** Dos prefijos más en la API, aunque el gateway ya los tenía reservados desde la etapa 5.

**Decisión: RF21 acepta como máximo 366 días; RF8, 31.**
- **Problema.** Las dos reciben un rango de fechas, pero cuestan distinto.
  - RF8 calcula huecos por profesional y día, y devuelve cada espacio. Lo usa recepción todo el día.
  - RF21 hace un solo `COUNT` agrupado sobre las citas que empiezan en el rango, recorriendo el índice
    `ix_appointments_clinic_start`, y siempre devuelve cinco números. Lo usa solo el administrador, de vez en cuando.
- **Elegido.** 366 días, un año completo aunque sea bisiesto. Medido con `EXPLAIN ANALYZE` sobre el seed: un año de
  la clínica de San José (1 444 citas) se cuenta en ~4 ms por el índice. El costo crece con las citas del rango, no
  con los días: una clínica con 40 000 citas al año rondaría los 100 ms. En Kubernetes, con réplica (sección 7), esta
  lectura puede ir al servicio `-ro`.
- **Alternativa descartada.** Sin tope: alguien podría pedir diez años de una sola vez.
- **Lo que se sacrifica.** Para comparar varios años, el cliente hace una consulta por año.

---

## 2. Estructura del repositorio

```
package.json            raíz: define los workspaces
package-lock.json       uno solo para todo el repositorio
packages/
  common/src/           auth.js, db.js y errors.js (antes en app/src)
services/
  admin/                el código que antes estaba en app/, con su Dockerfile
  agenda/               desde la etapa 5, con su Dockerfile; sus rutas llegan en el bloque B
  clinical/             desde la etapa 5, con su Dockerfile; sus rutas llegan en el bloque B
gateway/                desde la etapa 5
  nginx.conf
db/                     sin cambios de ubicación
keycloak/
```

**Decisión: npm workspaces, con un paquete compartido.** Los *workspaces* de npm son varios proyectos dentro de
un mismo repositorio que comparten un solo `package-lock.json`, y cada uno puede usar a los otros como si fueran
dependencias.

- **Problema.** Los tres servicios necesitan exactamente el mismo código de seguridad:
  - validar el token y resolver la identidad;
  - abrir transacciones con `SET LOCAL ROLE` y reintentar ante deadlocks;
  - traducir los errores de la base.

  Si cada servicio tuviera su copia, las copias terminarían siendo distintas, y un arreglo de seguridad podría
  aplicarse solo en una.
- **Regla.** `packages/common` contiene solo seguridad, acceso a la base y errores, **nunca lógica de negocio**.
  Si una regla de citas apareciera ahí, los servicios quedarían acoplados por el código.
- **Alternativas descartadas.**
  - Copiar los archivos en cada servicio: se desalinean.
  - Publicar un paquete privado de npm: agrega un registro y versiones que mantener.
- **Lo que se sacrifica.** Las imágenes de Docker se construyen desde la raíz del repositorio, no desde la
  carpeta del servicio. Además, un cambio en `common` obliga a reconstruir los tres servicios.

**Decisión de la etapa 4: cómo se traducen los errores de la base.**
- **Problema.** Las reglas de negocio las garantiza la base: los triggers abortan con códigos propios
  (`MC001`–`MC006`) y las restricciones `EXCLUDE` con `23P01`. `toResponse` no conocía los códigos propios y los
  respondía como 500. Además, las tres `EXCLUDE` respondían el mismo 409, sin decir con qué fue el choque.
- **Elegido.** Dos tablas en `packages/common/src/errors.js`:
  - `PG_ERRORS`, por el código de error (`err.code`), ahora con los seis códigos propios;
  - `EXCLUSION_ERRORS`, por el nombre de la restricción que falló (`err.constraint`): el choque con el profesional
    (I1, el "espacio ya tomado" de la reserva), con el paciente (I2) y entre bloques de horario. Una restricción
    que no esté en la tabla responde el `23P01` genérico.
- **Criterio del código HTTP.**
  - 4xx cuando la regla rechaza algo que un cliente sí puede pedir: `MC001` → 400 (la "solicitud inválida" de la
    reserva: fuera del horario o dentro de un bloqueo); `MC002`, `MC003`, `MC006` y los `23P01` → 409 (la
    petición está bien formada, pero choca con el estado actual de los datos).
  - 500 para `MC004` y `MC005`. Desde la API son inalcanzables: los `GRANT` los frenan antes con `42501` (403).
    Si llegaran, sería una configuración rota del servidor.
- **Por qué en `common`.** Los códigos vienen de tablas de `agenda` y `clinical`; así, los servicios de la etapa 5
  ya los traducen sin repetir nada.
- **Alternativas descartadas.**
  - **Traducir en cada ruta.** Cada ruta repetiría la tabla, y las copias se desalinean.
  - **Responder el texto del trigger (`err.message`).** Está escrito para desarrolladores e incluye cosas como
    "(I3)". Queda disponible por entrada: con `null` como mensaje se usa ese texto.
- **Bloques de horario solapados.** La ruta de RF5 revisará, antes de insertar, que el bloque no se cruce con otro,
  para dar un buen mensaje en el caso normal. La restricción `ex_schedules_overlap` sigue siendo la garantía:
  si dos ediciones simultáneas pasan esa revisión, la segunda recibe 409.
- **Lo que se sacrifica.** La API depende de los nombres de las restricciones: si se renombra una en
  `01-schema.sql`, hay que cambiar la tabla. Si se olvida, la respuesta cae en el 409 genérico: pierde detalle, pero
  no se rompe. Y `MC001` cubre dos situaciones con un solo mensaje.

---

## 3. Gateway

Un **gateway** es la puerta única de entrada: recibe todas las peticiones y las reenvía al servicio que
corresponde según el inicio de la ruta (el *prefijo*).

| Prefijo de la ruta | Servicio |
|---|---|
| `/clinics`, `/users`, `/services`, `/professionals` | `admin` |
| `/schedules`, `/blockades`, `/availability`, `/appointments`, `/agenda`, `/reports` | `agenda` |
| `/patients`, `/clinical-notes`, `/audit` | `clinical` |

Un prefijo que no está en la tabla responde 404 en el gateway.

RF16 (el historial de un paciente) es una consulta de citas, así que la atiende `agenda` con
`GET /appointments?patientId=…`.

**Decisión: Nginx, y solo enruta.** El mismo `gateway/nginx.conf` se usa en Compose y en Kubernetes, donde se
carga como ConfigMap (un archivo de configuración que Kubernetes monta dentro del contenedor).

- **Problema.** ¿Quién valida el token?
- **Elegido.** Cada servicio, por su cuenta. A esto se le llama **defensa en profundidad**: si alguien llegara a un
  servicio sin pasar por el gateway, por ejemplo desde dentro del clúster, el servicio igual lo rechaza.
- **Alternativa descartada.** Validar solo en el gateway y que los servicios confíen en los encabezados que este
  agrega. Basta un camino que se salte el gateway para que la protección desaparezca por completo.
- **Lo que se sacrifica.** Cada servicio verifica la firma del token. Es barato: las llaves públicas de Keycloak
  se descargan una vez y quedan en memoria.

Keycloak **no** pasa por el gateway: conserva su propia dirección. El campo `iss` (emisor) del token incluye esa
dirección, y si cambiara, todos los servicios rechazarían los tokens.

**Decisiones de la etapa 5: cómo quedó el gateway (`gateway/nginx.conf`).**
- **Mismo puerto que antes.** El gateway escucha en el 3000, el que usaba la API cuando era un solo servicio, así
  que el README y los `curl` no cambian. Los servicios ya no publican puertos: solo se llega a ellos por el gateway.
- **`/me` y `/health` van a `admin`,** donde estaban antes del gateway, para no cambiar el contrato documentado.
  `agenda` y `clinical` tienen su propio `/health`, que usa solo el healthcheck de su contenedor.
- **Cada servicio responde con el header `X-MediCitas-Service`** y su nombre. Sirve para comprobar, desde afuera,
  qué servicio contestó cada ruta; también en la demostración de Kubernetes.
- **Los prefijos de `agenda` y `clinical` ya exigen token, aunque todavía no tengan rutas.** Sin token responden
  401, con el token de la plataforma 403 ("Este servicio no atiende a su rol") y con un usuario válido 404. Así la
  cadena gateway → servicio → identidad se puede probar desde ya.
- **Errores en JSON.** Un prefijo desconocido responde 404 y un servicio caído 503, los dos con el formato
  `{ "error": ... }` del resto de la API, no con las páginas HTML de Nginx.
- **Un servicio caído responde en 2 segundos, no en 60.** Por omisión, Nginx espera hasta 60 s para conectarse a
  un servicio, y en la verificación una petición a `agenda` detenido quedó colgada. Dentro de la red una conexión
  sana tarda milisegundos, así que se fijó `proxy_connect_timeout 2s`: el cliente recibe el 503 enseguida y los
  otros servicios siguen respondiendo.
- **Conexiones reutilizadas.** El gateway mantiene abiertas las conexiones hacia cada servicio (`keepalive`) en vez
  de abrir una por petición. Nginx solo reenvía bytes; su costo por petición es de una fracción de milisegundo y
  una sola copia atiende decenas de miles de peticiones por segundo. El límite de la meta está en la base, no aquí.
- **Los nombres de los servicios se resuelven una vez, al arrancar.**
  - **Por qué.** Así el archivo no depende de la dirección del DNS, que es distinta en Compose y en Kubernetes, y
    se cumple que el mismo archivo sirva en los dos.
  - **Alternativa descartada.** Volver a resolver los nombres cada pocos segundos (`resolver` de Nginx). Obliga a
    escribir la dirección del DNS en el archivo, y se pierde el archivo único.
  - **Lo que se sacrifica.** En Compose, si se recrea el contenedor de un servicio, su dirección puede cambiar (en
    la verificación Docker reutilizó la misma). Si cambia, el gateway responde 503 en esas rutas hasta reiniciarlo
    (`docker compose restart gateway`). En Kubernetes no pasa, porque la dirección de un Service es fija.
- **Réplicas.** En Kubernetes el gateway es un Deployment con dos copias o más detrás de un Service, para que no sea
  un punto único de falla. En Compose basta una.

---

## 4. Identidad y usuarios de base de datos

**Decisión: cada servicio resuelve la identidad leyendo directamente `admin.users`.** Lo hace con la función
`identify`, que ya existe en `auth.js`.

- **Problema.** Cada petición necesita saber de qué clínica es el usuario y qué rol tiene.
- **Alternativa descartada.** Preguntarle al servicio `admin` en cada petición. Con la meta de 3 300 peticiones
  por segundo, `admin` se volvería el cuello de botella del sistema, y si cayera, caería todo.
- **Lo que se sacrifica.** `agenda` y `clinical` dependen de la estructura de la tabla `users`. Si esa tabla
  cambia, hay que revisar los tres servicios.

**Decisión: un usuario de base por servicio.** Antes existía un único usuario de conexión, `mc_app`, que usaban
todas las rutas. Desde la etapa 3 hay uno por servicio (**implementado** en `db/init/00-init.sh`).

| Usuario de base | Perfiles que puede usar con `SET LOCAL ROLE` |
|---|---|
| `mc_admin_svc` | Los cuatro: plataforma, administración de clínica, recepción y profesional |
| `mc_agenda_svc` | Administración de clínica, recepción y profesional |
| `mc_clinical_svc` | Administración de clínica, recepción y profesional |

Conviene distinguir dos cosas: el **usuario** es como el gafete que dice por qué puerta entra cada servicio. El
**perfil** (`mc_reception`, `mc_professional`…) es el uniforme que dice qué puede hacer adentro. Los cuatro
perfiles y sus permisos (`db/sql/02-grants.sql`) **no cambian**.

- **Por qué.**
  - Si se filtra la contraseña de `agenda`, con ella no se pueden usar los permisos de plataforma.
  - En Kubernetes, cada servicio recibe solo su propia contraseña, en su propio Secret (el objeto de Kubernetes
    que guarda contraseñas).
  - Cada usuario tiene un `CONNECTION LIMIT` (un tope de conexiones simultáneas, no de peticiones), para que un
    servicio no pueda acaparar todas las conexiones de la base.
- **Un token de plataforma en `agenda` o `clinical` recibe 403 sin abrir una transacción.** Esos servicios no
  tienen nada que ofrecerle.

**Decisión de la etapa 3: cada servicio le pregunta a la base qué perfiles atiende.**
- **Problema.** `identify` necesita saber qué roles del token atiende el servicio donde corre, para responder 403
  a los demás. El código de `packages/common` es el mismo en los tres servicios.
- **Elegido.** Al llegar la primera petición, `servedDbRoles()` (`packages/common/src/db.js`) consulta
  `pg_has_role(current_user, perfil, 'SET')`. Esa función dice a qué perfiles puede cambiar el usuario conectado.
  El resultado se guarda en memoria y no se vuelve a consultar.
- **Por qué.** La lista vive en un solo lugar, los `GRANT` de `00-init.sh`. Si mañana `agenda` deja de atender a
  algún rol, se cambia el `GRANT` y el código se entera solo.
- **Alternativas descartadas.**
  - **Escribir la lista en el código de cada servicio.** Serían dos copias de la misma regla, la del código y la
    de la base, que pueden desalinearse.
  - **Leerla de una variable de entorno.** Es otra copia más, que además puede quedar mal configurada en Compose o
    en Kubernetes.
- **Lo que se sacrifica.** La primera petición de cada copia hace una consulta extra. Si esa consulta falla, la
  petición responde 500 y la siguiente vuelve a intentarlo.
- **Si el código fallara, la base igual lo impide.** `mc_agenda_svc` no puede hacer `SET LOCAL ROLE mc_platform`:
  la base responde `42501`. El 403 del código es la respuesta limpia; la garantía es la base.

**Decisión de la etapa 3: los topes de conexión.**

| Usuario | Tope | Cuenta |
|---|---|---|
| `mc_admin_svc` | 20 | 1 copia × pool de 10, por 2 |
| `mc_agenda_svc` | 40 | La mayor carga: deja lugar para varias copias, o para el pool de PgBouncer en Kubernetes |
| `mc_clinical_svc` | 20 | 1 copia × pool de 10, por 2 |

- **Regla.** Copias previstas × tamaño del pool (10, en `db.js`), por dos. Se duplica porque, al actualizar un
  servicio, conviven un momento la copia vieja y la nueva.
- **Límite total.** La suma, 80, queda por debajo de las 100 conexiones que PostgreSQL acepta por omisión, y que
  comparte con Keycloak y con las conexiones reservadas al superusuario.
- **En Kubernetes** quien abre las conexiones es PgBouncer, que entra con el usuario de cada servicio. Ahí el tope
  limita el pool real de ese servicio, sin importar cuántas copias tenga.
- **Lo que se sacrifica.** Si `agenda` necesitara más de 40 conexiones reales, la conexión 41 se rechaza
  ("too many connections for role"). Es preferible a que `agenda` deje sin conexiones a `admin` y `clinical`. El
  número se ajusta con la medición de carga.
- **`mc_platform` solo tiene `USAGE` sobre el schema `admin`.** `USAGE` es el permiso para entrar a un schema.
  Así, los permisos de lectura sobre catálogos de otros schemas no le sirven, y eso es a propósito.
- **Lo que se sacrifica.** "Cada servicio solo escribe en su schema" es una **regla del código**, revisada en
  cada PR, y la base no la impone. Por ejemplo, `mc_reception` puede insertar pacientes, y `mc_agenda_svc` puede
  usar ese perfil. Imponerla en la base exigiría perfiles distintos por servicio, doce en lugar de cuatro. Se
  descartó por ahora.

---

## 5. Schemas

| Schema | Tablas |
|---|---|
| `admin` | `clinics`, `users`, `roles`, `permissions`, `permissions_per_roles`, `countries`, `states`, `cities`, `addresses`, `clinics_addresses`, `specialties`, `specialties_per_professionals`, `services`, `services_per_professionals`, `professionals`, `professional_contacts`, `contact_types`, `severities`, `system_errors_logs` |
| `agenda` | `professional_schedules`, `blockades`, `appointment_statuses`, `appointments` |
| `clinical` | `patients`, `patient_contacts`, `genders`, `clinical_notes`, `event_types`, `data_objects`, `audit_logs` |

Son las 30 tablas actuales de `db/sql/01-schema.sql`, sin cambios de columnas. **Implementado en la etapa 2.**

**Los schemas separan servicios, no clínicas.** No hay que confundirlos con el "esquema por tenant" que el README
compara y descarta para el multi-tenancy. Las tres clínicas comparten las mismas tablas de cada schema, y el tenant
sigue siendo la columna `clinic_id`.

**Reglas.**

- **Escritura y lectura.** Cada servicio solo **escribe** en su schema y puede **leer** los demás. Por ejemplo,
  `agenda` lee `admin.services` para saber cuánto dura una cita.
- **Llaves foráneas.** Las que cruzan schemas **se conservan**. Una cita sigue sin poder apuntar a un paciente de
  otra clínica, porque lo impide la base (I5).
- **`search_path`.** Es la lista de schemas donde PostgreSQL busca una tabla cuando no se le indica el schema.
  Decisión de la etapa 2:
  - Cada `CREATE TABLE` nombra su schema, para que el reparto se vea en el propio SQL.
  - El resto del SQL usa nombres simples: cada script de `db/sql/` empieza con
    `SET search_path = admin, agenda, clinical, public`.
  - El usuario de conexión tiene la misma lista (`ALTER ROLE ... IN DATABASE medicitas SET search_path`), así que
    las consultas de la API no cambiaron. La lista pertenece a la sesión, así que sigue vigente después de
    `SET LOCAL ROLE`.
  - Las funciones de los triggers viven en el schema de su tabla y fijan su propia lista (`SET search_path` en la
    función), para no depender de quién dispara el trigger. En `appointments_check_agenda`, que es
    `SECURITY DEFINER`, además es una medida de seguridad: sin esa lista fija, quien la llama podría hacerle leer
    una tabla falsa con el mismo nombre.
  - **Regla que esto impone:** los nombres de tabla son únicos entre los tres schemas.
  - **Alternativa descartada:** escribir el schema en cada mención de cada tabla. Eran cientos de cambios, y cada
    ruta nueva tendría que recordarlo.
- **Un perfil sin `USAGE` no ve el schema.** Para `mc_platform`, `patients` responde "la relación no existe" y
  `clinical.patients` responde "permiso denegado". En los dos casos no lee nada. Además, desde la etapa 3, un token
  de plataforma no llega a `agenda` ni a `clinical`.
- **Errores del sistema.** Solo `admin` escribe en `system_errors_logs`. `agenda` y `clinical` escriben sus errores
  en la salida estándar, que Kubernetes recoge y se consulta con `kubectl logs`.
- **Contactos de pacientes.** `agenda` nunca lee `patient_contacts`. Leer datos de contacto obliga a registrar el
  acceso en la bitácora (RF18), que es de `clinical`.

**Camino de evolución.** Si un día la base no alcanza para `agenda`, ese schema se puede mover a su propio
servidor (el enfoque 2 de la comparación). Las fronteras ya están marcadas, así que se sabe exactamente qué
tablas mover y qué llaves foráneas se pierden.

---

## 6. Cómo escala: la meta de 200 000 peticiones por minuto

La meta de diseño es de unas **3 300 peticiones por segundo**. Ninguna pieza sola las aguanta: el diseño las
reparte en capas.

1. **Copias de los servicios.** Los servicios no guardan estado propio, así que se pueden ejecutar tantas copias
   como haga falta. El HPA de `agenda` las agrega según la carga.
2. **Redis.** Responde la mayoría de las consultas de disponibilidad (RF7), que es la consulta más frecuente, sin
   tocar PostgreSQL.
3. **PgBouncer.** Es un intermediario que reúne las muchas conexiones de todas las copias en unas pocas conexiones
   reales a PostgreSQL. Funciona en **modo transacción**: presta una conexión real solo mientras dura una
   transacción.
4. **PostgreSQL.** Recibe solo el trabajo que no se pudo evitar.

¿Por qué no abrir más conexiones a la base? Medimos una consulta tipo RF7 con pgbench en una laptop de 8 núcleos:

| Conexiones | Consultas por segundo |
|---|---|
| 1 | ~1 700 |
| 10 | ~6 600 |
| 50 | ~5 000 |

Con 50 conexiones se atiende **menos** que con 10, porque cada conexión es un proceso que compite por la CPU y la
memoria. Por eso se usan pools pequeños por copia y PgBouncer delante.

**Regla que impone PgBouncer.** Nunca se usa `SET ROLE` sin `LOCAL`. En modo transacción, la conexión real pasa a
otra petición al terminar la transacción. Un `SET ROLE` normal quedaría pegado a esa conexión, y la siguiente
petición heredaría los permisos de la anterior. `SET LOCAL ROLE`, que ya usa `withTransaction`, termina con la
transacción.

**Cómo seguir creciendo.**

- **Réplicas de lectura** para los reportes, que se agregan en el paso de failover de la sección 7.
- **Mover `agenda` a su propio servidor**, como explica la sección 5.
- **Repartir las clínicas entre varios servidores**, usando `clinic_id` como criterio. A esto se le llama
  *sharding*. El modelo ya está preparado: todas las tablas tienen `clinic_id`, y las llaves compuestas lo
  incluyen.

Las cifras de la tabla miden solo la base. La medición de punta a punta de RF7 (gateway, `agenda` y base, con k6)
está en el README, sección "Medición de carga de RF7". Sin caché y con una sola copia de `agenda`, se atienden unas
716 consultas por segundo, con un p95 de 111 ms. El límite es `agenda`: un proceso de Node aprovecha un solo núcleo,
y llegó a ~110 % de CPU mientras PostgreSQL usaba ~270 %.

Con tres copias de `agenda` y sin caché, se atienden unas 1 714 por segundo, pero la base pasa a usar ~820 % de CPU:
al agregar copias, la base se convierte en el recurso que se satura. Con la caché de RF7 (sección 8), las mismas tres
copias atienden unas 2 415 por segundo con un p95 de 37 ms, y la base baja a ~560 %. Es decir, la base hace la mitad
del trabajo por consulta.

La meta de 3 300 por segundo se alcanza combinando las dos cosas: varias copias de `agenda` (el HPA de Kubernetes),
porque cada una está limitada por su CPU, y la caché, que evita que la base se sature al agregarlas.

---

## 7. PostgreSQL en Kubernetes: CloudNativePG por pasos

Un **operador** es un programa que vive dentro de Kubernetes y sabe administrar una aplicación concreta.
CloudNativePG administra PostgreSQL:

- crea las instancias;
- configura la replicación;
- y, si la principal cae, promueve una réplica. A eso se le llama **failover**.

Se describe en un recurso `Cluster`, y PgBouncer en un recurso `Pooler`.

| Paso | Qué se despliega | Qué se gana |
|---|---|---|
| Primero | `instances: 1` más un `Pooler` en modo transacción | La base y PgBouncer desde el primer despliegue |
| Después | `instances: 2`: una principal y una réplica | Failover automático y lecturas en la réplica |

Con réplica, el operador crea dos direcciones: `-rw`, que lleva a la principal, y `-ro`, que lleva a las
réplicas. La réplica puede ir unos instantes atrasada respecto a la principal, así que:

- **Van a la réplica (`-ro`)** solo los reportes: RF19 (consulta de la bitácora) y RF21 (conteo por estado), que
  toleran ese atraso.
- **Van siempre a la principal (`-rw`):**
  - RF7, porque mostrar como libre un espacio ya tomado viola I8;
  - todas las escrituras;
  - toda lectura que además escribe en la bitácora.

**Compose no cambia:** sigue con un PostgreSQL simple. Compose y Kubernetes no corren a la vez ni comparten
datos.

### Decisiones del paso 1 (`feat/k8s-postgres`, 2026-11-12)

Los manifiestos están en `k8s/`, numerados en el orden en que se aplican, y `k8s/deploy.sh` los aplica todos con un
solo comando.

**Decisión: el operador CloudNativePG, en una versión fijada (1.30.1).**
- **Problema.** PostgreSQL en Kubernetes necesita un disco que sobreviva al pod, contraseñas y direcciones estables y,
  en el paso 4, una réplica con failover. Hacerlo a mano con un StatefulSet es mucho trabajo y fácil de equivocar.
- **Elegido.** CloudNativePG 1.30.1, instalado con `kubectl apply` desde su manifiesto oficial, sin Helm. La versión
  queda fija en `k8s/deploy.sh`, para que cada despliegue sea igual. Trae PostgreSQL 18, la misma versión mayor que
  Compose.
- **Lo que se sacrifica.** Una pieza más dentro del clúster, el operador, con sus propios recursos (CRDs).

**Decisión: la base se inicializa con el mismo `db/init/00-init.sh` de Compose, en un Job.**
- **Problema.** El operador ofrece `postInitApplicationSQL`, pero solo ejecuta SQL como superusuario. Nuestro script
  crea los roles como superusuario y después ejecuta `db/sql/*.sql` como `mc_owner`, para que `mc_owner` sea el dueño
  de todo y las funciones `SECURITY DEFINER` corran como `mc_owner`, no como superusuario.
- **Elegido.** Un Job (`k8s/11-db-init-job.yaml`), un pod que corre hasta terminar, ejecuta ese mismo script contra
  `medicitas-db-rw`. Entra como superusuario, con el Secret que crea el operador porque el Cluster tiene
  `enableSuperuserAccess: true`. `k8s/deploy.sh` monta el script y `db/sql/` como ConfigMaps, generados desde los
  archivos del repositorio.
  - **Cambio mínimo en el script.** El bucle de `db/sql` usa la contraseña de `mc_owner` (`PGPASSWORD`), porque en
    Kubernetes se entra por la red y no por el socket local. La marca de "inicialización completa" puede ir a otra
    ruta (`MEDICITAS_INIT_MARKER`). Compose no cambia de comportamiento.
  - **Se puede repetir.** Si `mc_owner` ya existe, el Job no hace nada. Así `deploy.sh` se puede volver a correr.
- **Alternativas descartadas.**
  - `postInitApplicationSQL` con `SET ROLE mc_owner` al principio de cada archivo: duplicaría los roles y los GRANT
    en dos lugares, y los objetos quedarían con otro dueño.
  - El recurso `DatabaseRole` de la 1.30, para declarar los roles: es otra fuente distinta de `00-init.sh`, y no
    cubre el `ALTER ROLE … SET search_path` ni los `GRANT … WITH INHERIT FALSE, SET TRUE`.
- **Lo que se sacrifica.** El operador crea además una base `app`, que no se usa.

**Decisión: PgBouncer (Pooler) con 2 copias y 10 conexiones reales por usuario y copia.**
- **Problema.** Con el HPA, `agenda` puede tener muchas copias, y cada una abre hasta 10 conexiones (el pool de
  `packages/common/src/db.js`). Si cada copia se conectara directo a PostgreSQL, 8 copias de `agenda` ya superarían su
  `CONNECTION LIMIT` de 40. Además, más conexiones no significan más capacidad (sección 6).
- **Elegido.** Los servicios se conectan a `medicitas-db-pooler-rw` (PgBouncer, en modo transacción), y Keycloak, el
  Job y las pruebas, directo a `medicitas-db-rw`.
  - **2 copias de PgBouncer,** para que no sea un punto único de falla.
  - **`default_pool_size: 10`.** Cada par (usuario, base) usa como máximo 10 conexiones reales por copia, es decir,
    20 en total. Eso cabe en los `CONNECTION LIMIT` (admin 20, agenda 40, clinical 20) y suma 60 de las 100 de
    `max_connections`; el resto queda para Keycloak y el superusuario.
  - **`max_client_conn: 1000`.** Alcanza para 100 copias de `agenda` con su pool de 10. Las conexiones de clientes
    son baratas: PgBouncer las atiende sin abrir conexiones reales.
- **Por qué funciona con nuestro código.** El modo transacción presta una conexión real solo mientras dura una
  transacción. `withTransaction` usa `SET LOCAL ROLE`, que termina con el COMMIT, y el `search_path` es una
  propiedad del rol (`ALTER ROLE … IN DATABASE`), así que se aplica a cada conexión real que PgBouncer abre para ese
  usuario.
- **Autenticación.** La configura el operador: crea el usuario `cnpg_pooler_pgbouncer` y la función `user_search` en
  la base `postgres`, con la que PgBouncer verifica las contraseñas.
- **Lo que se sacrifica.**
  - Las conexiones reales de `agenda` quedan topadas en 20, aunque su `CONNECTION LIMIT` sea 40. Se puede subir más
    adelante con medición.
  - En modo transacción no funcionan los `SET` de sesión ni los avisos (`LISTEN/NOTIFY`); el código no usa ninguno.

### Decisiones del paso 2 (`feat/k8s-services`, 2026-11-12)

**Decisión: un Deployment y un Service por componente, con los mismos nombres que en Compose.**
- **Elegido.** `k8s/20-redis.yaml`, `21-keycloak.yaml`, `30-admin.yaml`, `31-agenda.yaml`, `32-clinical.yaml` y
  `40-gateway.yaml`, cada uno con su Deployment (las copias) y su Service (el nombre fijo con que se encuentran).
  - Como los Services se llaman igual que los servicios de Compose (`admin`, `agenda`, `clinical`, `keycloak`,
    `redis`), `gateway/nginx.conf` y las variables de entorno son las mismas en los dos entornos.
  - **Copias:**
    - `agenda` empieza con 2, por ser el de más demanda (el HPA llega en el paso 3);
    - el gateway tiene 2, para que no sea un punto único de falla;
    - `admin`, `clinical`, Keycloak y Redis tienen 1.
- **Lo que se sacrifica.** Keycloak y Redis con una sola copia son puntos únicos de falla. Para Redis es aceptable:
  si cae, `agenda` consulta PostgreSQL. Para Keycloak, una caída impide pedir tokens nuevos, pero los ya emitidos
  siguen sirviendo, porque los servicios guardan sus llaves (JWKS).

**Decisión: las imágenes se construyen dentro de minikube, sin registro.**
- **Problema.** Kubernetes descarga las imágenes de un registro (como Docker Hub), y las nuestras solo existen en la
  laptop.
- **Elegido.** `deploy.sh` usa `minikube docker-env` para construir con el Docker de minikube, con los mismos
  Dockerfile que Compose, y los Deployments usan `imagePullPolicy: Never`.
  - Cada Deployment lleva una anotación con el id de su imagen (`medicitas/image-id`). Si el código cambia, el id
    cambia y Kubernetes reemplaza las copias. Si no cambia, no las toca.
  - El gateway hace lo mismo con un resumen (hash) de `nginx.conf`.
- **Alternativa descartada.** Publicar las imágenes en un registro: exige cuentas y credenciales, y no aporta nada en
  una demostración local.
- **Lo que se sacrifica.** Los manifiestos de los servicios tienen un marcador (`__IMAGE_ID__`) que reemplaza
  `deploy.sh`, así que se aplican con el script y no con `kubectl apply` directo.

**Decisión: un Secret por componente.**
- Cada servicio recibe solo la contraseña de **su** usuario de base, más lo propio de cada uno: el secreto del cliente
  de Keycloak en `admin`, y la contraseña de Redis en `agenda`.
- Si se filtra el Secret de `clinical`, no sirve para entrar como `admin`. Es el mismo principio de menor privilegio
  que tienen los usuarios de base.

**Decisión: dos sondas distintas en cada servicio.**
- **Elegido.**
  - La de **disponibilidad** (`readinessProbe`) consulta `/health`, que revisa la base: si la base no responde, esa
    copia deja de recibir tráfico.
  - La de **vida** (`livenessProbe`) solo revisa que el proceso escuche en su puerto.
- **Por qué no usar `/health` en las dos.** Si la base cayera, Kubernetes reiniciaría todas las copias una y otra vez
  sin arreglar nada, y además las desconectaría justo cuando la base volviera.

**Decisión: Keycloak se conecta directo a la base y con un pool de 20.**
- **Directo, no por PgBouncer.** Keycloak usa sentencias preparadas y su propio pool, que no funcionan bien con
  PgBouncer en modo transacción.
- **Con un pool de 20** (`KC_DB_POOL_MAX_SIZE`). El de fábrica llega a 100, que por sí solo podría agotar
  `max_connections`. Con 20, la suma con los pools de PgBouncer (60) queda por debajo de 100.

**Decisión: se entra con `kubectl port-forward`, y la suite corre dentro del clúster.**
- **Cómo se entra.** `port-forward` abre `localhost:3000` (el gateway) y `localhost:8080` (Keycloak). El emisor de
  los tokens sigue siendo `http://localhost:8080/realms/medicitas`, como en Compose, y los `curl` del README sirven
  sin cambios.
- **La evidencia.** `k8s/run-tests.sh` corre **la misma suite de `npm test`** en un Job dentro del clúster, contra el
  gateway de Kubernetes.
- **Alternativa descartada.** Un Ingress con un dominio propio: exige configurar DNS o `/etc/hosts`, y cambiaría el
  `iss` de los tokens.

### Decisiones del paso 3 (`feat/k8s-hpa`, 2026-11-12)

**Decisión: el HPA de `agenda` va de 2 a 6 copias, según la CPU (`k8s/50-agenda-hpa.yaml`).**
- **Cómo funciona.** El HPA (HorizontalPodAutoscaler) compara la CPU que usan las copias, medida por
  `metrics-server`, con la CPU que cada una tiene reservada (250m, su *request*). Si el promedio pasa del 70 %,
  agrega copias; si baja, las quita.
- **Mínimo 2,** para que siempre quede una copia atendiendo si otra muere o se reemplaza.
- **Máximo 6, por la CPU.** minikube tiene 6 CPUs para todo, y más copias de `agenda` solo competirían con la base.
  Las conexiones no son el límite: los clientes de PgBouncer son baratos (1000 por copia). En un clúster real, el
  máximo se sube junto con los nodos.
- **Sube rápido y baja con calma.** Puede duplicar las copias cada 15 s. Para bajar, espera 60 s de baja carga y
  quita una copia cada 20 s, para no agregar y quitar copias ante una carga que va y viene. El valor de fábrica son
  300 s; con 60 s se ve en la demostración.
- **El Deployment de `agenda` ya no fija `replicas`.** Si lo hiciera, cada `kubectl apply` devolvería el número a
  ese valor y pelearía con el HPA. La primera vez que se aplica el cambio, `agenda` queda unos segundos en 1 copia,
  hasta que el HPA la sube a 2.

**Hallazgo de la medición: con un solo PgBouncer compartido, escalar empeoraba las cosas.**
- **Qué se midió.** Con `k8s/load-test.sh` (k6 dentro del clúster, 100 usuarios simultáneos sobre RF7, 60 s), con
  el pool de 10 conexiones reales por copia de PgBouncer:

  | Copias fijas de `agenda` | Consultas por segundo | p95 |
  |---|---|---|
  | 2 | ~752 | 194 ms |
  | 6 | ~558 | 346 ms |

- **Por qué.** `agenda` usaba sus 20 conexiones reales, y la mayoría estaba en estado *idle in transaction*: la
  transacción abierta, esperando la siguiente instrucción de `agenda`. Cada consulta de RF7 abre una transacción
  aunque los huecos salgan de la caché, porque valida el profesional y el servicio en la base. Eso son 4 viajes de
  ida y vuelta: `BEGIN`, `SET LOCAL ROLE`, la consulta y `COMMIT`. Las 20 conexiones se llenaban por **latencia**, no
  por trabajo de la base, y agregar copias de `agenda` solo alargaba la fila frente a PgBouncer.
- **Prueba de la causa.** Con 20 conexiones por copia de PgBouncer, las mismas 6 copias atendieron ~793 por segundo
  (p95 213 ms).

**Decisión: un Pooler propio para `agenda`, con 18 conexiones reales por copia (`k8s/13-postgres-pooler-agenda.yaml`).**
- **Por qué no subir el pool del Pooler compartido.** `admin` y `clinical` también podrían abrir 2 × 20 = 40
  conexiones reales, el doble de su `CONNECTION LIMIT`, y bajo carga fallarían.
- **Elegido.** `agenda` usa `medicitas-db-pooler-agenda`, con 2 × 18 = 36 conexiones reales. `admin` y `clinical`
  siguen en `medicitas-db-pooler-rw`, con 2 × 10 = 20 cada uno.
- **Por qué 18 y no 20.** Con 2 × 20 = 40, justo el `CONNECTION LIMIT`, no quedaba margen. En la medición, una sola
  conexión sobrante de `mc_agenda_svc` en el Pooler compartido hizo fallar al nuevo con `too many connections for role`
  (53300), y la API respondió 500 en 3 de 134 429 consultas. Con 36 quedan 4 de margen. **Regla:** el pool nunca debe
  igualar el `CONNECTION LIMIT`; siempre tiene que quedar margen.
- **`max_connections` sube de 100 a 150,** solo en Kubernetes. La cuenta: 36 (`agenda`) + 20 (`admin`) + 20
  (`clinical`) + 20 (Keycloak) = 96, más margen para el operador y el superusuario. Compose sigue con 100, porque
  ahí cada copia se conecta directo.
- **Lo que se sacrifica.** Dos Poolers más que mantener, y algo más de memoria en PostgreSQL por las conexiones
  extra.
- **Mejora que queda para después.** Juntar `BEGIN` y `SET LOCAL ROLE` en un solo viaje dentro de `withTransaction`
  (`packages/common/src/db.js`) le quitaría un 25 % de los viajes a cada consulta. No se hizo ahora porque ese archivo
  lo usan todos los servicios, y el código ya está congelado para el sábado.

**Resultado con el HPA y el Pooler propio:** con `./k8s/load-test.sh` (100 usuarios durante 3 minutos, 2026-11-12):
  - el HPA subió `agenda` de 2 a 4 copias y de 4 a 6 en unos 30 s, cuando la CPU pasó del 300 % de lo reservado;
  - al terminar la carga, esperó 60 s y quitó una copia cada 20 s;
  - k6 hizo 135 577 consultas, **todas correctas**, a ~753 por segundo, con un p95 de 200 ms y el 99,89 % servido desde
    la caché;
  - PostgreSQL no rechazó ni una conexión por límite (`too many connections`);
  - y la suite completa pasó 163 de 163 dentro del clúster.

**Lo que mide y lo que no.** En minikube, todo corre en una laptop de 8 núcleos que comparte la CPU con k6, la base y
lo demás. Las cifras sirven para comparar entre sí, no como la capacidad de un clúster real. Lo que esta medición
demuestra es el **mecanismo**: el HPA detecta la carga, agrega copias y las quita cuando la carga baja, sin que el
cuello de botella se mueva a las conexiones de la base. Llegar a la meta de 3 300 consultas por segundo exige más
nodos, no más copias en un solo nodo.

---

## 8. Caché de disponibilidad

Está explicada en [comparacion-arquitecturas.md](comparacion-arquitecturas.md#decisión-caché-de-disponibilidad-rf7):

- se guardan los huecos libres por profesional y día;
- se invalida subiendo una versión por agenda, después del COMMIT;
- Redis usa la política `volatile-lru`;
- si Redis falla, se consulta PostgreSQL.

**Decisión de la rama `reservas`: la función que sube la versión llega antes que la caché.**
- **Problema.** La caché se lee en RF7, que llega después, pero las rutas que cambian una agenda empiezan a
  existir antes: la reserva (Emmanuel) y los horarios y bloqueos (Simso). Si cada ruta escribiera su propio
  `INCR`, la regla quedaría repartida y alguna lo olvidaría.
- **Elegido.** Una sola función, `bumpAgendaVersion({ clinicId, professionalId, firstDay, lastDay })`, en
  `services/agenda/src/agenda-version.js`. Sube `ver:{clínica}:{profesional}:{fecha}` de cada día del periodo, con
  las fechas en la hora local de la clínica. Toda ruta que cambia una agenda la llama después del COMMIT y antes de
  responder.
- **Si Redis no responde,** el cambio ya está confirmado en la base, que es la fuente de verdad: se registra el error
  y la petición responde normalmente. El cliente usa `disableOfflineQueue`, así que un comando sin conexión falla
  en milisegundos en vez de quedar esperando. La copia vieja de ese día deja de leerse, a más tardar, cuando vence
  (60 s; ver la decisión del vencimiento en `comparacion-arquitecturas.md`, "Si Redis falla").

**Decisión de la rama `cache-redis`: cómo se lee la caché (RF7, RF8).**
- **Problema.** La copia de un día debe ser siempre la que corresponde a la versión vigente de esa agenda (I8), aunque
  una reserva se confirme a la mitad de una consulta.
- **Elegido.** Tres pasos, en este orden (`services/agenda/src/availability-cache.js`):
  1. **Redis, antes de la base.** `readCachedGaps` lee las versiones vigentes de los pares (profesional, día) y
     después las copias de esas versiones, en dos `MGET`.
  2. **La base, solo para lo que falte.** RF7 hace una sola transacción, con la validación y el cálculo de los pares
     que faltaron (`computeGaps`, que reutiliza `freeGaps`). RF8 necesita los profesionales para saber qué pares
     leer, así que valida en una transacción y calcula lo que falte en otra.
  3. **Después del COMMIT, se guarda.** `storeGaps` guarda lo calculado con la versión leída en el paso 1, con
     vencimiento de 60 s. Los días sin huecos también se guardan, como lista vacía.
- **Por qué este orden.** Si una consulta lee la base justo antes de que se confirme una reserva, la versión que leyó
  antes es la vieja, así que guarda el dato viejo con el número viejo. La reserva sube el número después de su COMMIT,
  y nadie vuelve a leer esa copia. Si la versión se leyera después de la base, el dato viejo podría quedar guardado con
  el número nuevo.
- **Lo que no cambió.** La validación del profesional, el servicio y la duración sigue consultando la base en cada
  consulta. Son búsquedas por índice, y así un profesional dado de baja deja de mostrar espacios de inmediato. Si se
  guardara en caché, `admin` (que cambia esos datos con RF3 y RF4) tendría que invalidar una caché de `agenda`.
- **Alternativas descartadas.** Las de `comparacion-arquitecturas.md`: borrar la copia al reservar, actualizarla al
  reservar, o un candado.
- **Lo que se sacrifica.** En una consulta que no encuentra la copia, RF8 hace dos transacciones en lugar de una.

**Decisión de la rama `cache-redis`: el header `X-MediCitas-Cache`.**
- **Problema.** Sin una señal en la respuesta, una prueba no puede distinguir si la caché funciona. La prueba de I8
  pasaba igual con caché y sin ella, porque solo miraba los espacios.
- **Elegido.** RF7 y RF8 responden `X-MediCitas-Cache: hit | miss | off`. Las pruebas comprueban la secuencia
  `miss`, `hit`, cambio, `miss`, y k6 cuenta los aciertos.
- **Alternativas descartadas.** Ponerlo en el cuerpo, que mezcla un detalle interno con el contrato de la API. Leer
  las estadísticas de Redis, que dan el total pero no el de cada petición.
- **Lo que se sacrifica.** La respuesta revela un detalle interno, pero no expone ningún dato.

**Decisión de la rama `cache-redis`: la conexión a Redis tiene su propio archivo.**
- **Problema.** La conexión la creaba `agenda-version.js`, y ahora también la usa la caché.
- **Elegido.** La conexión se movió sin cambios a `services/agenda/src/redis.js` (`redis` y `closeRedis`), de donde
  la importan las versiones y la caché.
  - `agenda-version.js` conserva `versionKey`, `bumpAgendaVersion` y `daysBetween`.
  - Para las rutas de horarios y bloqueos no cambia nada.
- **Alternativas descartadas.**
  - Una segunda conexión, con la configuración repetida.
  - Exportar el cliente desde `agenda-version.js`, que haría depender la caché del módulo de versiones solo para
    conectarse.

**Decisión de la rama `reservas`: la base calcula los huecos y el servicio los corta en espacios (RF7, RF8).**
- **Problema.** RF7 es la consulta más frecuente del sistema y la que va a usar la caché. Hay que decidir dónde se
  hace cada parte del cálculo, y qué unidad se guarda en la caché.
- **Elegido.** Dos pasos.
  - **En la base, una sola consulta** (`services/agenda/src/availability.js`) devuelve los huecos libres de cada
    profesional y día: el horario, menos los bloqueos y menos las citas reservadas, restados como rangos múltiples
    (`range_agg` y la resta de `tstzmultirange`). Empieza por los horarios, así que un día sin horario no cuesta
    nada. Usa los índices GiST que ya existían: el del `EXCLUDE` de horarios, el de bloqueos y el del `EXCLUDE` de
    citas reservadas.
  - **En el servicio, una función pura** (`services/agenda/src/slots.js`) corta esos huecos en espacios seguidos
    del largo del servicio, desde el inicio de cada hueco, y descarta los que ya empezaron.
  - La unidad es (profesional, día local de la clínica), la misma que la versión de agenda. La caché guarda los
    huecos de cada par una sola vez, y cada servicio los corta con su propia duración. RF8 usa la misma
    función para todos los profesionales del servicio y todos los días del rango.
- **Alternativas descartadas.**
  - Cortar en SQL con `generate_series`: la caché tendría que guardar una copia por profesional, día **y
    servicio**, y una reserva tendría que invalidarlas todas.
  - Traer horarios, bloqueos y citas al servicio y restarlos en JavaScript: viajarían más filas por la red y habría
    que reimplementar la aritmética de rangos, que PostgreSQL ya hace bien.
  - Una grilla fija (por ejemplo, cada 15 minutos): da más opciones, pero deja huecos inútiles entre citas.
- **Lo que se sacrifica.** Los espacios se alinean al inicio de cada hueco. Si una cita de 20 minutos queda en
  medio de una mañana con espacios de 30, los espacios que siguen se corren 20 minutos.

**Decisión: RF8 acepta como máximo 31 días.**
- **Problema.** El costo de RF8 crece con los profesionales por los días. Sin tope, una sola petición de un año
  para un servicio con diez profesionales (unos 2 500 días con horario) costaría lo que cientos de peticiones
  normales. Además, llenaría Redis con copias que nadie vuelve a leer.
- **Elegido.** Un rango de más de 31 días responde 400. Alcanza para consultar un mes completo.
- **Alternativas descartadas.** No poner tope. Paginar la respuesta, que protege igual, pero agrega código y es más
  difícil de explicar.
- **Lo que se sacrifica.** Para ver más de un mes, el cliente hace varias consultas.

---

## 9. Pruebas

> **Arnés montado en la etapa 6.** Ver "Decisiones de la etapa 6" al final de esta sección.

- **Un solo comando.** `npm test`, desde la raíz, ejecuta las pruebas unitarias y las de integración. Las de
  integración corren contra la pila real de Compose, entrando por el gateway, como lo exige el enunciado.
- **Cada ruta llega con su prueba** en el mismo PR. Una tarjeta de RF o de invariante pasa a "Aprobados" en el
  Trello solo cuando su prueba pasa.
- **Pruebas obligatorias:**
  - **Carrera:** dos clientes reservan el mismo espacio a la vez y solo uno lo obtiene.
  - **Fuga:** el usuario de una clínica intenta leer o usar recursos de otra, también manipulando parámetros, y
    recibe 404.
  - **Invariantes:** al menos una prueba por cada invariante, de I1 a I8.
  - **Caché:** consultar, reservar y volver a consultar.
  - **Carga:** una medición frente a la meta de la sección 6.

**Decisiones de la etapa 6: el arnés de pruebas.**
- **Herramienta: `node:test`,** el ejecutor de pruebas que trae Node, con `assert` y el `fetch` también incluidos.
  No agrega dependencias y entiende módulos ES sin configuración. Se descartaron Jest y Vitest: suman dependencias
  y configuración para algo que Node 24 ya resuelve, y Jest todavía tiene fricciones con los módulos ES.
- **Dos tipos de prueba.**
  - **Unitarias**, junto al código que prueban (`packages/common/test/`), sin la pila: la traducción de errores de
    la etapa 4, `parse` y la validación del rol de `withTransaction`.
  - **De integración**, en `tests/integration/`, contra el gateway y con tokens reales de Keycloak. Las
    utilidades comunes (pedir un token, llamar a la API, generar nombres únicos) están en `helpers.js`.
- **Un comando, dos formas de ejecutarlo.**
  - `npm test`, para el equipo. Requiere Node 24 y `npm ci`, y la pila arriba.
  - `docker compose --profile test run --rm tests`, para el evaluador. Corre las mismas pruebas dentro de un
    contenedor, así que solo necesita Docker, y levanta la pila si no está arriba. El *profile* hace que ese
    servicio no arranque con un `docker compose up` normal.
  - **Lo que se sacrifica:** un Dockerfile más que mantener (`tests/Dockerfile`), que copia los `package.json` de
    los tres servicios por nombre. A cambio, la evaluación no depende de la versión de Node del evaluador.
- **Direcciones configurables.** `API_URL` y `KEYCLOAK_URL`, por defecto `localhost:3000` y `localhost:8080`. Así
  las mismas pruebas corren contra la pila local, contra una copia aislada o dentro del contenedor.
- **Datos sin preparación manual.** Las pruebas leen los usuarios fijos del seed y del realm. Lo que crean lleva un
  sufijo único por corrida, así que se pueden repetir; solo modifican lo que ellas mismas crearon.
  - **Lo que se sacrifica:** no borran lo que crean, así que la base y Keycloak acumulan registros de prueba hasta
    un `docker compose down -v`. Borrarlos exigiría operaciones de borrado que el dominio no tiene, porque la baja
    de usuarios es lógica.
- **Pila apagada.** Cada archivo de integración revisa primero `/health`; si no responde, falla con un mensaje que
  dice cómo levantarla, en vez de mostrar decenas de errores de conexión.
- **Trazabilidad.** El nombre de cada prueba empieza con los requisitos e invariantes que cubre (por ejemplo,
  `RF2, RF17: recepción no gestiona usuarios`).

**Decisión de la rama `reservas`: las pruebas preparan y verifican datos con una conexión directa a la base.**
- **Problema.** La prueba de carrera necesita un "último espacio" controlado: un bloque de horario del tamaño exacto
  de un servicio. La ruta para crear horarios (RF5) todavía no existe, y aunque existiera, el enunciado pide
  comprobar que quedó **una sola fila en la base**, algo que la API no expone.
- **Elegido.** `tests/integration/db.js` abre una conexión como `mc_owner` (`TEST_DATABASE_URL`) solo para
  **preparar** (crear un bloque de horario o un bloqueo en un día lejano y único por prueba) y para **verificar**
  (contar las citas reservadas). La operación que se prueba, la reserva, siempre pasa por la API.
- **Por qué se queda aunque llegue RF5.** Con RF5, los horarios podrán crearse por la API, pero la verificación en la
  base y la prueba del módulo del §9 (alterar la bitácora como dueño) siguen necesitando esta conexión.
- **Alternativa descartada.** Esperar la ruta de RF5: habría bloqueado la prueba de carrera, que nunca se recorta.
- **Lo que se sacrifica.** Las pruebas necesitan la contraseña del dueño de las tablas (solo de desarrollo) y
  conocen la estructura de algunas tablas.
- **La prueba de carrera discrimina.** Se verificó quitando la restricción `ex_appointments_professional` en una
  copia aislada: con ella, siempre hay una sola reserva; sin ella, la API concedió las dos (`[201, 201]`) y, con diez
  clientes, las diez. La prueba falla si se quita lo que garantiza I1. La salida de `npm test` sirve así de base para el informe de pruebas que pide el enunciado.

**Decisión de RF5 y RF6 (`feat/schedules-blockades`): horarios y bloqueos en hora local, detección de conflictos sin cancelación e invalidación tras el `COMMIT`.**
- **Problema.** Los bloques de horario (`RF5`) y los bloqueos de agenda (`RF6`) se definen en la fecha y hora local
  de cada clínica (`YYYY-MM-DD`, `HH:MM`), pero en la base viven como `tstzrange` de instantes absolutos. Además,
  `RF6` exige que un bloqueo sobre citas ya reservadas no las cancele, sino que las marque como conflictos, y
  cualquier cambio de horario o bloqueo debe invalidar las copias de disponibilidad de `RF7` (`I8`).
- **Elegido.**
  - Conversión en PostgreSQL usando `clinics.time_zone`: `tstzrange(($date + $startTime) AT TIME ZONE c.time_zone, ($date + $endTime) AT TIME ZONE c.time_zone)`.
  - Autorización de dos niveles (`RF17`): `schedules.manage` permite al administrador de clínica gestionar cualquier
    profesional de su clínica; `schedules.manage_own` restringe al profesional a su propio `req.user.userId` (403 si
    intenta operar sobre otro profesional).
  - En `RF5`, antes de insertar o actualizar se consulta si el rango se solapa (`&&`) con otro bloque del mismo
    profesional para devolver 409 con mensaje explícito, manteniendo `ex_schedules_overlap` como garantía ante
    concurrencia y `trg_professional_schedules_guard` (`MC006` → 409) para impedir que se recorte o borre un bloque
    con citas reservadas (`I3`).
  - En `RF6`, `POST /blockades` inserta el bloqueo y en la misma transacción consulta las citas reservadas
    (`appointment_status_id = 1`) que se solapan (`a.period && b.period`), devolviéndolas en `conflicts` sin
    cambiarles el estado; además se expone `GET /blockades/conflicts` para que recepción las consulte y reprograme.
  - En todas las escrituras (`POST`, `PATCH`, `DELETE`), se invoca `bumpAgendaVersion` **después** de que termina
    `withTransaction` (`COMMIT`), nunca dentro de la transacción.
- **Alternativas descartadas.**
  - Convertir zonas horarias en JavaScript: requeriría bibliotecas adicionales o manipulación manual de offsets,
    mientras PostgreSQL ya conoce el catálogo IANA en `clinics.time_zone`.
  - Cancelar automáticamente las citas dentro de un bloqueo: violaría `RF6`, que pide conservarlas y listarlas para
    reprogramación.
- **Lo que se sacrifica.** Una consulta adicional dentro de la transacción de `POST /blockades` para recuperar el
  detalle de las citas en conflicto, a cambio de que quien registra el bloqueo reciba de inmediato la lista de citas
  por reprogramar.

**Decisión de RF14, RF16 y RF18 (`feat/patients-history`): contactos auditados en el detalle del paciente, baja lógica de contactos e historial sin contactos en `agenda`.**
- **Problema.** `RF14` gestiona pacientes y sus datos de contacto en `services/clinical`, y `RF18` exige registrar en
  `clinical.audit_logs` toda lectura y toda escritura de datos de contacto de pacientes. Además, `mc_clinic_admin` y
  `mc_reception` tienen `SELECT, INSERT, UPDATE` sobre `patient_contacts` pero no `DELETE`, y `RF16` (`GET /appointments?patientId=…` en `services/agenda`) no debe leer contactos porque `agenda` no escribe en `clinical.audit_logs`.
- **Elegido.**
  - Separar el directorio (`GET /patients`, sin `patient_contacts`) del detalle (`GET /patients/:patientId`, con
    `contacts`): consultar el listado general no lee contactos ni inunda la bitácora, mientras que abrir el detalle de
    un paciente lee sus contactos activos y registra un evento `read` (`event_type_id = 1`, `data_object_id = 2`) por
    cada contacto dentro de la misma transacción (`services/clinical/src/audit.js`).
  - Al actualizar `contacts` en `PATCH /patients/:patientId`, los contactos retirados se marcan con `is_active = false`
    (baja lógica, coherente con los `GRANT` de `02-grants.sql`) y se auditan con `event_type_id = 4` (`delete`),
    conservando la fila a la que apuntan las entradas previas de `audit_logs`.
  - En `RF16` (`GET /appointments?patientId=…`), `agenda` verifica que el paciente pertenezca a `req.user.clinicId`
    consultando solo `patients` (sin tocar `patient_contacts`) y devuelve todas sus citas ordenadas por `lower(period)`
    aprovechando el índice `ix_appointments_patient_start`.
- **Alternativas descartadas.**
  - Incluir `contacts` en `GET /patients`: una sola consulta al directorio de una clínica de 80 pacientes generaría
    más de cien inserciones en `audit_logs` aunque el usuario solo buscara el nombre de un paciente.
  - Hacer `DELETE` físico en `patient_contacts`: fallaría con `42501` por menor privilegio y dejaría huérfano el
    `object_id` de la bitácora.
- **Lo que se sacrifica.** Obtener los contactos de un paciente requiere pedir `GET /patients/:patientId` en lugar de
  tomarlos del listado general.

**Decisión de RF15 y RF18 (`feat/clinical-notes`): la nota clínica solo es del profesional que atendió, y cada
acceso queda en la bitácora.**
- **Problema.** La nota clínica es el dato más sensible del sistema. Según la matriz, solo el profesional la escribe
  y la lee, y únicamente la de **sus** citas. RF15 agrega que la cita tiene que estar atendida, y RF18 pide registrar
  toda lectura y escritura. La base ya tiene la tabla con `UNIQUE (appointment_id)`, una nota por cita, y le da
  `SELECT, INSERT, UPDATE` solo a `mc_professional`. Pero no sabe qué profesional atendió cada cita.
- **Elegido.**
  - **Rutas:** `POST /clinical-notes`, `GET /clinical-notes/{id}`, `GET /clinical-notes?appointmentId=…` y
    `PATCH /clinical-notes/{id}`, en `services/clinical/src/routes/clinical-notes.js`, con
    `clinical_notes.write_own`.
  - **"Propia y atendida" se revisa en la API, dentro de la transacción.** Al escribir, `loadOwnAttendedAppointment`
    exige que la cita sea de la clínica y del profesional del token (404 si no lo es) y que esté atendida (409 si
    no). Al leer y al corregir, el `WHERE` filtra por el profesional de la cita.
  - **No hace falta un trigger,** porque ninguna transacción concurrente puede volver falsa la revisión: "atendida"
    es un estado final (`MC002` impide cambiarlo) y el profesional de una cita no cambia nunca (`MC004`).
  - **La nota se puede corregir** con `PATCH`. Solo el autor puede hacerlo, y cada corrección queda en la bitácora.
    Lo decidió Sebastián: en la práctica clínica las notas se corrigen, y los GRANT ya daban `UPDATE`.
  - **Bitácora:** `logAuditEvent` (`services/clinical/src/audit.js`), con `create`, `read` o `update`, en la misma
    transacción. La descripción dice qué se hizo, nunca qué dice la nota: el administrador lee la bitácora (RF19),
    pero no puede leer notas.
- **Alternativas descartadas.**
  - **Un trigger que valide "propia y atendida".** Repetiría en la base una regla que ya no puede romperse por
    concurrencia, y el trigger no conoce al usuario del token: habría que pasárselo como variable de sesión.
  - **Responder 403 a otro profesional.** Revelaría que la cita o la nota existen. El 404 es igual al de una que no
    existe (I5).
  - **Notas inmutables.** Es más estricto, pero obliga a pedir una corrección por fuera del sistema.
- **Lo que se sacrifica.** Cada lectura de una nota escribe una fila en la bitácora y toma el candado de la cadena de
  huellas de su clínica (§11). Es el mismo costo, ya medido, que las lecturas de contactos.

**Decisión de RF19 (`feat/audit-query`): la bitácora se consulta paginada por `log_id`, con fechas en la hora de
la clínica.**
- **Problema.** RF19 pide consultar la bitácora con filtros por usuario, paciente y rango de fechas. Pero la
  bitácora crece con **cada lectura** de un dato sensible (RF18), así que una clínica activa acumula miles de filas
  por día: no se puede devolver entera.
- **Elegido.**
  - **La ruta.** `GET /audit`, en `services/clinical/src/routes/audit.js`, junto a `GET /audit/verify` del §9, con
    el mismo permiso `audit.read`.
  - **Filtros opcionales:** `userId`, `patientId`, `from` y `to`.
  - **Fechas.** Son días `YYYY-MM-DD` en la hora local de la clínica, inclusive, igual que en RF21, para que las dos
    rutas con rango se comporten igual.
  - **Paginación por cursor.** Se ordena por `log_id` descendente, y la página siguiente es `log_id < beforeId`. Es
    el orden de la cadena de huellas, y la consulta recorre el índice `ix_audit_clinic_log`.
  - **Respuesta:** `{ entries, nextBeforeId }`.
- **Alternativas descartadas.**
  - **Paginar con `offset`.** Cada página obliga a la base a recorrer y descartar todas las anteriores. Además, si
    llegan entradas nuevas mientras se pagina, la página siguiente repite o se salta filas.
  - **Ordenar por `created_at`.** `now()` es la hora de **inicio** de cada transacción, así que dos transacciones
    simultáneas pueden quedar con un orden de `created_at` distinto al de `log_id`, que es el orden real de la cadena.
  - **Fechas con hora y zona** (`2026-11-12T00:00:00-06:00`). Son más precisas, pero el administrador piensa en días
    de su clínica, y RF21 ya usa días.
- **Lo que se sacrifica.** No se puede saltar directo a "la página 5": solo se avanza de una página a la siguiente.

**Decisión de las pruebas de fuga (`test/tenant-isolation`, I5): probar las tres capas de aislamiento multi-tenant.**
- **Problema.** Con columna discriminadora (`clinic_id`), el aislamiento entre clínicas (`I5`) se apoya en tres capas:
  (1) `clinicId` sale siempre del token y se rechaza en parámetros/body; (2) toda ruta filtra por `req.user.clinicId`
  y responde `404` idéntico a un id inexistente ante recursos o combinaciones de otra clínica; y (3) las llaves
  foráneas compuestas `(clinic_id, id)` impiden en el motor que una fila apunte a un registro de otra clínica.
- **Elegido.** `tests/integration/tenant-isolation.test.js` verifica las tres capas de extremo a extremo entre las
  tres clínicas del seed (San José, Cartago y Bogotá): partición estricta de listados, respuestas `404`
  indistinguibles de un id inexistente, rechazo de combinaciones cruzadas en reservas y cambios de estado, rechazo
  `400` al inyectar `clinicId` o `clinic_id` en body/query, y verificación con `SAVEPOINT` bajo `SET LOCAL ROLE` de
  que PostgreSQL aborta con `23503` cualquier inserción que mezcle clínicas en las tablas hijas.
- **Alternativa descartada.** Probar únicamente el `404` por ruta: no demostraría que la tercera capa (las FKs
  compuestas en la base) frena una referencia cruzada aunque el código del backend tuviera un error.
- **Lo que se sacrifica.** Una prueba adicional contra la base en el archivo de integración, que se deshace con
  `ROLLBACK` sin dejar datos en las tablas.

---

## 10. Orden de implementación

Primero los cimientos, en serie, porque mueven archivos que todos usan:

1. Reestructurar el repositorio: solo mover archivos, sin cambiar el comportamiento.
2. Pasar las tablas a sus schemas.
3. Crear un usuario de base por servicio.
4. Traducir los errores `MC001`–`MC006` y distinguir los conflictos de `23P01`.
5. Crear `agenda` y `clinical` vacíos, más el gateway.
6. Montar el arnés de pruebas.

Después, tres carriles en paralelo, cada uno en su propia carpeta:

- **`agenda`:** el núcleo transaccional.
- **`admin` y `clinical`.**
- **Kubernetes.**

La lista Committed del Trello sigue este orden.

**Pendiente de diseñar:**

- el detalle de los manifiestos de Kubernetes.

---

## 11. Módulo adicional (§9): auditoría verificable con cadena de huellas SHA-256

El enunciado exige para los grupos de tres personas un módulo adicional de entre cuatro opciones (§9). Se eligió la
**opción 1: auditoría consultable y verificable**, que extiende la protección *append-only* de la invariante `I6` con
una cadena criptográfica de huellas SHA-256 por clínica en `clinical.audit_logs`.

- **Por qué se eligió esta opción frente a las otras tres del §9:**
  - *RLS como segunda estrategia* exigía tocar `withTransaction` y las quince tablas con `clinic_id` mientras los tres
    carriles editaban consultas en paralelo.
  - *Adjuntos clínicos* agregaba almacenamiento de objetos (MinIO) y la mayor superficie nueva de rutas.
  - *Estrategias de invalidación comparadas* dependía de terminar primero RF7 y la caché de Redis, que estaban en el
    carril más cargado (`agenda`).
  - *Auditoría verificable* está acotada a `clinical.audit_logs` y al servicio `clinical`, no obliga a cambiar el
    código de `RF18` (porque el encadenamiento ocurre en un trigger `BEFORE INSERT`) y complementa directamente `I6`.

- **Problema que resuelve.** La invariante `I6` impide modificar o borrar la bitácora desde la aplicación en dos capas:
  ningún rol de aplicación tiene `UPDATE`, `DELETE` ni `TRUNCATE` (`db/sql/02-grants.sql`), y los triggers
  `trg_audit_logs_append_only` y `trg_audit_logs_no_truncate` rechazan cualquier cambio con `MC005` aunque alguien
  conceda el permiso por error. Sin embargo, el dueño del esquema (`mc_owner`) o un superusuario de PostgreSQL con
  acceso directo al motor podría desactivar temporalmente el trigger (`ALTER TABLE ... DISABLE TRIGGER`), alterar el
  texto de un evento o borrar una fila incómoda, y volver a activar el trigger sin dejar rastro visible.

- **Diseño elegido:**
  1. **Dos columnas en `clinical.audit_logs`:** `prev_hash CHAR(64)` (nula únicamente en el primer registro de cada
     clínica) y `row_hash CHAR(64) NOT NULL`.
  2. **Función canónica compartida (`clinical.audit_log_compute_hash`):** función SQL `IMMUTABLE` que concatena con
     separador `|` el `prev_hash` (`'GENESIS'` si es `NULL`) y todas las columnas inmutables de la fila (`log_id`,
     `clinic_id`, `user_id`, `event_type_id`, `data_object_id`, `object_id`, `patient_id`, `description`, `metadata`
     serializado como `JSONB` canónico y `created_at` formateado en UTC con microsegundos), y calcula su resumen
     `sha256()` codificado en hexadecimal de 64 caracteres. Tanto el trigger de inserción como la función verificadora
     llaman a esta misma función para que jamás difieran en el orden o formato de los campos.
  3. **Serialización por clínica con `pg_advisory_xact_lock` (`clinical.audit_logs_set_hash`):** el trigger
     `BEFORE INSERT` adquiere `pg_advisory_xact_lock(hashtext('clinical.audit_logs'), NEW.clinic_id)` antes de leer la
     última fila de esa clínica (`ORDER BY log_id DESC LIMIT 1`, respaldada por el índice `ix_audit_clinic_log`). Si
     dos transacciones de la misma clínica insertan al mismo tiempo, la segunda espera a que la primera confirme y lee
     su `row_hash` ya confirmado, evitando que la cadena se bifurque; las clínicas distintas usan llaves de candado
     distintas y no se bloquean entre sí. Además, si dos transacciones obtuvieron su `nextval` de `log_id` en orden
     inverso al orden en que tomaron el candado, el trigger adelanta `NEW.log_id` para que el orden por `log_id`
     coincida siempre con el orden de encadenamiento.
  4. **`SECURITY DEFINER` con `search_path` fijo en el trigger:** los roles `mc_reception` y `mc_professional` tienen
     `INSERT` pero no `SELECT` sobre `clinical.audit_logs` (`db/sql/02-grants.sql`). Como el trigger necesita leer el
     `row_hash` del registro previo al insertar, la función `clinical.audit_logs_set_hash()` se declara
     `SECURITY DEFINER SET search_path = admin, agenda, clinical, pg_temp`. Así puede leer el último eslabón sin abrir
     permiso `SELECT` sobre la bitácora a recepción ni a los profesionales.
  5. **Verificación en la base (`clinical.verify_audit_chain`) y en la API (`GET /audit/verify`):** la función recorre
     los registros de la clínica en orden de `log_id` y comprueba cada eslabón (`prev_hash` contra el `row_hash`
     anterior, y `row_hash` contra `audit_log_compute_hash`). Si una fila fue alterada o si se borró un eslabón
     intermedio, se detiene y devuelve `is_valid = false` junto con el `first_broken_log_id` exacto y el motivo. La
     ruta `GET /audit/verify` en `services/clinical` la expone al administrador de la clínica (permiso `audit.read`).

- **Lo que se sacrifica y límite conocido para la defensa.** Las inserciones en `audit_logs` de una misma clínica se
  serializan durante el tiempo de la transacción que las contiene, y un atacante con privilegios de superusuario que
  conozca la función `audit_log_compute_hash` podría no solo modificar un registro sino recalcular en cascada todos
  los `prev_hash` y `row_hash` posteriores hasta el final de la cadena. La mitigación estándar —anclar o exportar
  periódicamente el último `row_hash` (`lastRowHash` de `GET /audit/verify`) a un almacenamiento externo de solo
  escritura fuera de PostgreSQL— queda documentada como evolución para producción.

- **Cuánto cuesta serializar por clínica (medido el 2026-11-12).**
  - **Por qué importa.** RF18 registra cada lectura de contactos y de notas, así que el candado de la cadena también
    afecta a las lecturas, no solo a las escrituras.
  - **Cómo se midió.**
    - Con k6, 50 usuarios simultáneos durante 20 segundos.
    - La consulta fue `GET /patients/{id}` sobre los 80 pacientes de una **sola** clínica (San José), que es el peor
      caso: todas las peticiones compiten por el mismo candado.
    - Cada lectura deja unas dos filas en la bitácora, una por contacto.
    - Se corrió la misma prueba, en la misma máquina, antes y después de este módulo, con una copia de `clinical`.

    | | Peticiones por segundo | p50 | p95 |
    |---|---|---|---|
    | Sin la cadena de huellas | ~530 | 90 ms | 126 ms |
    | Con la cadena de huellas | ~394 | 120 ms | 144 ms |

  - **Resultado.** Una clínica pierde cerca de un 26 % de capacidad en lecturas auditadas. Las clínicas distintas usan
    candados distintos, así que el total de la plataforma crece con el número de clínicas. Aun así, ~394 lecturas
    sensibles por segundo en una sola clínica es mucho más de lo que genera su recepción. Se acepta el costo a cambio
    de que cualquier manipulación de la bitácora sea detectable.
