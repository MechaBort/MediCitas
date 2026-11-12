#!/usr/bin/env bash
# =============================================================================
# Despliega MediCitas en Kubernetes (minikube). Un solo comando, que se puede repetir sin romper nada:
#
#   cp .env.example .env     # si todavía no existe; las contraseñas salen de aquí, igual que en Compose
#   minikube start --cpus=6 --memory=8192
#   ./k8s/deploy.sh
#
# Compose y Kubernetes no corren a la vez ni comparten datos (AGENTS.md).
#
# Pasos (docs/diseno-servicios.md §7):
#   1. PostgreSQL con CloudNativePG, su inicialización y PgBouncer.          <- implementado
#   2. Servicios, gateway, Keycloak y Redis.                                  <- etapa siguiente
#   3. HPA de agenda.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NAMESPACE=medicitas
# Versión fijada del operador: la misma en cada despliegue, para que el resultado sea reproducible.
CNPG_VERSION=1.30.1
CNPG_MANIFEST="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-${CNPG_VERSION}.yaml"
ENV_FILE=${ENV_FILE:-.env}

step() { printf '\n== %s\n' "$*"; }

# --- Requisitos -------------------------------------------------------------------------------------------------
command -v kubectl >/dev/null || { echo "Falta kubectl" >&2; exit 1; }
kubectl cluster-info >/dev/null 2>&1 || { echo "No hay clúster: ejecute 'minikube start' primero" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE: ejecute 'cp .env.example .env'" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
# Un .env antiguo puede no tener las variables que se agregaron después (por ejemplo, los usuarios por servicio de la
# etapa 3): mejor decir cuáles faltan que fallar a la mitad con "unbound variable".
missing=()
for var in DB_OWNER_PASSWORD DB_ADMIN_SVC_PASSWORD DB_AGENDA_SVC_PASSWORD DB_CLINICAL_SVC_PASSWORD KEYCLOAK_DB_PASSWORD; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "A $ENV_FILE le faltan: ${missing[*]}. Cópielas de .env.example." >&2
  exit 1
fi

# Crea o actualiza un recurso generado por kubectl create (Secrets y ConfigMaps), para poder repetir el script.
apply_generated() { kubectl create --dry-run=client -o yaml "$@" | kubectl apply -f -; }

# --- Paso 1: PostgreSQL -----------------------------------------------------------------------------------------
step "Operador CloudNativePG ${CNPG_VERSION}"
kubectl apply --server-side -f "$CNPG_MANIFEST"
kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=300s

step "Namespace, contraseñas y archivos de inicialización"
kubectl apply -f k8s/00-namespace.yaml
# Las contraseñas de los roles de la base, desde .env: las mismas variables que usa Compose.
apply_generated -n "$NAMESPACE" secret generic db-passwords \
  --from-literal=DB_OWNER_PASSWORD="$DB_OWNER_PASSWORD" \
  --from-literal=DB_ADMIN_SVC_PASSWORD="$DB_ADMIN_SVC_PASSWORD" \
  --from-literal=DB_AGENDA_SVC_PASSWORD="$DB_AGENDA_SVC_PASSWORD" \
  --from-literal=DB_CLINICAL_SVC_PASSWORD="$DB_CLINICAL_SVC_PASSWORD" \
  --from-literal=KEYCLOAK_DB_PASSWORD="$KEYCLOAK_DB_PASSWORD"
# Los mismos archivos que monta Compose: una sola fuente para los dos entornos.
apply_generated -n "$NAMESPACE" configmap db-init-script --from-file=db/init/00-init.sh
apply_generated -n "$NAMESPACE" configmap db-sql --from-file=db/sql/

step "Cluster de PostgreSQL"
# El webhook del operador puede tardar unos segundos en responder después de su rollout: se reintenta.
for attempt in 1 2 3 4 5 6; do
  kubectl apply -f k8s/10-postgres-cluster.yaml && break
  echo "El operador todavía no acepta el Cluster (intento $attempt); se reintenta en 10 s"
  sleep 10
done
kubectl -n "$NAMESPACE" wait cluster/medicitas-db --for=condition=Ready --timeout=600s

step "Inicialización de la base (Job db-init)"
# Como en Compose, la base se inicializa una sola vez. Un Job no se puede modificar después de creado, así que si ya
# existe no se vuelve a aplicar. Para recrear la base con otro db/sql: kubectl delete namespace medicitas.
if kubectl -n "$NAMESPACE" get job/db-init >/dev/null 2>&1; then
  echo "El Job db-init ya existe: la base ya se inicializó (para recrearla: kubectl delete namespace $NAMESPACE)"
else
  kubectl apply -f k8s/11-db-init-job.yaml
fi
if ! kubectl -n "$NAMESPACE" wait job/db-init --for=condition=Complete --timeout=300s; then
  kubectl -n "$NAMESPACE" logs job/db-init --tail=50 || true
  echo "La inicialización de la base falló; ver los logs arriba" >&2
  exit 1
fi

step "PgBouncer (Pooler)"
kubectl apply -f k8s/12-postgres-pooler.yaml
# El operador crea un Deployment con el mismo nombre que el Pooler.
for attempt in $(seq 1 30); do
  kubectl -n "$NAMESPACE" get deployment/medicitas-db-pooler-rw >/dev/null 2>&1 && break
  sleep 2
done
kubectl -n "$NAMESPACE" rollout status deployment/medicitas-db-pooler-rw --timeout=300s

step "Listo: paso 1"
kubectl -n "$NAMESPACE" get cluster,pooler,pods
