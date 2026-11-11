# Comparación de arquitecturas para MediCitas

> Estado: **decidido el 2026-11-07, enfoque 1**: servicios por dominio con una base única dividida en schemas.
> El diseño detallado de ese enfoque está en [diseno-servicios.md](diseno-servicios.md).

## Qué estamos decidiendo

Hoy MediCitas es una sola aplicación (`app`) conectada a una sola base PostgreSQL. El profesor espera que el
sistema se divida en servicios que se puedan desplegar y escalar por separado, y que lo veamos corriendo en
Kubernetes.

La pregunta de fondo es **cómo dividir el sistema y, sobre todo, cómo repartir los datos** entre los servicios.

Algunos términos que se usan abajo:

- **Servicio:** una aplicación independiente, con su propio contenedor, que atiende una parte del negocio.
- **Escalar un servicio:** ejecutar más copias de él para atender más peticiones. Kubernetes puede hacerlo
  solo según la demanda; a eso se le llama **elasticidad**.
- **Schema:** una "carpeta" dentro de una base de datos PostgreSQL. Varios schemas pueden vivir en el mismo
  servidor.
- **Llave foránea:** una regla de la base que impide guardar una referencia a algo que no existe, por ejemplo
  una cita con un paciente inexistente.
- **I5:** la invariante que dice que ningún dato de una clínica puede verse ni usarse desde otra.

En los tres enfoques, los servicios se agrupan así:

| Servicio | Qué hace | Demanda esperada |
|---|---|---|
| `admin` | Clínicas, usuarios, servicios y profesionales (RF1–RF4) | Baja |
| `agenda` | Horarios, disponibilidad, citas, historial, agenda del día y conteos (RF5–RF13, RF16, RF20, RF21) | Alta |
| `clinical` | Pacientes, notas clínicas y bitácora de auditoría (RF14, RF15, RF18, RF19) | Media |

---

## Enfoque 1: servicios por dominio con una base dividida en schemas

**Cómo funciona.** Hay tres servicios, pero una sola base PostgreSQL. Dentro de ella, cada servicio tiene su
propio schema (`admin`, `agenda`, `clinical`). Cada servicio solo **escribe** en su schema, aunque puede
**leer** datos de los otros cuando los necesita. Es el estilo conocido como *arquitectura basada en servicios*.

**Ventajas**

- **La reserva sigue siendo segura.** Revisar el horario, revisar que el paciente exista y guardar la cita
  ocurre en una sola transacción, sin depender de otro servicio.
- **El aislamiento entre clínicas lo protege la base.** Las llaves foráneas siguen funcionando entre schemas,
  así que la propia base rechaza una cita con un paciente de otra clínica (I5).
- **Cada servicio escala por separado.** Kubernetes puede tener varias copias de `agenda` y una sola de `admin`.
- **La identidad no sobrecarga a `admin`.** Cada servicio consulta en la base quién es el usuario y de qué
  clínica, sin llamar al servicio `admin` en cada petición.
- **Es el que menos trabajo agrega** y el más fácil de probar y defender.
- **Deja un camino para crecer.** Si un día la base de agenda se satura, ya sabemos qué habría que separar
  para pasar al enfoque 2.

**Desventajas**

- **La base de agenda no escala por separado.** Todos los schemas comparten la CPU y la memoria del mismo
  servidor. Si la base se queda corta, hay que ampliarla para todos.
- **Los servicios quedan acoplados por los datos.** Si alguien cambia una tabla de `clinical`, puede romper
  algo en `agenda`.
- **No son microservicios "puros".** En la defensa nos pueden objetar que comparten base, y hay que tener el
  argumento preparado.
- **Si cae PostgreSQL, cae todo el sistema.**

---

## Enfoque 2: el mismo, pero agenda con su propia base

**Cómo funciona.** Igual que el enfoque 1, pero `agenda` tiene su propio servidor PostgreSQL. `admin` y
`clinical` siguen compartiendo otro.

**Ventajas**

