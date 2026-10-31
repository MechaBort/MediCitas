#!/usr/bin/env bash
# =============================================================================
# Inicialización de PostgreSQL para MediCitas.
# =============================================================================
set -Eeo pipefail

: "${DB_OWNER_PASSWORD:?Falta DB_OWNER_PASSWORD}"
: "${DB_APP_PASSWORD:?Falta DB_APP_PASSWORD}"
: "${KEYCLOAK_DB_PASSWORD:?Falta KEYCLOAK_DB_PASSWORD}"

# 1. Objetos del clúster (roles y bases de datos): solo el superusuario puede crearlos.
#    Las contraseñas entran como variables de psql 
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
     -v owner_pw="$DB_OWNER_PASSWORD" \
     -v app_pw="$DB_APP_PASSWORD" \
     -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'


-- Dueño del esquema. Solo ejecuta los scripts de db/sql; la aplicación nunca lo usa.
CREATE ROLE mc_owner LOGIN PASSWORD :'owner_pw';



-- Perfiles con los permisos de la matriz (se conceden en 02-grants.sql).
CREATE ROLE mc_platform     NOLOGIN;
CREATE ROLE mc_clinic_admin NOLOGIN;
CREATE ROLE mc_reception    NOLOGIN;
CREATE ROLE mc_professional NOLOGIN;



-- Usuario de conexión del backend. Sin herencia: no tiene ningún permiso hasta que
-- hace SET LOCAL ROLE al perfil que trae el token.
CREATE ROLE mc_app LOGIN NOINHERIT PASSWORD :'app_pw';
GRANT mc_platform, mc_clinic_admin, mc_reception, mc_professional
   TO mc_app WITH INHERIT FALSE, SET TRUE;



CREATE DATABASE medicitas OWNER mc_owner;
REVOKE ALL ON DATABASE medicitas FROM PUBLIC;
GRANT CONNECT ON DATABASE medicitas TO mc_app;



-- Keycloak guarda su estado en su propia base, sin acceso a la de la aplicación.
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL



# 2. Objetos de la base medicitas: los crea mc_owner para que quede como dueño
#    y para que las funciones SECURITY DEFINER corran como mc_owner, no como superusuario.
for file in /opt/medicitas/sql/*.sql; do
    echo "medicitas: ejecutando $(basename "$file")"
    psql -v ON_ERROR_STOP=1 --username mc_owner --dbname medicitas -f "$file"
done



# 3. Marca de inicialización completa, que busca el healthcheck. Si algún script falla,
#    la marca no se crea y el servicio nunca aparece sano (ver docker-compose.yml).
touch /var/lib/postgresql/.medicitas-init-ok
echo "medicitas: inicialización completa"
