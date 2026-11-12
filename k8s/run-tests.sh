#!/usr/bin/env bash
# Corre la misma suite de npm test DENTRO del clúster, contra el gateway de Kubernetes (k8s/90-tests-job.yaml).
# Requiere haber ejecutado ./k8s/deploy.sh, que construye la imagen medicitas/tests:local.
set -euo pipefail
cd "$(dirname "$0")/.."
NAMESPACE=medicitas

# Un Job no se puede volver a correr: se borra la corrida anterior y se crea otra.
kubectl -n "$NAMESPACE" delete job/tests --ignore-not-found --wait=true >/dev/null
kubectl apply -f k8s/90-tests-job.yaml

# Espera a que el Job termine, con éxito o con fallas.
for _ in $(seq 1 120); do
  status=$(kubectl -n "$NAMESPACE" get job/tests -o jsonpath='{.status.succeeded}{"/"}{.status.failed}')
  [ "$status" = "1/" ] && result=ok && break
  [[ "$status" == */1 ]] && result=fail && break
  sleep 5
done

kubectl -n "$NAMESPACE" logs job/tests | grep -E '^(✖|ℹ (tests|pass|fail|duration_ms))' || true
if [ "${result:-timeout}" = ok ]; then
  echo "La suite pasó en Kubernetes."
else
  echo "La suite falló o no terminó (${result:-timeout}). Detalle: kubectl -n $NAMESPACE logs job/tests" >&2
  exit 1
fi
