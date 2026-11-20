# Imagen genérica: docker build --build-arg APP=auth-service .
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG APP
RUN npx nest build ${APP} && npx vite build --config apps/wallet-app/vite.config.ts

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
ARG APP
COPY --from=build /app/dist/apps/${APP} ./dist
# Páginas estáticas (pago QR en el gateway, pantalla del POS demo)
COPY --from=build /app/web ./web
COPY --from=build /app/dist/wallet-app ./dist/wallet-app
COPY --from=build /app/apps/pos-demo/public ./apps/pos-demo/public
CMD ["node", "dist/main.js"]
