#!/usr/bin/env bash
# Mide RF7 bajo carga dentro del clúster y muestra cómo el HPA escala agenda y después la vuelve a bajar.
#
#   ./k8s/load-test.sh                 # 100 usuarios simultáneos durante 3 minutos
#   VUS=50 DURATION=2m ./k8s/load-test.sh
#
# Requiere ./k8s/deploy.sh. Registra cada 10 s la CPU y las copias de agenda que reporta el HPA, desde antes de la
# carga hasta que vuelve al mínimo, y al final muestra el resumen de k6.
set -euo pipefail
cd "$(dirname "$0")/.."
NAMESPACE=medicitas
VUS=${VUS:-100}
DURATION=${DURATION:-3m}
# Cuánto seguir registrando después de la carga, para ver cómo baja (el HPA espera 60 s y quita una copia cada 20 s).
COOLDOWN=${COOLDOWN:-150}

hpa_line() {
  kubectl -n "$NAMESPACE" get hpa agenda \
    -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}{" "}{.status.currentReplicas}{" "}{.status.desiredReplicas}'
}

kubectl create configmap load-scripts -n "$NAMESPACE" --from-file=tests/load/availability.js \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NAMESPACE" delete job/load --ignore-not-found --wait=true >/dev/null
sed -e "s/__VUS__/${VUS}/" -e "s/__DURATION__/${DURATION}/" k8s/91-load-job.yaml | kubectl apply -f - >/dev/null
echo "Carga: ${VUS} usuarios simultáneos durante ${DURATION}. Cada 10 s: CPU media de agenda (% de su request) y copias."
printf '%-10s %-12s %-8s %s\n' tiempo "cpu agenda" copias "copias deseadas"

start=$(date +%s)
finished=""
while :; do
  read -r cpu current desired <<<"$(hpa_line)"
  printf '%-10s %-12s %-8s %s\n' "+$(( $(date +%s) - start ))s" "${cpu:-?}%" "${current:-?}" "${desired:-?}"
  if [ -z "$finished" ]; then
    status=$(kubectl -n "$NAMESPACE" get job/load -o jsonpath='{.status.succeeded}{"/"}{.status.failed}')
    [[ "$status" == 1/* || "$status" == */1 ]] && finished=$(date +%s) && echo "-- terminó la carga; se sigue registrando la bajada --"
  elif [ $(( $(date +%s) - finished )) -ge "$COOLDOWN" ]; then
    break
  fi
  sleep 10
done

echo
kubectl -n "$NAMESPACE" logs job/load | grep -E 'http_reqs|http_req_duration|cache_hits|checks_succeeded|pares'
