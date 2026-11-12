#!/usr/bin/env bash
# =============================================================================
# Inicialización de PostgreSQL para MediCitas.
# =============================================================================
set -Eeo pipefail

: "${DB_OWNER_PASSWORD:?Falta DB_OWNER_PASSWORD}"
: "${DB_ADMIN_SVC_PASSWORD:?Falta DB_ADMIN_SVC_PASSWORD}"
: "${DB_AGENDA_SVC_PASSWORD:?Falta DB_AGENDA_SVC_PASSWORD}"
: "${DB_CLINICAL_SVC_PASSWORD:?Falta DB_CLINICAL_SVC_PASSWORD}"
: "${KEYCLOAK_DB_PASSWORD:?Falta KEYCLOAK_DB_PASSWORD}"

# 1. Objetos del clúster (roles y bases de datos): solo el superusuario puede crearlos.
#    Las contraseñas entran como variables de psql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
     -v owner_pw="$DB_OWNER_PASSWORD" \
     -v admin_svc_pw="$DB_ADMIN_SVC_PASSWORD" \
     -v agenda_svc_pw="$DB_AGENDA_SVC_PASSWORD" \
     -v clinical_svc_pw="$DB_CLINICAL_SVC_PASSWORD" \
     -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'


-- Dueño del esquema. Solo ejecuta los scripts de db/sql; la aplicación nunca lo usa.
CREATE ROLE mc_owner LOGIN PASSWORD :'owner_pw';



-- Perfiles con los permisos de la matriz (se conceden en 02-grants.sql).
CREATE ROLE mc_platform     NOLOGIN;
CREATE ROLE mc_clinic_admin NOLOGIN;
CREATE ROLE mc_reception    NOLOGIN;
CREATE ROLE mc_professional NOLOGIN;



-- Un usuario de conexión por servicio (docs/diseno-servicios.md, sección 4). Ninguno
-- tiene permisos propios (NOINHERIT): solo puede hacer SET LOCAL ROLE a los perfiles
-- que se le conceden aquí, y la API consulta esta misma lista (pg_has_role) para saber
-- qué tokens atiende cada servicio.
--
-- CONNECTION LIMIT es un tope de conexiones simultáneas, no de peticiones: impide que un
-- servicio acapare las conexiones de la base. Cada copia abre a lo sumo 10 (el pool de
-- packages/common/src/db.js). El tope deja lugar para el doble de las copias previstas,
-- porque al actualizar un Deployment conviven la copia vieja y la nueva. En Kubernetes
-- quien abre las conexiones es PgBouncer, y el tope limita también su pool.
-- La suma (80) queda por debajo de max_connections (100), que comparte Keycloak.
CREATE ROLE mc_admin_svc    LOGIN NOINHERIT CONNECTION LIMIT 20 PASSWORD :'admin_svc_pw';
CREATE ROLE mc_agenda_svc   LOGIN NOINHERIT CONNECTION LIMIT 40 PASSWORD :'agenda_svc_pw';
CREATE ROLE mc_clinical_svc LOGIN NOINHERIT CONNECTION LIMIT 20 PASSWORD :'clinical_svc_pw';

-- admin atiende los cuatro perfiles; agenda y clinical, todos menos la plataforma, que
-- no tiene nada que hacer en citas ni en datos clínicos.
GRANT mc_platform, mc_clinic_admin, mc_reception, mc_professional
   TO mc_admin_svc WITH INHERIT FALSE, SET TRUE;
GRANT mc_clinic_admin, mc_reception, mc_professional
   TO mc_agenda_svc, mc_clinical_svc WITH INHERIT FALSE, SET TRUE;



CREATE DATABASE medicitas OWNER mc_owner;
REVOKE ALL ON DATABASE medicitas FROM PUBLIC;
GRANT CONNECT ON DATABASE medicitas TO mc_admin_svc, mc_agenda_svc, mc_clinical_svc;

-- Las tablas viven en los schemas admin, agenda y clinical (01-schema.sql). Con este
-- search_path, las consultas de la API las encuentran sin escribir el schema. Se mantiene
-- después de SET LOCAL ROLE, porque pertenece a la sesión del usuario y no al perfil.
ALTER ROLE mc_admin_svc    IN DATABASE medicitas SET search_path = admin, agenda, clinical, public;
ALTER ROLE mc_agenda_svc   IN DATABASE medicitas SET search_path = admin, agenda, clinical, public;
ALTER ROLE mc_clinical_svc IN DATABASE medicitas SET search_path = admin, agenda, clinical, public;
-- El dueño también, para explorar la base con nombres simples (docs/guia-de-estudio.md). Los
-- scripts de db/sql igual fijan su search_path, porque en Kubernetes los ejecuta otro usuario.
ALTER ROLE mc_owner        IN DATABASE medicitas SET search_path = admin, agenda, clinical, public;



-- Keycloak guarda su estado en su propia base, sin acceso a la de la aplicación.
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL



# 2. Objetos de la base medicitas: los crea mc_owner para que quede como dueño
#    y para que las funciones SECURITY DEFINER corran como mc_owner, no como superusuario.
#    PGPASSWORD es la de mc_owner: en Compose se entra por el socket local y no se usa, pero en
#    Kubernetes el script corre en un Job que entra por la red (k8s/11-db-init-job.yaml).
for file in /opt/medicitas/sql/*.sql; do
    echo "medicitas: ejecutando $(basename "$file")"
    PGPASSWORD="$DB_OWNER_PASSWORD" \
        psql -v ON_ERROR_STOP=1 --username mc_owner --dbname medicitas -f "$file"
done



# 3. Marca de inicialización completa, que busca el healthcheck de Compose. Si algún script falla,
#    la marca no se crea y el servicio nunca aparece sano (ver docker-compose.yml). En Kubernetes
#    no hay healthcheck que la lea: el Job termina con éxito y la marca va a /tmp.
touch "${MEDICITAS_INIT_MARKER:-/var/lib/postgresql/.medicitas-init-ok}"
echo "medicitas: inicialización completa"
