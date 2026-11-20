# Una sola imagen con todos los microservicios; cada contenedor elige cuál correr:
#   docker run billetera node dist/apps/auth-service/main.js
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Páginas estáticas (pago QR, KYC y admin en el gateway; pantalla del POS demo)
COPY --from=build /app/web ./web
COPY --from=build /app/apps/pos-demo/public ./apps/pos-demo/public
CMD ["node", "dist/apps/api-gateway/main.js"]
