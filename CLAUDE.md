# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawBot Cloud — a multi-tenant AI assistant platform on AWS. Users create Bots via a web console, connect messaging channels (Telegram, Discord, Slack, Feishu/Lark), and Bots run Claude Agents with independent memory, conversations, and scheduled tasks. Supports two deployment modes: `agentcore` (default — AgentCore microVMs + Cognito + Bedrock) and `ecs` (ECS Fargate + self-hosted OIDC + Anthropic API, for AWS China regions).

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

npm run build -w auth-service
npm run typecheck -w auth-service

# Run tests (control-plane only — vitest)
npm test -w control-plane
npm run test:watch -w control-plane   # watch mode

# Local development
npm run dev -w control-plane          # tsx watch, port 3000
npm run dev -w web-console            # vite, port 5173

# CDK infrastructure
cd infra
npx cdk synth                                    # synthesize (agentcore mode)
npx cdk synth --context mode=ecs                 # synthesize (ecs mode)
npx cdk deploy --all                             # deploy (agentcore mode)
npx cdk deploy --all --context mode=ecs          # deploy (ecs mode)
npx cdk bootstrap                                # one-time per account/region
```

**Build order matters:** `shared` must be built before packages that depend on it (`control-plane`, `agent-runtime`).

## Architecture

NPM workspaces monorepo with 6 packages. ESM throughout (`"type": "module"`), TypeScript strict mode, target ES2022.

### Package dependency graph

```
shared ◄── control-plane
       ◄── agent-runtime
       ◄── auth-service