- **La base de agenda escala sola.** Si las reservas y consultas de horarios crecen, se amplía solo esa base.
- **Los problemas de la base de agenda no afectan a los demás.** Si se satura, `admin` y `clinical` siguen
  funcionando.
- **Está más cerca de los microservicios**, y es más fácil de defender como diseño escalable.

**Desventajas**

- **Se pierden las llaves foráneas** desde las citas hacia pacientes, usuarios, profesionales y servicios,
  porque ahora están en otra base.
- **Cada reserva tiene que llamar a `clinical`** para validar que el paciente exista y sea de la clínica. Eso
  agrega tiempo de respuesta, y si `clinical` está caído, no se puede reservar.
- **La duración del servicio y los servicios que atiende cada profesional quedan en otra base.** Hay que
  pedirlos por la red o mantener una copia en `agenda`.
- **La identidad vive en otra base**, así que cada petición a `agenda` depende de ella.
- **El aislamiento entre clínicas (I5) pasa al código.** Ya no lo protege la base, así que las pruebas de fuga
  se vuelven obligatorias y más numerosas.
- **Agrega bastante trabajo** antes de la entrega del 15 de noviembre.

---

## Enfoque 3: microservicios estrictos

**Cómo funciona.** Cada dominio tiene su servicio y su propia base: identidad, catálogo, agenda, pacientes y
auditoría. Son cinco servicios y cinco bases, y ninguno lee los datos de otro directamente: todo se pide por
la red.

**Ventajas**

- **Independencia total.** Cada servicio y cada base se despliegan y escalan por su cuenta.
- **Es la definición "de libro" de microservicios.**
- **Cambiar un servicio no rompe a los demás**, mientras respete lo que expone a los otros.

**Desventajas**

- **Muchas llamadas por red entre servicios.** Cada una agrega tiempo y es un punto más que puede fallar.
- **Hay que rediseñar parte del modelo.** Una cita apunta a un paciente y una nota clínica apunta a una cita:
  agenda y pacientes dependen uno del otro, lo que en microservicios es un problema.
- **La identidad se consulta en cada petición**, o hay que mantener copias de los usuarios en todos los
  servicios.
- **Los datos copiados pueden quedar desactualizados por un momento.** A eso se le llama consistencia
  eventual, y choca con preferir rechazar una reserva antes que guardarla sin validar.
- **Es la mayor carga de infraestructura:** cinco bases en Compose y en Kubernetes.
- **Es el más difícil de terminar, probar y defender a tiempo.**

---

## Resumen

| | 1. Schemas | 2. Agenda aparte | 3. Microservicios |
|---|---|---|---|
| Los servicios escalan por separado | Sí | Sí | Sí |
| La base de agenda escala por separado | No | Sí | Sí |
| La reserva sigue en una sola transacción | Sí | Sí | Sí |
| La base protege el aislamiento entre clínicas (I5) | Sí | Solo en parte | No |
| Llamadas por red entre servicios | Ninguna | Varias por reserva | Muchas |
| Trabajo adicional | Bajo | Alto | Muy alto |

---

## Decisión: caché de disponibilidad (RF7)

> Decidido el 2026-11-08 e **implementado el 2026-11-11** en `services/agenda/src/availability-cache.js`, con la
> conexión en `redis.js` y las versiones en `agenda-version.js`. Las copias vencen en 60 segundos.

RF7, el cálculo de los espacios disponibles de un profesional en una fecha, es la consulta que más se ejecuta.
Para no recalcularla en cada petición, el servicio `agenda` guarda el resultado en Redis. Redis es solo una
copia rápida: PostgreSQL sigue siendo la fuente de verdad.

### Qué se guarda

Para cada profesional y día se guardan sus **huecos libres**: el horario de atención menos los bloqueos y las
citas reservadas. Por ejemplo, si la Dra. Mora atiende de 8:00 a 12:00 y tiene una cita de 9:00 a 9:30, se
guarda `8:00–9:00, 9:30–12:00`.

