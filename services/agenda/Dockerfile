# Se construye desde la raíz del repositorio (ver docker-compose.yml): la imagen necesita el
# package.json y el package-lock.json de la raíz, y el paquete compartido packages/common.
FROM node:24-alpine

WORKDIR /app

# Primero solo los manifiestos: si no cambian, Docker reutiliza la capa de dependencias.
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/agenda/package.json services/agenda/
# Instala las dependencias de agenda y de packages/common, sin las de desarrollo.
RUN npm ci --omit=dev --workspace services/agenda

COPY packages/common/src packages/common/src
COPY services/agenda/src services/agenda/src

ENV NODE_ENV=production
USER node
WORKDIR /app/services/agenda
EXPOSE 3000
CMD ["node", "src/server.js"]
