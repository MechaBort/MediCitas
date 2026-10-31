-- =============================================================================
-- MediCitas · Generador del diccionario de datos
--
-- Escribe docs/diccionario-datos.md en Markdown. Los tipos, nulos, valores por
-- omisión, llaves, restricciones, índices y triggers se leen del catálogo de
-- PostgreSQL; las descripciones son los COMMENT ON de db/sql/05-comments.sql.
-- Lo ejecuta db/tools/generar-diccionario.sh (psql -At: cada consulta devuelve
-- un único bloque de texto). Solo lee: las vistas son temporales.
-- =============================================================================

-- Orden de presentación: mismas áreas que docs/diagramas.md. Una tabla que no
-- esté en la lista aparece al final, en "Otras tablas".
CREATE TEMP VIEW dd_areas (area_order, area, tables) AS VALUES
    (1, 'Clínicas, usuarios y permisos',
        ARRAY['clinics', 'users', 'roles', 'professionals', 'permissions', 'permissions_per_roles']),
    (2, 'Geografía',
        ARRAY['countries', 'states', 'cities', 'addresses', 'clinics_addresses']),
    (3, 'Especialidades y servicios',
        ARRAY['specialties', 'specialties_per_professionals', 'services', 'services_per_professionals']),
    (4, 'Agenda',
        ARRAY['professional_schedules', 'blockades', 'professional_contacts']),
    (5, 'Pacientes',
        ARRAY['genders', 'patients', 'contact_types', 'patient_contacts']),
    (6, 'Citas y notas clínicas',
        ARRAY['appointment_statuses', 'appointments', 'clinical_notes']),
    (7, 'Bitácoras',
        ARRAY['event_types', 'data_objects', 'audit_logs', 'severities', 'system_errors_logs']);

CREATE TEMP VIEW dd_tables AS
SELECT c.oid AS relid,
       c.relname::text AS table_name,
       coalesce(a.area_order, 99) AS area_order,
       coalesce(a.area, 'Otras tablas') AS area,
       coalesce(array_position(a.tables, c.relname::text), 0) AS table_order
  FROM pg_class c
  LEFT JOIN dd_areas a ON c.relname::text = ANY (a.tables)
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relkind = 'r';


-- Encabezado ------------------------------------------------------------------
SELECT $md$# Diccionario de datos de MediCitas

> **Archivo generado, no se edita a mano.** Lo escribe `db/tools/generar-diccionario.sh` leyendo la base en
> ejecución. Los tipos, nulos, llaves, restricciones, índices y triggers salen del catálogo de PostgreSQL, y las
> descripciones son comentarios guardados en la propia base (`db/sql/05-comments.sql`). Así el documento no puede
> quedar desalineado con el esquema real (`db/sql/01-schema.sql`). Para cambiar una descripción se edita
> `05-comments.sql` y se vuelve a generar.

## Cómo leer este documento

- **Nombres.** Están en snake_case, tal como existen en la base. El modelo del README usa camelCase
  (`clinicId` → `clinic_id`).
- **Columnas de cada tabla.**
  - *Nulo*: `sí` si la columna admite NULL.
  - *Por omisión*: valor que pone el motor si el `INSERT` no lo trae. `identidad` significa
    `GENERATED ALWAYS AS IDENTITY`: lo asigna el motor y la aplicación no lo puede escribir.
  - *Llave*: `PK` llave primaria, `FK` forma parte de una llave foránea, `UK` es única por sí sola. Las llaves y
    restricciones de varias columnas se listan debajo de cada tabla.
- **Tenant.** El tenant es la clínica. Las tablas con datos de una clínica llevan `clinic_id`, y sus FKs hacia
  otras tablas de clínica son compuestas, `(clinic_id, id)`: así el motor rechaza cualquier relación entre
  registros de clínicas distintas (I5). Los catálogos globales no llevan `clinic_id`.
- **Instantes e intervalos.** Todo instante es `timestamptz` (un momento absoluto; la hora local se obtiene con
  `clinics.time_zone`). Todo intervalo es `tstzrange` de la forma `[inicio, fin)`: incluye el inicio y excluye el
  fin, de modo que dos citas seguidas (09:00–09:30 y 09:30–10:00) no se solapan.
- **Columnas de control.** `is_active` (baja lógica), `created_at`, `updated_at` y `updated_by` aparecen en casi
  todas las tablas. El trigger `trg_set_updated_at`, que mantiene `updated_at`, está en todas ellas y no se repite
  abajo. La FK de `updated_by` hacia `users` es `DEFERRABLE INITIALLY DEFERRED` porque `users` y `roles` se
  referencian mutuamente y se revisa al confirmar la transacción.
- **Datos sensibles.** `patient_contacts` y `clinical_notes`: toda lectura y escritura se registra en `audit_logs`
  (RF18).
- **Errores propios.** Los triggers lanzan estos códigos SQLSTATE, que la API traduce a respuestas HTTP:

