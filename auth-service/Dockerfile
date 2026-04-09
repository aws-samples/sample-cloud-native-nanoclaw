FROM --platform=linux/arm64 node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY auth-service/package.json auth-service/
RUN npm ci --workspace=shared --workspace=auth-service
COPY shared/ shared/
COPY auth-service/ auth-service/
RUN npm run build -w shared && npm run build -w auth-service

FROM --platform=linux/arm64 node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/auth-service/dist ./auth-service/dist
COPY --from=builder /app/auth-service/package.json ./auth-service/
ENV NODE_ENV=production
EXPOSE 3001
CMD ["dumb-init", "node", "auth-service/dist/server.js"]
