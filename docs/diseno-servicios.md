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

---

## 2. Estructura del repositorio

```
package.json            raíz: define los workspaces
package-lock.json       uno solo para todo el repositorio
packages/
  common/src/           auth.js, db.js y errors.js (antes en app/src)
services/
  admin/                el código que antes estaba en app/, con su Dockerfile
  agenda/               (etapa 5)
  clinical/             (etapa 5)
gateway/                (etapa 5)
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

Las cifras de la tabla miden solo la base. La medición de punta a punta, antes y después de la caché, está
pendiente.

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

**Riesgo conocido.** CloudNativePG ejecuta el SQL de inicialización como superusuario, mientras que nuestros
scripts asumen `mc_owner`, el dueño de las tablas. Hay que adaptarlos al escribir los manifiestos.

---

## 8. Caché de disponibilidad

Está explicada en [comparacion-arquitecturas.md](comparacion-arquitecturas.md#decisión-caché-de-disponibilidad-rf7):

- se guardan los huecos libres por profesional y día;
- se invalida subiendo una versión por agenda, después del COMMIT;
- Redis usa la política `volatile-lru`;
- si Redis falla, se consulta PostgreSQL.

---

## 9. Pruebas

> **Estrategia aprobada; el detalle se diseña al montar el arnés de pruebas.**

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

- el detalle de los manifiestos de Kubernetes;
- el detalle de las pruebas;
- la elección del módulo del §9.
