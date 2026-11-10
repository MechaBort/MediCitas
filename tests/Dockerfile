# Imagen de pruebas: ejecuta "npm test" (unitarias y de integración) sin necesitar Node en la
# máquina. Se construye desde la raíz del repositorio y se usa con:
#   docker compose --profile test run --rm tests
FROM node:24-alpine

WORKDIR /app

# Primero solo los manifiestos: si no cambian, Docker reutiliza la capa de dependencias.
# Se instalan las de todos los workspaces, porque las pruebas pueden importar código de cualquiera.
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/admin/package.json services/admin/
COPY services/agenda/package.json services/agenda/
COPY services/clinical/package.json services/clinical/
RUN npm ci --omit=dev

COPY packages packages
COPY services services
COPY tests tests

USER node
CMD ["npm", "test"]
