# Documento de diseño de MediCitas (Etapa 1)

Es la entrada al diseño. El enunciado (§12) pide cuatro cosas: el diagrama entidad-relación, la comparación de
estrategias de multi-tenancy, y la decisión de aislamiento con sus trade-offs. Aquí está cada una resumida, con el
enlace a su detalle completo. Las pruebas que demuestran cada decisión están en el
[informe de pruebas](informe-pruebas.md).

**La pregunta rectora** del enunciado es qué pasa cuando dos recepcionistas reservan el último espacio exactamente al
mismo tiempo. La respuesta corta: **la base de datos garantiza las reglas, y la API solo traduce sus errores.** Por eso
casi todas las decisiones de abajo ponen la garantía en PostgreSQL, no en el código.

## 1. Arquitectura

Sistema **basado en servicios**:
- tres servicios Node que se despliegan y escalan por separado: `admin` (RF1–RF4), `agenda` (RF5–RF13, RF16, RF20,
  RF21) y `clinical` (RF14, RF15, RF18, RF19);
- detrás de un gateway Nginx que solo enruta;
- con **una sola base PostgreSQL dividida en un schema por servicio** (`admin`, `agenda`, `clinical`);
- Keycloak emite los tokens, y Redis guarda la caché de RF7.

Se descartaron los microservicios puros y las bases separadas por dominio porque la reserva necesita validar horario,
bloqueos y citas **en una misma transacción**, y las FKs compuestas, que protegen I5, cruzan dominios.

- La comparación de las tres arquitecturas está en [comparacion-arquitecturas.md](comparacion-arquitecturas.md).
- El diseño detallado, con el porqué de cada decisión, está en [diseno-servicios.md](diseno-servicios.md). Cubre:
  - los servicios y el gateway;
  - la identidad y los usuarios de base por servicio;
  - los schemas;
  - la escala hacia 200 000 peticiones por minuto;
  - la caché;
  - las pruebas;
  - Kubernetes con CloudNativePG, PgBouncer, el HPA y una base secundaria síncrona con failover automático.
- Los diagramas de arquitectura están en [diagramas.md](diagramas.md), sección 1.

## 2. Modelo entidad-relación

- **El diagrama:** [diagramas.md](diagramas.md), sección 2 para la vista general y sección 3 para el detalle por área
  (clínicas y permisos, servicios y agenda, pacientes, citas y notas, bitácoras).
