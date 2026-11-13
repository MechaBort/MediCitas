#!/usr/bin/env bash
# Demuestra el failover de la base en Kubernetes (paso 4, docs/diseno-servicios.md §7): la principal se cae, el operador
# promueve la secundaria y no se pierde ninguna escritura confirmada.
#
#   ./k8s/failover-test.sh               # simula la caída y después corre la suite contra la nueva principal
#   SKIP_TESTS=1 ./k8s/failover-test.sh  # sin la suite
#
# Qué hace:
#   1. Muestra la principal y el estado de la replicación síncrona, y cuenta las citas y la bitácora.
#   2. Arranca tres sondas que corren durante todo el corte:
#      - escrituras: un pod que inserta un número a la vez en una tabla de prueba (en la base postgres, no en medicitas)
#        a través de medicitas-db-rw, y anota cuáles le confirmaron;
#      - API: GET /agenda por el gateway con un token ya emitido (gateway → agenda → PgBouncer → base);
#      - inicio de sesión: pedir un token a Keycloak, que guarda su estado en la misma base (directo a -rw).
#   3. Simula la caída: borra el pod de la principal con un segundo de gracia. Un borrado normal haría un apagado
#      ordenado, que espera a que los clientes se desconecten; eso es un mantenimiento, no una caída.
#   4. Mide cuándo el operador promueve la secundaria y cuándo vuelven la API y el inicio de sesión, y espera a que el
#      pod borrado regrese como secundaria.
#   5. Comprueba que no se perdió nada: toda escritura confirmada está en la nueva principal, y los conteos de citas y de
#      bitácora no cambiaron.
#   6. Corre ./k8s/run-tests.sh contra la nueva principal.
#
# Requiere ./k8s/deploy.sh. Usa los puertos 13000 y 18080 para no chocar con Compose (GW_PORT y KC_PORT).
set -euo pipefail
cd "$(dirname "$0")/.."
NAMESPACE=medicitas
GW_PORT=${GW_PORT:-13000}
KC_PORT=${KC_PORT:-18080}
TIMEOUT=300
WORK=$(mktemp -d)

k() { kubectl -n "$NAMESPACE" "$@"; }
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }
primary() { k get cluster medicitas-db -o jsonpath='{.status.currentPrimary}'; }
# psql como superusuario dentro de un pod de la base, por el socket local (no pide contraseña).
sql() { local pod=$1 db=$2; shift 2; k exec "$pod" -c postgres -- psql -U postgres -d "$db" -Atq "$@"; }
counts() {
  sql "$1" medicitas -c "SELECT (SELECT count(*) FROM agenda.appointments) || ' citas y '
                             || (SELECT count(*) FROM clinical.audit_logs) || ' entradas de bitácora'"
}
login() {
  curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST \
    "http://localhost:$KC_PORT/realms/medicitas/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=medicitas-api -d username=recepcion.sanjose -d password=medicitas || true
}

