# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawBot Cloud — a multi-tenant AI assistant platform on AWS. Users create Bots via a web console, connect messaging channels (Telegram, Discord, Slack, Feishu/Lark), and Bots run Claude Agents in AgentCore microVMs with independent memory, conversations, and scheduled tasks.

## Commands

```bash
# Install all dependencies (from repo root)
npm install

# Build all packages
npm run build --workspaces

# Build a single package
npm run build -w shared
npm run build -w control-plane
npm run build -w agent-runtime
npm run build -w web-console
npm run build -w infra

# Type-check without emitting
npm run typecheck -w control-plane
npm run typecheck -w agent-runtime
npm run typecheck -w infra
npm run typecheck -w shared

# Run tests (control-plane only — vitest)
npm test -w control-plane
npm run test:watch -w control-plane   # watch mode

# Local development
npm run dev -w control-plane          # tsx watch, port 3000
npm run dev -w web-console            # vite, port 5173

# CDK infrastructure
cd infra
npx cdk synth                         # synthesize CloudFormation
npx cdk deploy --all                  # deploy all stacks
npx cdk bootstrap                     # one-time per account/region
```

**Build order matters:** `shared` must be built before packages that depend on it (`control-plane`, `agent-runtime`).

## Architecture

NPM workspaces monorepo with 5 packages. ESM throughout (`"type": "module"`), TypeScript strict mode, target ES2022.

### Package dependency graph

```
shared ◄── control-plane
       ◄── agent-runtime

infra (standalone — references no other packages)
web-console (standalone — talks to control-plane via REST)
```

### Package roles

- **shared** (`@clawbot/shared`) — Domain types (User, Bot, Channel, Message, Task, Session), Channel Adapter interfaces, XML formatter for agent context, text utilities. Exports via subpath exports: `@clawbot/shared/types`, `@clawbot/shared/channel-adapter`, `@clawbot/shared/xml-formatter`, `@clawbot/shared/text-utils`.
- **control-plane** (`@clawbot/control-plane`) — Fastify HTTP server on ECS Fargate. Handles webhook ingestion (Telegram/Slack), Discord Gateway (discord.js with leader election), Feishu Gateway (Lark SDK WSClient with leader election), REST API for the web console (JWT-authed via Cognito, including admin APIs), SQS FIFO message dispatching to AgentCore, SQS reply consumption via Channel Adapter Registry, channel health checking, and native CLAUDE.md memory management (bot-level + group-level).
- **agent-runtime** (`@clawbot/agent-runtime`) — Runs inside AgentCore microVMs. Wraps Claude Agent SDK with MCP tools (send_message, schedule_task, etc.). Manages S3 session sync, native CLAUDE.md memory (via Claude Code settingSources), STS ABAC scoped credentials, and per-bot tool/skill whitelist enforcement (PreToolUse hook). Exposes `/invocations` and `/ping` endpoints.
- **infra** (`@clawbot/infra`) — AWS CDK (TypeScript). 6 stacks: Foundation (VPC, S3, DynamoDB, SQS, ECR), Auth (Cognito), Agent (IAM ABAC roles), ControlPlane (ALB, ECS, WAF), Frontend (CloudFront + S3), Monitoring (CloudWatch).
- **web-console** (`@clawbot/web-console`) — React 19 SPA with Vite, TailwindCSS, AWS Amplify for Cognito auth. Pages: Login, Dashboard, BotDetail (tabs: Overview/Channels/Conversations/Tasks/Memory/Files/Tools/Settings), ChannelSetup, Messages, Tasks, MemoryEditor (3 tabs: Shared/BotMemory/GroupMemory), Settings (Anthropic API provider config), Admin UserList/UserDetail.

### Message flow

User message → Channel webhook/Gateway → Control Plane (signature verification, DynamoDB store) → SQS FIFO → SQS consumer (quota check, concurrency control) → AgentCore invocation → Claude Agent SDK `query()` (preset append mode, native CLAUDE.md) → MCP tools → response stored in DynamoDB → Channel Adapter Registry → Channel API reply.

Agent intermediate messages: MCP `send_message` → SQS Standard reply queue → Reply Consumer → Channel Adapter → Channel API.

SQS FIFO provides per-group message ordering with cross-group parallelism. Discord and Feishu use Gateway (WebSocket) with DynamoDB-based leader election instead of webhooks.

### Security model

