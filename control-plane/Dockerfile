# syntax=docker/dockerfile:1
# ClawBot Cloud — Control Plane
# Multi-stage build targeting Fargate Graviton (ARM64)

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim AS builder

WORKDIR /app

# Copy workspace root files for npm workspaces
COPY package.json package-lock.json ./

# Copy shared package
COPY shared/package.json shared/
COPY shared/tsconfig.json shared/
COPY shared/src/ shared/src/

# Copy control-plane package
COPY control-plane/package.json control-plane/
COPY control-plane/tsconfig.json control-plane/
COPY tsconfig.base.json ./

# Install all dependencies
RUN npm ci --workspace=@clawbot/shared --workspace=@clawbot/control-plane

# Build shared first, then control-plane
COPY shared/ shared/
RUN npm run build --workspace=@clawbot/shared

COPY control-plane/src/ control-plane/src/
RUN npm run build --workspace=@clawbot/control-plane

# ── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and hoisted node_modules
COPY --from=builder /app/control-plane/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/shared/dist/ ./node_modules/@clawbot/shared/dist/
COPY --from=builder /app/shared/package.json ./node_modules/@clawbot/shared/
COPY --from=builder /app/control-plane/package.json ./

# Non-root user for security
RUN groupadd -r nanoclawbot && useradd -r -g nanoclawbot nanoclawbot
USER nanoclawbot

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1); })"

CMD ["node", "dist/index.js"]