infra (standalone — references no other packages)
web-console (standalone — talks to control-plane via REST)
```

### Package roles

- **shared** (`@clawbot/shared`) — Domain types (User, Bot, Channel, Message, Task, Session), Channel Adapter interfaces, XML formatter for agent context, text utilities. Exports via subpath exports: `@clawbot/shared/types`, `@clawbot/shared/channel-adapter`, `@clawbot/shared/xml-formatter`, `@clawbot/shared/text-utils`.
- **control-plane** (`@clawbot/control-plane`) — Fastify HTTP server on ECS Fargate. Handles webhook ingestion (Telegram/Slack), Discord Gateway (discord.js with leader election), Feishu Gateway (Lark SDK WSClient with leader election), REST API for the web console (JWT-authed via Cognito or JWKS, including admin APIs), SQS FIFO message dispatching to AgentCore or ECS dedicated tasks (via AgentInvoker abstraction + Task Manager), SQS reply consumption via Channel Adapter Registry, channel health checking, and native CLAUDE.md memory management (bot-level + group-level). In ECS mode, Task Manager (`task-manager.ts`) manages a warm pool of pre-started Fargate tasks (DynamoDB distributed lock for replenishment) and routes to per-session dedicated tasks via DynamoDB registry. Dispatcher (`EcsTaskInvoker`) looks up session → direct HTTP to task IP, with crash recovery (clear stale task, reassign from warm pool). Deferred SQS deletion persists receipt handles in DynamoDB to survive restarts.
- **agent-runtime** (`@clawbot/agent-runtime`) — Runs inside AgentCore microVMs (agentcore mode) or dedicated ECS Fargate tasks (ecs mode, one task per botId#groupJid session). Wraps Claude Agent SDK with MCP tools (send_message, schedule_task, etc.). Manages S3 session sync, native CLAUDE.md memory (via Claude Code settingSources), STS ABAC scoped credentials, and per-bot tool/skill whitelist enforcement (PreToolUse hook). Exposes `/invocations` and `/ping` endpoints; returns 503 when busy (both modes, defense in depth). In ECS mode: `task-registration.ts` self-registers taskArn + privateIp in DynamoDB via ECS Task Metadata Endpoint v4 on startup; `idle-monitor.ts` auto-stops after configurable idle timeout (setTimeout with `.unref()` + `process.exit`).
- **infra** (`@clawbot/infra`) — AWS CDK (TypeScript). 6 stacks: Foundation (VPC, S3, DynamoDB, SQS, ECR), Auth (Cognito or self-hosted auth ECS), Agent (AgentCore IAM roles or ECS dedicated task infrastructure — Cluster, TaskDef, SecurityGroup, no Service/ALB), ControlPlane (ALB, ECS, WAF, ECS RunTask/StopTask/DescribeTasks + PassRole permissions in ecs mode), Frontend (CloudFront + S3), Monitoring (CloudWatch). CDK params for ECS mode: `minWarmTasks` (default 2), `maxTasks` (default 500), `idleTimeoutMinutes` (default 15).
- **web-console** (`@clawbot/web-console`) — React 19 SPA with Vite, TailwindCSS, AWS Amplify for Cognito auth. Pages: Login, Dashboard, BotDetail (tabs: Overview/Channels/Conversations/Tasks/Memory/Files/Tools/Settings), ChannelSetup, Messages, Tasks, MemoryEditor (3 tabs: Shared/BotMemory/GroupMemory), Settings (Anthropic API provider config), Admin UserList/UserDetail.
- **auth-service** (`@clawbot/auth-service`) — Self-hosted OIDC-compatible auth service (ECS mode only). Fastify server with RS256 JWT signing (keys in Secrets Manager), bcrypt password hashing, DynamoDB user store. Endpoints: `/auth/login`, `/auth/refresh`, `/auth/change-password`, `/auth/.well-known/jwks.json`, `/admin/users`. Replaces Cognito User Pools in AWS China regions.

### Message flow

User message → Channel webhook/Gateway → Control Plane (signature verification, DynamoDB store) → SQS FIFO → SQS consumer (quota check, concurrency control) → AgentCore invocation (or ECS dedicated task dispatch in ecs mode) (async fire-and-forget, returns `accepted` immediately) → Agent runs in background → Claude Agent SDK `query()` (preset append mode, native CLAUDE.md) → MCP tools → final reply via SQS reply queue (with session/usage metadata) → Reply Consumer → Channel Adapter Registry → Channel API reply + DynamoDB store + session update + usage tracking.

Agent intermediate messages: MCP `send_message` → SQS Standard reply queue → Reply Consumer → Channel Adapter → Channel API.

SQS FIFO provides per-group message ordering with cross-group parallelism. Discord and Feishu use Gateway (WebSocket) with DynamoDB-based leader election instead of webhooks. The async invocation model ensures `/ping` always responds during agent execution, preventing AgentCore's 15-minute session timeout.

ECS mode dispatch: SQS consumer → DynamoDB session lookup → existing task (direct HTTP to task IP) or claim warm task (DynamoDB atomic operation) / RunTask cold start → HTTP POST to dedicated task. Each botId#groupJid gets its own Fargate task with 503 busy rejection for concurrent requests. Warm pool maintains `minWarmTasks` (default 2, CDK param) pre-started tasks for instant dispatch; `maxTasks` (default 500, CDK param) caps total cluster tasks. Tasks self-register in DynamoDB on startup (ECS Task Metadata v4 for taskArn + privateIp), and auto-stop after `idleTimeoutMinutes` (default 15, CDK param) of inactivity. Warm pool replenishment uses DynamoDB distributed lock (120s TTL) to prevent multi-replica over-provisioning. Control-plane scans for idle session tasks every 10 minutes as a safety net.

SQS FIFO ordering guarantee (ECS mode): Inbound SQS message deletion is deferred until the agent sends its final reply. The receipt handle is persisted in DynamoDB (`session.pendingReceiptHandle`) so it survives control-plane restarts. Reply consumer deletes the inbound message on `isFinalReply` or `isError`, which releases the next same-group message from the FIFO queue. If the agent crashes without replying, the SQS visibility timeout (600s) returns the message for retry.

### Security model

- Cognito JWT on all `/api/*` routes (agentcore mode) or self-hosted JWKS JWT (ecs mode)
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
| jose | 5.9 | control-plane (JWKS JWT), auth-service (JWT signing) |
| bcrypt | 5.1 | auth-service (password hashing) |

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
# Full deploy — agentcore mode (default: AgentCore + Cognito + Bedrock)
bash scripts/deploy.sh

# Full deploy — ecs mode (ECS agent + self-hosted auth + Anthropic API)
DEPLOY_MODE=ecs bash scripts/deploy.sh

# Environment variables (auto-detected, override if needed)
CDK_STAGE=dev              # deployment stage (default: dev)
AWS_REGION=us-west-2       # AWS region
DEPLOY_MODE=agentcore      # deployment mode: agentcore (default) or ecs
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

> **ECS mode differences:** Step 5b builds auth-service image. Steps 8-11 are skipped (no AgentCore). Agent Stack creates ECS Cluster + Task Definition + SecurityGroup (no Service/ALB — dedicated tasks are started on demand via `ecs:RunTask`, one per botId#groupJid session). Agent base role gets DynamoDB PutItem/UpdateItem on sessions table for warm task self-registration. After CDK deploy, deploy.sh reads Agent stack outputs (cluster name, task def ARN, subnets, SG) and passes them to Control Plane as env vars. Control Plane Task Manager maintains a warm pool and dispatches to per-session tasks via DynamoDB registry + direct HTTP to task private IP. Step 12 uses OIDC env vars instead of Cognito. Step 16 seeds admin via auth-service API. Step 17 is skipped.

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