Al responder, `agenda` recorta esos huecos según la duración del servicio pedido. Con 30 minutos salen 8:00,
8:30, 9:30, 10:00…; con 60 minutos salen 8:00, 9:30, 10:30. El recorte se hace en memoria y es inmediato.

Se eligió esto, y no una lista ya calculada por cada servicio, porque así una sola entrada sirve para todos los
servicios del profesional. Además, cada cambio invalida una sola entrada, y RF8 (disponibilidad en un rango de
fechas) reutiliza las mismas entradas, día por día.

### Claves en Redis

| Clave | Valor | Para qué sirve |
|---|---|---|
| `ver:{clínica}:{profesional}:{fecha}` | Un número: la versión vigente de esa agenda | Indica cuál es la copia válida |
| `disp:{clínica}:{profesional}:{fecha}:v{n}` | Los huecos libres de ese día | La copia en sí, marcada con su versión |

La clínica va en la clave para que la caché nunca mezcle datos de dos clínicas (I5).

### Cómo se consulta

1. Leer la versión vigente de la agenda.
2. Buscar la copia con esa versión.
3. Si no existe, calcular los huecos desde PostgreSQL y guardarlos con esa versión, con un tiempo de
   expiración.

### Cómo se invalida: versión por agenda

Todo cambio que afecte la agenda de un profesional en un día termina con estos pasos, en este orden. Eso
incluye reservar, cancelar, reprogramar (en la fecha de origen y en la de destino), registrar el desenlace y
cambiar horarios o bloqueos.

1. Se confirma la transacción en PostgreSQL (COMMIT).
2. Se sube la versión de esa agenda con `INCR`, una operación atómica de Redis: si dos cambios la suben a la
   vez, no se pierde ninguno.
3. Recién entonces se responde al cliente.

La copia anterior no se borra. Queda guardada con un número de versión que ya nadie consulta y desaparece sola
al expirar. En el funcionamiento normal, esa expiración solo libera memoria: la corrección no depende de ella. La
única excepción es la falla parcial que se describe en "Si Redis falla".

El orden importa. Si la versión subiera antes del COMMIT, una consulta podría tomar la versión nueva, leer la
base antes de que la reserva se confirme y guardar un dato viejo justo en la copia vigente. Esto encaja con
una regla que el código ya tiene: `withTransaction` (`packages/common/src/db.js`) puede repetir una transacción ante un
deadlock, así que todo efecto externo, como tocar Redis, va después de que la transacción termina.

### Configuración de Redis

Todo el mecanismo depende de que **un número de versión nunca se repita**. Si Redis borrara la clave `ver:…` de
una agenda mientras todavía existen copias viejas, el contador volvería a empezar desde cero. Una copia vieja con
el mismo número podría volver a leerse como vigente, lo que viola I8.

Redis borra claves por su cuenta cuando llega a su límite de memoria (`--maxmemory`). Qué claves borra lo decide
su política de expulsión. Antes estaba en `allkeys-lru`, que expulsa cualquier clave usada hace tiempo, incluidas
las versiones. Por eso se fijaron estas reglas:

| Regla | Por qué |
|---|---|
| Política `volatile-lru` en `docker-compose.yml` | Solo expulsa claves que tienen vencimiento. Las versiones nunca se expulsan |
| Las versiones (`ver:…`) no tienen vencimiento | Así esa política nunca puede borrarlas |
| Las copias (`disp:…:v{n}`) vencen en pocos minutos | Siempre desaparecen antes que su versión, y son lo único que Redis puede expulsar |
| Solo se limpian versiones de fechas ya pasadas, días después | Para entonces sus copias ya vencieron, así que no queda ninguna que pueda coincidir |
| Redis no guarda nada en disco (`--save ""`, `--appendonly no`) | Si se reinicia, se pierden a la vez versiones y copias, así que tampoco queda ninguna copia vieja |

Si la memoria llegara a llenarse solo con versiones, Redis rechazaría las escrituras nuevas con un error de
memoria. `agenda` lo trata igual que un Redis caído: consulta PostgreSQL, que es más lento pero correcto. Las
versiones son claves pequeñas, una por profesional y día consultado. El límite de memoria se dimensiona con
esa cuenta en cada entorno, y en Kubernetes se usa la misma política.