| Código | Significado | Regla |
|---|---|---|
| `MC001` | La cita cae fuera del horario del profesional o dentro de un bloqueo | I3 |
| `MC002` | Transición de estado no permitida | RF13 |
| `MC003` | Desenlace registrado antes de la hora de inicio | RF12 |
| `MC004` | Intento de mover una cita o cambiarle el servicio | I4 |
| `MC005` | Intento de modificar o borrar la bitácora | I6 |
| `MC006` | El bloque de horario tiene citas reservadas | I3 |
$md$;


-- Índice de tablas --------------------------------------------------------------
SELECT E'## Tablas por área\n\n| Área | Tablas |\n|---|---|\n'
       || string_agg(format('| %s | %s |', area, tables), E'\n' ORDER BY area_order)
       || E'\n'
  FROM (SELECT area_order, area,
               string_agg(format('[%1$s](#%1$s)', table_name), ', ' ORDER BY table_order) AS tables
          FROM dd_tables
         GROUP BY area_order, area) a;


-- Una sección por área y una subsección por tabla -------------------------------
SELECT format(E'## %s\n\n%s', area, string_agg(md, E'\n' ORDER BY table_order))
  FROM (
    SELECT t.area_order, t.area, t.table_order,
           format(E'### %s\n\n%s\n\n', t.table_name,
                  coalesce(obj_description(t.relid, 'pg_class'), '_Sin descripción._'))
           || E'| Columna | Tipo | Nulo | Por omisión | Llave | Descripción |\n'
           || E'|---|---|---|---|---|---|\n'
           || cols.md || E'\n'
           || coalesce(E'\n**Restricciones**\n\n'       || cons.md || E'\n', '')
           || coalesce(E'\n**Índices adicionales**\n\n' || idx.md  || E'\n', '')
           || coalesce(E'\n**Triggers**\n\n'            || trg.md  || E'\n', '')
           AS md
      FROM dd_tables t

     -- Columnas
     CROSS JOIN LATERAL (
        SELECT string_agg(format('| `%s` | %s | %s | %s | %s | %s |',
                   a.attname,
                   replace(replace(replace(format_type(a.atttypid, a.atttypmod),
                       'character varying', 'varchar'),
                       'timestamp with time zone', 'timestamptz'),
                       'character(', 'char('),
                   CASE WHEN a.attnotnull THEN 'no' ELSE 'sí' END,
                   CASE WHEN a.attidentity <> '' THEN 'identidad'
                        ELSE coalesce('`' || pg_get_expr(d.adbin, d.adrelid) || '`', '') END,
                   concat_ws(', ',
                       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k
                                          WHERE k.conrelid = t.relid AND k.contype = 'p'
                                            AND a.attnum = ANY (k.conkey)) THEN 'PK' END,
                       (SELECT string_agg('FK → ' || k.confrelid::regclass, ', ' ORDER BY k.conname)
                          FROM pg_constraint k
                         WHERE k.conrelid = t.relid AND k.contype = 'f'
                           AND k.conkey = ARRAY[a.attnum]),
                       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k
                                          WHERE k.conrelid = t.relid AND k.contype = 'f'
                                            AND cardinality(k.conkey) > 1
                                            AND a.attnum = ANY (k.conkey)) THEN 'FK compuesta' END,
                       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k
                                          WHERE k.conrelid = t.relid AND k.contype = 'u'
                                            AND k.conkey = ARRAY[a.attnum]) THEN 'UK' END),
                   coalesce(col_description(t.relid, a.attnum), '')),
                 E'\n' ORDER BY a.attnum) AS md
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = t.relid AND a.attnum > 0 AND NOT a.attisdropped
     ) cols

     -- Restricciones. Las de una sola columna (PK, FK, UNIQUE) ya se ven en la columna Llave,
     -- así que solo se listan si tienen comentario. Una FK compuesta que incluye clinic_id
     -- sin comentario propio recibe la descripción de I5.
     CROSS JOIN LATERAL (
        SELECT string_agg(format('- `%s` (%s): `%s`%s',
                   k.conname,
                   CASE k.contype WHEN 'f' THEN 'FK' WHEN 'u' THEN 'UNIQUE'
                                  WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' END,
                   regexp_replace(pg_get_constraintdef(k.oid), '\s+', ' ', 'g'),
                   coalesce(' — ' || coalesce(
                       obj_description(k.oid, 'pg_constraint'),
                       CASE WHEN k.contype = 'f' AND cardinality(k.conkey) > 1
                             AND EXISTS (SELECT 1 FROM pg_attribute x
                                          WHERE x.attrelid = k.conrelid
                                            AND x.attnum = ANY (k.conkey)
                                            AND x.attname = 'clinic_id')
                            THEN 'Misma clínica: el motor rechaza la relación entre registros de clínicas distintas (I5).'
                       END), '')),
                 E'\n' ORDER BY CASE k.contype WHEN 'f' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 ELSE 4 END,
                                k.conname) AS md
          FROM pg_constraint k
         WHERE k.conrelid = t.relid
           AND k.contype IN ('f', 'u', 'c', 'x')
           AND (k.contype IN ('c', 'x')
                OR cardinality(k.conkey) > 1
                OR obj_description(k.oid, 'pg_constraint') IS NOT NULL)
     ) cons

     -- Índices que no nacen de una PK, UNIQUE o EXCLUDE
     CROSS JOIN LATERAL (
        SELECT string_agg(format('- `%s`: `%s`%s',
                   ic.relname,
                   regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING ', ''),
                   coalesce(' — ' || obj_description(i.indexrelid, 'pg_class'), '')),
                 E'\n' ORDER BY ic.relname) AS md
          FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = t.relid
           AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                            WHERE k.conindid = i.indexrelid AND k.conrelid = t.relid
                              AND k.contype IN ('p', 'u', 'x'))
     ) idx

     -- Triggers (menos el de updated_at, que está en todas)
     CROSS JOIN LATERAL (
        SELECT string_agg(format('- `%s` (%s, %s) → `%s()`%s',
                   g.tgname,
                   substring(pg_get_triggerdef(g.oid) FROM '((?:BEFORE|AFTER|INSTEAD OF) .*?) ON '),
                   CASE WHEN g.tgtype::int & 1 = 1 THEN 'por fila' ELSE 'por sentencia' END,
                   g.tgfoid::regproc,
                   coalesce(' — ' || obj_description(g.oid, 'pg_trigger'), '')),
                 E'\n' ORDER BY g.tgname) AS md
          FROM pg_trigger g
         WHERE g.tgrelid = t.relid
           AND NOT g.tgisinternal
           AND g.tgname <> 'trg_set_updated_at'
     ) trg
  ) s
 GROUP BY area_order, area
 ORDER BY area_order;


