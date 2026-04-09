# syntax=docker/dockerfile:1
# ClawBot Cloud — Auth Service (ECS mode only)
# Multi-stage build targeting Fargate Graviton (ARM64)

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim AS builder

WORKDIR /app

# Copy workspace root files for npm workspaces
COPY package.json package-lock.json tsconfig.base.json ./

# Copy shared package
COPY shared/package.json shared/
COPY shared/tsconfig.json shared/
COPY shared/src/ shared/src/

# Copy auth-service package
COPY auth-service/package.json auth-service/
COPY auth-service/tsconfig.json auth-service/

# Install all dependencies
RUN npm ci --workspace=@clawbot/shared --workspace=@clawbot/auth-service

# Build shared first, then auth-service
COPY shared/ shared/
RUN npm run build --workspace=@clawbot/shared

COPY auth-service/src/ auth-service/src/
RUN npm run build --workspace=@clawbot/auth-service

# ── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and node_modules (hoisted + workspace-local)
COPY --from=builder /app/auth-service/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/auth-service/node_modules/ ./node_modules/
COPY --from=builder /app/shared/dist/ ./node_modules/@clawbot/shared/dist/
COPY --from=builder /app/shared/package.json ./node_modules/@clawbot/shared/
COPY --from=builder /app/auth-service/package.json ./

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/auth/health').then(r => { if (!r.ok) process.exit(1); })"

CMD ["dumb-init", "node", "dist/server.js"]