### Alternativas descartadas

- **Borrar la entrada y dejar que expire.** Una consulta que leyó la base justo antes de una reserva puede
  escribir su resultado en Redis después de que la reserva borró la entrada. La caché mostraría como libre un
  espacio ya tomado hasta que la entrada expire. Eso viola I8 y el criterio de aceptación "la caché no miente".
- **Actualizar la caché al reservar (write-through).** Dos cambios simultáneos sobre la misma agenda pueden
  escribirse uno encima del otro y dejar un resultado incorrecto.
- **Un candado mientras se reserva.** Haría esperar a la consulta más frecuente del sistema. Además, un candado
  compartido entre varias copias del servicio necesita vencimiento y un manejo de fallas propio, por si la
  copia que lo tiene se cae.

### Si Redis falla

`agenda` consulta directamente PostgreSQL. Las respuestas son más lentas, pero nunca incorrectas. Las reservas
siguen funcionando: si no se puede subir la versión, el cambio ya está confirmado en la base y solo se registra el
error. Se comprobó deteniendo Redis en una copia aislada: RF7 respondió 200 con el header `X-MediCitas-Cache: off` y
la reserva, 201. Al volver Redis, la primera consulta se calculó de nuevo (`miss`) con la reserva incluida.

Cuando Redis vuelve hay dos casos:

- **Redis se reinició.** Perdió todo, porque no guarda nada en disco, así que no queda ninguna copia vieja.
- **Solo hubo un corte de red y Redis siguió vivo.** Este es el único caso en que la corrección depende del
  vencimiento. Supongamos que una reserva se confirmó en la base, pero la copia de `agenda` que la atendió no pudo
  subir la versión, mientras otra copia sí seguía conectada. Entonces la copia vieja de ese día se sigue leyendo
  hasta que vence, **a más tardar 60 segundos**. En esa ventana nadie puede reservar dos veces el mismo espacio: la
  restricción `EXCLUDE` rechaza la segunda reserva con 409. Lo peor que puede pasar es ver libre, por un minuto, un
  espacio que ya no lo está.

**Decisión: las copias vencen en 60 segundos.**
- **Problema.** El vencimiento decide cuánto dura esa ventana en la falla parcial, y cuánta memoria ocupan las copias
  de versiones viejas.
- **Elegido.** 60 segundos. Las agendas que más se consultan se leen muchas veces por minuto, así que casi todas
  las consultas siguen saliendo de la caché. La medición acertó en el 99,9 % de las consultas.
- **Alternativa descartada.** Varios minutos: algunos aciertos más, pero una ventana de error más larga en esa
  falla.
- **Lo que se sacrifica.** Una agenda que se consulta menos de una vez por minuto se recalcula en la base en cada
  consulta.

### Cómo se demuestra

- **Pruebas automatizadas** en `tests/integration/availability-cache.test.js`. La primera consulta es `miss` y la
  segunda `hit`. Después de reservar, cancelar o reprogramar un espacio devuelto, la siguiente consulta vuelve a ser
  `miss` y ya refleja el cambio, sin esperar a que expire nada (I8).
- **Las pruebas detectan el error.** Se comprobó en una copia aislada apagando el `INCR`: fallaron justo las cinco
  pruebas de invalidación (las dos de la caché y las tres de I7 e I8 de `availability.test.js`), y las demás
  siguieron pasando.
- **La respuesta sale de verdad de la caché.** Un bloqueo insertado directo en la base, sin subir la versión, no se
  vio (`hit`) hasta que una reserva por la API subió la versión (`miss`). Por eso toda ruta que cambie una agenda,
  incluidas las de horarios y bloqueos, debe llamar a `bumpAgendaVersion`.
- **La medición de RF7 antes y después** está en el README, "Medición de carga de RF7". Con la caché, la base hace
  la mitad del trabajo por consulta.
