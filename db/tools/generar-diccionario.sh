#!/usr/bin/env bash
# Regenera docs/diccionario-datos.md a partir de la base en ejecución.
# Requiere la pila levantada (docker compose up). Uso: ./db/tools/generar-diccionario.sh
set -Eeuo pipefail

cd "$(dirname "$0")/../.."

out=docs/diccionario-datos.md
docker compose exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U mc_owner -d medicitas \
    < db/tools/diccionario.sql > "$out.tmp"
# Se reemplaza solo si la generación terminó bien.
mv "$out.tmp" "$out"
echo "Generado $out"