-- Valores de los catálogos fijos ----------------------------------------------
SELECT $md$## Valores de los catálogos fijos

Estos valores los inserta `db/sql/03-catalogs.sql` y forman parte del esquema: el código, los `CHECK` y los
triggers los usan por id o por nombre. Los datos de demostración (clínicas, especialidades, servicios, pacientes,
citas) están en `db/sql/04-seed.sql` y no se listan aquí.
$md$;

SELECT E'### Valores de roles\n\n| role_id | role_name | Descripción |\n|---|---|---|\n'
       || string_agg(format('| %s | `%s` | %s |', role_id, role_name, description), E'\n' ORDER BY role_id)
       || E'\n'
  FROM roles;

SELECT E'### Valores de appointment_statuses\n\n| appointment_status_id | status_name | is_final |\n|---|---|---|\n'
       || string_agg(format('| %s | `%s` | %s |', appointment_status_id, status_name,
                            CASE WHEN is_final THEN 'sí' ELSE 'no' END),
                     E'\n' ORDER BY appointment_status_id)
       || E'\n'
  FROM appointment_statuses;

SELECT E'### Valores de genders\n\n| gender_id | gender_name |\n|---|---|\n'
       || string_agg(format('| %s | `%s` |', gender_id, gender_name), E'\n' ORDER BY gender_id)
       || E'\n'
  FROM genders;

SELECT E'### Valores de contact_types\n\n| contact_type_id | contact_type_name |\n|---|---|\n'
       || string_agg(format('| %s | `%s` |', contact_type_id, contact_type_name), E'\n' ORDER BY contact_type_id)
       || E'\n'
  FROM contact_types;

SELECT E'### Valores de event_types\n\n| event_type_id | name | Descripción |\n|---|---|---|\n'
       || string_agg(format('| %s | `%s` | %s |', event_type_id, name, description), E'\n' ORDER BY event_type_id)
       || E'\n'
  FROM event_types;

SELECT E'### Valores de data_objects\n\n| data_object_id | name | Descripción |\n|---|---|---|\n'
       || string_agg(format('| %s | `%s` | %s |', data_object_id, name, description), E'\n' ORDER BY data_object_id)
       || E'\n'
  FROM data_objects;

SELECT E'### Valores de severities\n\n| severity_id | name | Descripción |\n|---|---|---|\n'
       || string_agg(format('| %s | `%s` | %s |', severity_id, name, description), E'\n' ORDER BY severity_id)
       || E'\n'
  FROM severities;

-- Matriz de permisos: una columna por rol (los role_id son fijos).
SELECT E'### Matriz de permisos (permissions y permissions_per_roles, RF17)\n\n'
       || E'| Permiso | Descripción | platform_admin | clinic_admin | reception | professional |\n'
       || E'|---|---|:-:|:-:|:-:|:-:|\n'
       || string_agg(format('| `%s` | %s | %s | %s | %s | %s |',
              p.permission_name, p.description,
              CASE WHEN 1 = ANY (r.role_ids) THEN '✓' ELSE '' END,
              CASE WHEN 2 = ANY (r.role_ids) THEN '✓' ELSE '' END,
              CASE WHEN 3 = ANY (r.role_ids) THEN '✓' ELSE '' END,
              CASE WHEN 4 = ANY (r.role_ids) THEN '✓' ELSE '' END),
            E'\n' ORDER BY p.permission_id)
  FROM permissions p
 CROSS JOIN LATERAL (SELECT array_agg(pr.role_id) AS role_ids
                       FROM permissions_per_roles pr
                      WHERE pr.permission_id = p.permission_id AND pr.is_active) r;