PIDS=()
cleanup() {
  # Los procesos de fondo se detienen por PID, nunca con pkill -f (se atraparía a sí mismo).
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  k delete pod failover-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FALLA: $*" >&2; exit 1; }

for port in "$GW_PORT" "$KC_PORT"; do
  ss -ltn | grep -q ":$port " && fail "el puerto $port está ocupado (cámbielo con GW_PORT o KC_PORT)"
done

# --- 1. Estado inicial ------------------------------------------------------------------------------------------------
step "Estado inicial"
OLD=$(primary)
echo "Principal: $OLD"
REPLICATION=$(sql "$OLD" postgres -c "SELECT application_name || ' ' || state || ' ' || sync_state FROM pg_stat_replication")
echo "Secundarias (nombre, estado, modo): ${REPLICATION:-ninguna}"
[[ "$REPLICATION" == *" streaming quorum"* ]] || fail "no hay una secundaria síncrona al día; espere a que el Cluster esté listo"
BEFORE=$(counts "$OLD")
echo "Datos: $BEFORE"

# --- 2. Sondas --------------------------------------------------------------------------------------------------------
step "Sondas: escrituras, API e inicio de sesión"
sql "$OLD" postgres -c "DROP TABLE IF EXISTS failover_probe;
                        CREATE TABLE failover_probe (n int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())"

# El pod usa la misma imagen que la base (ya está en el nodo) y entra como superusuario a medicitas-db-rw. Cada
# inserción abre su propia conexión, así que después del failover llega sola a la nueva principal.
IMAGE=$(k get pod "$OLD" -o jsonpath='{.spec.containers[?(@.name=="postgres")].image}')
k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: failover-probe
  namespace: $NAMESPACE
spec:
  restartPolicy: Never
  containers:
    - name: probe
      image: $IMAGE
      command: ["sh", "-c"]
      args:
        - |
          i=0
          while :; do
            i=\$((i + 1))
            if psql -h medicitas-db-rw -U postgres -d postgres -Atqc "INSERT INTO failover_probe (n) VALUES (\$i)" >/dev/null 2>&1
            then echo "ok \$i \$(date +%s.%N)"
            else echo "fail \$i \$(date +%s.%N)"
            fi
            sleep 0.2
          done
      env:
        - { name: PGPASSWORD, valueFrom: { secretKeyRef: { name: medicitas-db-superuser, key: password } } }
        - { name: PGCONNECT_TIMEOUT, value: "2" }
EOF
k wait pod/failover-probe --for=condition=Ready --timeout=120s >/dev/null

# kubectl directo y no la función k: con una función, $! sería el subshell y kubectl quedaría huérfano al terminar.
kubectl -n "$NAMESPACE" port-forward svc/gateway "$GW_PORT:3000" >/dev/null 2>&1 & PIDS+=($!)
kubectl -n "$NAMESPACE" port-forward svc/keycloak "$KC_PORT:8080" >/dev/null 2>&1 & PIDS+=($!)
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://localhost:$GW_PORT/health" && [ "$(login)" = 200 ] && break
  sleep 1
done
TOKEN=$(curl -s -X POST "http://localhost:$KC_PORT/realms/medicitas/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=medicitas-api -d username=recepcion.sanjose -d password=medicitas | jq -r .access_token)
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || fail "no se obtuvo un token de Keycloak"
TODAY=$(date +%F)

# Una petición cada 0,5 s, sin esperar a la anterior: una petición colgada no esconde lo que pasa con las siguientes.
# Cada línea: momento de inicio, código HTTP y duración. "000" es que no hubo respuesta en 60 s, el mismo tiempo que
# espera el gateway (proxy_read_timeout de nginx). Los PID de las peticiones se guardan para esperarlas al final.
( while :; do
    ( t=$(now)
      r=$(curl -s -o /dev/null -m 60 -w '%{http_code} %{time_total}' -H "Authorization: Bearer $TOKEN" \
            "http://localhost:$GW_PORT/agenda?date=$TODAY" || true)
      echo "$t $r" >>"$WORK/api.log" ) &
    echo $! >>"$WORK/api.pids"
    sleep 0.5
  done ) & PIDS+=($!)
( while :; do echo "$(now) $(login)"; sleep 0.5; done ) >"$WORK/login.log" & PIDS+=($!)

sleep 5
echo "Sondas funcionando: $(k logs failover-probe | grep -c '^ok') escrituras confirmadas en 5 s"

# --- 3. La caída ------------------------------------------------------------------------------------------------------
step "Caída de la principal ($OLD)"
T0=$(now)
k delete pod "$OLD" --grace-period=1 --wait=false >/dev/null
echo "Pod borrado con 1 s de gracia."

# --- 4. Failover y recuperación ---------------------------------------------------------------------------------------
step "Failover"
until NEW=$(primary) && [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; do
  [ "$(secs "$T0" "$(now)" | cut -d. -f1)" -lt "$TIMEOUT" ] || fail "el operador no promovió a ninguna secundaria"
  sleep 0.5
done
T_PROMOTED=$(now)
echo "Nueva principal: $NEW, a los $(secs "$T0" "$T_PROMOTED") s del corte."

# La API se considera recuperada cuando las últimas 8 peticiones que terminaron (por hora de inicio) son 200.
until [ "$(awk -v t0="$T0" '$1 > t0' "$WORK/api.log" | sort -n | tail -n 8 | awk '$2 == 200' | wc -l)" -eq 8 ]; do
  [ "$(secs "$T0" "$(now)" | cut -d. -f1)" -lt "$TIMEOUT" ] || fail "la API no se recuperó"
  sleep 1
done

# Keycloak guarda conexiones a la principal vieja, y cada una hace fallar un inicio de sesión antes de descartarse (límite
# conocido, docs/diseno-servicios.md §7). Se piden ráfagas de 25 tokens en paralelo hasta que una sale completa.
LOGIN_FAILED=0
while :; do
  # Cada proceso escribe su código y el salto de línea en una sola escritura (printf): con dos escrituras separadas, las
  # salidas de los 25 procesos se mezclarían ("200200") y se contarían como fallas.
  burst=$(seq 1 25 | xargs -P 25 -I{} bash -c "$(declare -f login); KC_PORT=$KC_PORT; printf '%s\n' \"\$(login)\"" |
            grep -vc '^200$' || true)
  LOGIN_FAILED=$((LOGIN_FAILED + burst))
  [ "$burst" -eq 0 ] && break
  [ "$(secs "$T0" "$(now)" | cut -d. -f1)" -lt "$TIMEOUT" ] || fail "el inicio de sesión no se recuperó"
  sleep 1
done
T_LOGIN=$(now)

step "El pod borrado vuelve como secundaria"
until [ "$(sql "$NEW" postgres -c "SELECT state || ' ' || sync_state FROM pg_stat_replication
                                    WHERE application_name = '$OLD'" 2>/dev/null)" = "streaming quorum" ]; do
  [ "$(secs "$T0" "$(now)" | cut -d. -f1)" -lt "$TIMEOUT" ] || fail "$OLD no volvió como secundaria"
  sleep 2
done
echo "$OLD es secundaria síncrona de $NEW, a los $(secs "$T0" "$(now)") s del corte."

# Se detienen las sondas, y se espera a que terminen las peticiones a la API que siguen en curso (como mucho 60 s).
for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
PIDS=()
while read -r pid; do
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
done <"$WORK/api.pids"
k logs failover-probe >"$WORK/writes.log"
k delete pod failover-probe --wait=false >/dev/null

# --- 5. ¿Se perdió algo? ----------------------------------------------------------------------------------------------
step "Resultado"
grep '^ok ' "$WORK/writes.log" | awk '{ print $2 }' | sort >"$WORK/confirmed"
grep '^fail ' "$WORK/writes.log" | awk '{ print $2 }' | sort >"$WORK/failed"
sql "$NEW" postgres -c "SELECT n FROM failover_probe" | sort >"$WORK/stored"
CONFIRMED=$(wc -l <"$WORK/confirmed")
LOST=$(comm -23 "$WORK/confirmed" "$WORK/stored" | wc -l)
FAILED=$(wc -l <"$WORK/failed")
AMBIGUOUS=$(comm -12 "$WORK/failed" "$WORK/stored" | wc -l)
sql "$NEW" postgres -c "DROP TABLE failover_probe"
AFTER=$(counts "$NEW")

# Resumen de la API desde el corte: códigos, la petición más lenta y la última respuesta distinta de 200.
API_SUMMARY=$(awk -v t0="$T0" '$1 > t0 { n[$2]++; if ($2 != 200) last = $1 - t0
                                           if ($3 > max) { max = $3; start = $1 - t0; code = $2 } }
  END { for (c in n) printf "%s×%d ", c, n[c]
        printf "| la más lenta: %.1f s (empezó a +%.1f s y respondió %s) | último error: %s\n", max, start, code,
        (last == "" ? "ninguno" : sprintf("+%.1f s", last)) }' "$WORK/api.log")
API_500=$(awk -v t0="$T0" '$1 > t0 && $2 == 500' "$WORK/api.log" | wc -l)
LOGIN_SUMMARY=$(awk -v t0="$T0" '$1 > t0 { n[$2]++ } END { for (c in n) printf "%s×%d ", c, n[c] }' "$WORK/login.log")

printf '%-38s %s\n' \
  "Promoción de la secundaria:" "$(secs "$T0" "$T_PROMOTED") s" \
  "API (GET /agenda) desde el corte:" "$API_SUMMARY" \
  "Inicio de sesión (uno cada 0,5 s):" "$LOGIN_SUMMARY" \
  "Inicio de sesión estable (25 a la vez):" "a los $(secs "$T0" "$T_LOGIN") s, tras $LOGIN_FAILED fallidos en las ráfagas" \
  "Escrituras confirmadas:" "$CONFIRMED, perdidas: $LOST" \
  "Escrituras sin confirmar:" "$FAILED, de ellas guardadas igual (commit ambiguo): $AMBIGUOUS" \
  "Datos antes:" "$BEFORE" \
  "Datos después:" "$AFTER"

echo
echo "Peticiones a la API por tramos de 5 s, según su hora de inicio (000 = sin respuesta en 60 s):"
awk -v t0="$T0" '$1 > t0 { printf "%d %s %s\n", int(($1 - t0) / 5) * 5, $2, $3 }' "$WORK/api.log" | sort -n |
  awk 'function flush() { s = ""; for (c in n) s = s sprintf(" %s×%d", c, n[c])
                          printf "  +%2d a +%2d s:%s (la más lenta: %.1f s)\n", b, b + 5, s, m; delete n; m = 0 }
       NR > 1 && $1 != b { flush() }
       { b = $1; n[$2]++; if ($3 > m) m = $3 }
       END { if (NR) flush() }'

[ "$LOST" -eq 0 ] || fail "se perdieron $LOST escrituras confirmadas"
[ "$BEFORE" = "$AFTER" ] || fail "los conteos de citas o de bitácora cambiaron"
[ "$API_500" -eq 0 ] || fail "la API respondió $API_500 veces 500 durante el failover (se esperaba 503 o espera)"
echo "Failover correcto: ninguna escritura confirmada se perdió."

# --- 6. La suite contra la nueva principal ----------------------------------------------------------------------------
if [ -z "${SKIP_TESTS:-}" ]; then
  step "Suite de pruebas contra $NEW"
  ./k8s/run-tests.sh
fi
