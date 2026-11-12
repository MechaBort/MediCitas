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
#   1. PostgreSQL con CloudNativePG, su inicialización y PgBouncer.
#   2. Imágenes de los servicios, Redis, Keycloak, admin, agenda, clinical y el gateway.
#   3. metrics-server y el HPA de agenda (entre 2 y 6 copias según la CPU).
#
# La prueba de carga que muestra el escalado: ./k8s/load-test.sh
#
# Después: ./k8s/run-tests.sh corre npm test dentro del clúster, y la API se abre con
#   kubectl -n medicitas port-forward svc/gateway 3000:3000   y   kubectl -n medicitas port-forward svc/keycloak 8080:8080
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
for var in DB_OWNER_PASSWORD DB_ADMIN_SVC_PASSWORD DB_AGENDA_SVC_PASSWORD DB_CLINICAL_SVC_PASSWORD KEYCLOAK_DB_PASSWORD \
           REDIS_PASSWORD KEYCLOAK_ADMIN_USER KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_USER_ADMIN_SECRET; do
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
# Uno compartido por admin y clinical, y otro propio de agenda, con más conexiones reales.
kubectl apply -f k8s/12-postgres-pooler.yaml -f k8s/13-postgres-pooler-agenda.yaml
# El operador crea un Deployment con el mismo nombre que cada Pooler.
for pooler in medicitas-db-pooler-rw medicitas-db-pooler-agenda; do
  for attempt in $(seq 1 30); do
    kubectl -n "$NAMESPACE" get "deployment/$pooler" >/dev/null 2>&1 && break
    sleep 2
  done
  kubectl -n "$NAMESPACE" rollout status "deployment/$pooler" --timeout=300s
done

# --- Paso 2: servicios, gateway, Keycloak y Redis -----------------------------------------------------------------
step "Imágenes de los servicios y de las pruebas (dentro de minikube)"
# docker-env apunta el comando docker al Docker de minikube: las imágenes quedan dentro del clúster, sin registro, y
# los Deployments las usan con imagePullPolicy: Never. Se construyen con los mismos Dockerfile que usa Compose.
eval "$(minikube docker-env)"
declare -A IMAGE_ID
for svc in admin agenda clinical; do
  docker build --quiet -t "medicitas/$svc:local" -f "services/$svc/Dockerfile" . >/dev/null
  IMAGE_ID[$svc]=$(docker image inspect --format '{{.Id}}' "medicitas/$svc:local" | cut -c8-19)
  echo "medicitas/$svc:local  ${IMAGE_ID[$svc]}"
done
docker build --quiet -t medicitas/tests:local -f tests/Dockerfile . >/dev/null
echo "medicitas/tests:local"

step "Secrets (uno por componente) y archivos de configuración"
# Cada componente recibe solo lo que necesita: cada servicio, la contraseña de SU usuario de base.
apply_generated -n "$NAMESPACE" secret generic admin-env \
  --from-literal=PGPASSWORD="$DB_ADMIN_SVC_PASSWORD" \
  --from-literal=KEYCLOAK_USER_ADMIN_SECRET="$KEYCLOAK_USER_ADMIN_SECRET"
apply_generated -n "$NAMESPACE" secret generic agenda-env \
  --from-literal=PGPASSWORD="$DB_AGENDA_SVC_PASSWORD" \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD"
apply_generated -n "$NAMESPACE" secret generic clinical-env \
  --from-literal=PGPASSWORD="$DB_CLINICAL_SVC_PASSWORD"
apply_generated -n "$NAMESPACE" secret generic redis-env \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD"
apply_generated -n "$NAMESPACE" secret generic keycloak-env \
  --from-literal=KC_DB_PASSWORD="$KEYCLOAK_DB_PASSWORD" \
  --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME="$KEYCLOAK_ADMIN_USER" \
  --from-literal=KC_BOOTSTRAP_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" \
  --from-literal=KEYCLOAK_USER_ADMIN_SECRET="$KEYCLOAK_USER_ADMIN_SECRET"
apply_generated -n "$NAMESPACE" secret generic tests-env \
  --from-literal=TEST_DATABASE_URL="postgres://mc_owner:${DB_OWNER_PASSWORD}@medicitas-db-rw:5432/medicitas"
# Los mismos archivos que monta Compose.
apply_generated -n "$NAMESPACE" configmap keycloak-realm --from-file=keycloak/medicitas-realm.json
apply_generated -n "$NAMESPACE" configmap gateway-nginx --from-file=gateway/nginx.conf

step "Redis y Keycloak"
kubectl apply -f k8s/20-redis.yaml -f k8s/21-keycloak.yaml

step "Servicios admin, agenda y clinical"
# La anotación medicitas/image-id hace que una copia se reemplace solo cuando su imagen cambió.
for pair in admin:30-admin agenda:31-agenda clinical:32-clinical; do
  svc=${pair%%:*}
  sed "s/__IMAGE_ID__/${IMAGE_ID[$svc]}/" "k8s/${pair#*:}.yaml" | kubectl apply -f -
done

step "Gateway"
CONFIG_HASH=$(sha256sum gateway/nginx.conf | cut -c1-12)
sed "s/__CONFIG_HASH__/${CONFIG_HASH}/" k8s/40-gateway.yaml | kubectl apply -f -

# --- Paso 3: HPA de agenda -----------------------------------------------------------------------------------------
step "HPA de agenda"
# metrics-server mide la CPU de cada pod; sin él, el HPA no tiene con qué decidir.
minikube addons enable metrics-server >/dev/null
kubectl apply -f k8s/50-agenda-hpa.yaml

step "Esperando a que todo esté listo"
kubectl -n "$NAMESPACE" rollout status deployment/redis --timeout=180s
kubectl -n "$NAMESPACE" rollout status deployment/keycloak --timeout=420s
for d in admin agenda clinical gateway; do
  kubectl -n "$NAMESPACE" rollout status "deployment/$d" --timeout=300s
done

step "Listo"
kubectl -n "$NAMESPACE" get cluster,pooler,deployments,hpa,pods
cat <<EOF

Para usar la API desde esta máquina (en otra terminal; no a la vez que Compose, que usa los mismos puertos):
  kubectl -n $NAMESPACE port-forward svc/gateway 3000:3000
  kubectl -n $NAMESPACE port-forward svc/keycloak 8080:8080
Para correr la suite de pruebas dentro del clúster:
  ./k8s/run-tests.sh
Para ver el HPA escalar agenda bajo carga:
  ./k8s/load-test.sh
EOF