- Cognito JWT on all `/api/*` routes
- Per-channel webhook signature verification (Telegram secret token, Discord Ed25519, Slack HMAC-SHA256)
- ABAC via STS SessionTags — agents can only access their owner's S3 paths and DynamoDB records
- Channel tokens and Anthropic API keys in Secrets Manager, never exposed to agents
- Fargate in private subnets, WAF rate limiting

### Data layer

- **DynamoDB** — 7 tables for Users, Bots, Channels, Messages, Tasks, Sessions, Groups
- **S3** — Session state and CLAUDE.md memory files
- **Secrets Manager** — Channel API tokens (Telegram, Discord, Slack, Feishu), per-user Anthropic API keys
- **EventBridge Scheduler** — Scheduled tasks → SQS → Agent

## Key Libraries

| Library | Version | Used in |
|---------|---------|---------|
| Fastify | 5.2 | control-plane, agent-runtime |
| AWS SDK v3 | 3.700+ | control-plane, agent-runtime |
| Claude Agent SDK | 0.2.76 | agent-runtime |
| MCP SDK | 1.0.0 | agent-runtime |
| discord.js | 14.25 | control-plane (Discord Gateway) |
| @larksuiteoapi/node-sdk | 1.59 | control-plane (Feishu Gateway), agent-runtime (Feishu Skills) |
| aws-jwt-verify | 4.0 | control-plane (Cognito JWT) |
| Zod | 4.0 | shared, control-plane, agent-runtime |
| React | 19 | web-console |
| react-router-dom | 7.1 | web-console |
| AWS Amplify | 6.12 | web-console |
| AWS CDK | 2.170 | infra |
| Vitest | 2.1 | control-plane (testing) |
| Pino | 9.6 | control-plane, agent-runtime (logging) |
| cron-parser | 5.5 | control-plane, agent-runtime (schedule validation) |

## Conventions

- IDs generated with ULID (control-plane)
- Logging via Pino (structured JSON)
- Schema validation with Zod 4
- Docker images target ARM64 (Graviton for Fargate)
- Agent runtime container includes Chromium + fonts for browser-based MCP tools
- `.npmrc` has `install-links=true` for workspace symlinks

## Deployment

Full deployment is orchestrated by `scripts/deploy.sh`. Requires AWS credentials, Docker, Node.js, and CDK bootstrap completed.

```bash
# Full deploy (all 15 steps: build → Docker → CDK → AgentCore → ECS → Frontend → CloudFront)
bash scripts/deploy.sh

# Environment variables (auto-detected, override if needed)
CDK_STAGE=dev              # deployment stage (default: dev)
AWS_REGION=us-west-2       # AWS region
```

**What `deploy.sh` does (17 steps):**
1. Pre-flight checks (aws, docker, node, jq)
2. `npm install` + `npm run build --workspaces`
3. ECR login
4. Build & push control-plane ARM64 Docker image → ECR (`nanoclawbot-control-plane`)
5. Build & push agent-runtime ARM64 Docker image → ECR (`nanoclawbot-agent`)
6. `cdk deploy --all` (6 stacks)
7. Read CDK outputs (Cognito, ALB, CloudFront domain, S3 bucket, agent role)
8. Register/update AgentCore runtime with new container image
9. Wait for AgentCore READY (up to 10 min)
10. Stop warm AgentCore sessions (force new image pickup)
11. Register new ECS task definition with AGENTCORE_RUNTIME_ARN
12. Force ECS rolling deployment
13. Build web-console with Cognito + API env vars
14. S3 sync frontend to website bucket
15. CloudFront invalidation + smoke test
16. Seed default admin account (idempotent — `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars)
17. Write AgentCore runtime ARN to SSM Parameter Store (replaces `post-deploy.sh`)

```bash
# Destroy everything (AgentCore runtime + CDK stacks + ECR repos)
bash scripts/destroy.sh

# Post-deploy (now integrated as Step 17 — kept for standalone use)
bash scripts/post-deploy.sh
```

**Output endpoints** (dev stage):
- Console: `https://<cloudfront-domain>`
- API: `https://<cloudfront-domain>/api`
- Health: `https://<cloudfront-domain>/health`
- Webhooks: `https://<cloudfront-domain>/webhook/{telegram|discord|slack}/{botId}`

## Design Document
Full architecture details: [`docs/CLOUD_ARCHITECTURE.md`](./docs/CLOUD_ARCHITECTURE.md)