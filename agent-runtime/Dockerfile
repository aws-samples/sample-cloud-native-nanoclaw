# syntax=docker/dockerfile:1
# ClawBot Cloud — Agent Runtime
# Multi-stage build targeting AgentCore (ARM64)
# Build from repo root: docker build -f agent-runtime/Dockerfile .

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim AS builder

WORKDIR /app

# Copy workspace root files for npm workspaces
COPY package.json package-lock.json ./

# Copy shared package
COPY shared/package.json shared/
COPY shared/tsconfig.json shared/
COPY shared/src/ shared/src/

# Copy agent-runtime package
COPY agent-runtime/package.json agent-runtime/
COPY agent-runtime/tsconfig.json agent-runtime/
COPY tsconfig.base.json ./

# Install all dependencies
RUN npm ci --workspace=@clawbot/shared --workspace=@clawbot/agent-runtime

# Build shared first, then agent-runtime
COPY shared/ shared/
RUN npm run build --workspace=@clawbot/shared

COPY agent-runtime/src/ agent-runtime/src/
RUN npm run build --workspace=@clawbot/agent-runtime

# ── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim

# System dependencies (same as NanoClaw's container/Dockerfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser / Puppeteer
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install claude-code and agent-browser globally
RUN npm install -g @anthropic-ai/claude-code agent-browser

# App setup
WORKDIR /app

# Copy built artifacts and hoisted node_modules
COPY --from=builder /app/agent-runtime/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/shared/dist/ ./node_modules/@clawbot/shared/dist/
COPY --from=builder /app/shared/package.json ./node_modules/@clawbot/shared/
COPY --from=builder /app/agent-runtime/package.json ./

# Workspace directories (mirrors NanoClaw's /workspace layout)
RUN mkdir -p /workspace/group /workspace/global /workspace/shared /workspace/extra /home/node/.claude

# Set ownership to non-root user
RUN chown -R node:node /workspace /home/node/.claude /home/node

# Environment
ENV CLAUDE_CODE_USE_BEDROCK=1
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