- **El diccionario de datos,** generado desde la base: [diccionario-datos.md](diccionario-datos.md).
- **El modelo comentado** (convenciones, cada tabla, índices, normalización hasta 3FN y desnormalizaciones
  deliberadas): [README, "Diseño de la base de datos"](../README.md#diseño-de-la-base-de-datos-postgresql).

## 3. Multi-tenancy: comparación y decisión

| | Un schema por clínica | Columna discriminadora (`clinicId`) |
|---|---|---|
| Aislamiento | Físico, fuerte | Depende de filtrar siempre por `clinicId` |
| Alta de una clínica (RF1) | DDL en caliente; la app necesitaría `CREATE` | Un `INSERT` |
| Migraciones | Una por clínica | Una sola |
| Integridad entre clínicas | Imposible referenciar otra | FKs compuestas `(clinic_id, id)` |

**Elegida:** la columna discriminadora.
- **Por qué.** El alta de una clínica no requiere DDL ni privilegios elevados, el esquema se mantiene una sola vez y
  la Etapa 2 parte de tablas únicas.
- **Su debilidad,** que una consulta olvide el filtro, se cubre en tres capas:
  1. el `clinicId` sale siempre del token, nunca de la petición, y uno enviado por el cliente se rechaza con 400;
  2. toda consulta filtra por él, y un recurso de otra clínica responde 404, igual que uno inexistente;
  3. las FKs compuestas impiden **en el motor** que una fila apunte a otra clínica.

  Las tres capas están probadas en `tenant-isolation.test.js`.
- **Ojo:** los tres schemas de la base son uno **por servicio**, no uno por clínica.

El detalle completo está en el [README, "Estrategia de multi-tenancy"](../README.md#estrategia-de-multi-tenancy).

## 4. Aislamiento y concurrencia: decisión y trade-offs

**Elegido:** `READ COMMITTED`, explícito en cada transacción (`withTransaction`, `packages/common/src/db.js`), **más
las restricciones de la base**:
- **I1 e I2,** sin dobles reservas: restricciones `EXCLUDE` GiST sobre el periodo de las citas reservadas, del
  profesional y del paciente. Si dos reservas se solapan, la segunda espera a la primera y falla con `23P01`, y la API
  responde 409. **Siempre hay exactamente una ganadora**, sin depender del nivel de aislamiento.
- **I3,** dentro del horario: un trigger que valida el horario y los bloqueos, y que bloquea los bloques de horario
  con `FOR NO KEY UPDATE` hasta el COMMIT. Así nadie los recorta durante la reserva, y las reservas del mismo bloque
  **hacen fila**: cada una encuentra a la ganadora ya confirmada y recibe 409 al instante. Sin esa fila, diez reservas
  simultáneas se bloqueaban en ciclo dentro de la revisión del `EXCLUDE` y algunas terminaban en 500.
- **RF10,** reprogramar: una sola transacción que pasa la original a "reprogramada" e inserta la nueva. Si dos
  reprogramaciones cruzadas provocan un deadlock (`40P01`), `withTransaction` reintenta la transacción completa,
  hasta 5 veces y con una espera al azar entre intentos.

**Trade-offs, es decir, lo que se descartó y por qué:**
- **Revisar con un `SELECT` antes del `INSERT`:** no funciona, porque dos transacciones pueden leer "libre" a la vez.
- **`SERIALIZABLE`:** también evita la doble reserva, pero aborta transacciones con `40001`, incluso por falsos
  positivos, y obliga a reintentar en todo el sistema.
- **`SELECT … FOR UPDATE` sobre el profesional:** funciona, pero depende de que todo camino del código recuerde
  bloquear, y serializa reservas que ni siquiera se solapan.
- **Lo que se sacrifica con la opción elegida:**
  - la API depende de los nombres de las restricciones para distinguir los conflictos (`EXCLUSION_ERRORS` en
    `packages/common/src/errors.js`);
  - las reservas del mismo profesional sobre el mismo bloque de horario se ejecutan una después de otra, aunque no se
    solapen. Es el precio de que no se bloqueen en ciclo, y dura milisegundos.

El detalle está en el [README, "Concurrencia y nivel de aislamiento"](../README.md#concurrencia-y-nivel-de-aislamiento),
y la prueba de carrera en el [informe de pruebas](informe-pruebas.md), sección 4.

## 5. Las otras decisiones que pide el enunciado

| Tema | Decisión | Detalle |
|---|---|---|
| Identidad (§5.4) | Keycloak emite los tokens. Cada servicio valida la firma, `iss`, `aud` y `exp`, y asocia el `sub` del token con `users.keycloak_sub` para obtener la clínica y el rol | README, "Asociación de la identidad con su clínica" |
| Menor privilegio (§5.5) | Cuatro perfiles de base con los GRANT de la matriz, y un usuario de conexión por servicio que solo puede cambiar a los perfiles que atiende (`SET LOCAL ROLE`) | README, "Roles de base de datos"; [diseno-servicios.md](diseno-servicios.md) §4 |
| Bitácora append-only (RF18, I6) | Sin permisos `UPDATE`, `DELETE` ni `TRUNCATE`, más triggers que la protegen en el motor; el módulo del §9 agrega una cadena de huellas SHA-256 verificable | [diseno-servicios.md](diseno-servicios.md) §11 |
| Caché de RF7 (§5.6, I8) | Huecos libres por profesional y día, con invalidación por versión después del COMMIT y `volatile-lru` | [comparacion-arquitecturas.md](comparacion-arquitecturas.md), "Decisión: caché de disponibilidad" |
| Índices (§5.8) | Justificados con `EXPLAIN ANALYZE` sobre el seed | README, "Justificación con `EXPLAIN ANALYZE`" |
