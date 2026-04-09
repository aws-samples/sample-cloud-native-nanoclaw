<div align="center">

<!-- Logo / Title -->
<h1>
  <img src="https://img.shields.io/badge/☁️-NanoClaw_on_Cloud-4A90D9?style=for-the-badge&labelColor=1a1a2e" alt="NanoClaw on Cloud" />
</h1>

<p><strong>Multi-tenant NanoClaw on AWS</strong></p>

<p>
  <em>Create Bots · Connect Channels · Run Claude Agents in Isolated Cloud Environments</em>
</p>

<!-- Badges -->
<p>
  <img src="https://img.shields.io/badge/TypeScript-ESM_Strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/AWS-CDK_v2-FF9900?style=flat-square&logo=amazonaws&logoColor=white" alt="AWS CDK" />
  <img src="https://img.shields.io/badge/Claude-Agent_SDK-D97706?style=flat-square" alt="Claude Agent SDK" />
  <img src="https://img.shields.io/badge/Runtime-AgentCore_microVM-8B5CF6?style=flat-square" alt="AgentCore" />
  <img src="https://img.shields.io/badge/License-Private-gray?style=flat-square" alt="License" />
</p>

<!-- Quick Links -->
<table>
  <tr>
    <td align="center"><a href="./docs/nanoclaw-architecture.pptx"><strong>📊 Architecture PPT</strong></a><br/><sub>System overview slides</sub></td>
    <td align="center"><a href="./docs/CLOUD_ARCHITECTURE.md"><strong>📐 Architecture Doc</strong></a><br/><sub>Full design details</sub></td>
    <td align="center"><a href="#deployment"><strong>🚀 Deploy Guide</strong></a><br/><sub>One-command deploy</sub></td>
    <td align="center"><a href="#local-development"><strong>💻 Local Dev</strong></a><br/><sub>Dev setup</sub></td>
  </tr>
  <tr>
    <td align="center"><a href="#message-flow"><strong>📨 Message Flow</strong></a><br/><sub>End-to-end walkthrough</sub></td>
    <td align="center"><a href="#security"><strong>🔒 Security</strong></a><br/><sub>Auth & isolation</sub></td>
    <td align="center"><a href="#packages"><strong>📦 Packages</strong></a><br/><sub>Monorepo structure</sub></td>
    <td align="center"><a href="./docs/TODO.md"><strong>📋 TODO</strong></a><br/><sub>Roadmap & backlog</sub></td>
  </tr>
</table>

<br/>

<details>
<summary><strong>📚 Architecture Deep-Dive Docs</strong></summary>
<br/>

| Doc | Topic |
|-----|-------|
| [04 — Layered Architecture](./docs/architecture/04-layered-architecture.md) | Service layers, channels, providers |
| [05 — Data Model](./docs/architecture/05-data-model.md) | DynamoDB tables, S3 layout |
| [06–07 — Lifecycles](./docs/architecture/06-07-lifecycles.md) | Bot & session lifecycle |
| [08 — Channel Management](./docs/architecture/08-channel-management.md) | Telegram, Discord, Slack, Feishu |
| [09–10 — Agent Runtime](./docs/architecture/09-10-agent-runtime.md) | AgentCore, Claude SDK, MCP tools |
| [11–12 — Security & Observability](./docs/architecture/11-12-security-observability.md) | ABAC, WAF, CloudWatch |
| [15 — CDK Deployment](./docs/architecture/15-cdk-deployment.md) | 6-stack CDK infrastructure |
| [16 — System Prompt Builder](./docs/architecture/16-system-prompt-builder.md) | Agent context construction |

</details>

</div>

<br/>

> Evolved from [NanoClaw](../README.md) — a single-user local bot framework — into a fully managed, multi-tenant cloud platform. Each user gets their own Bots with independent memory, conversations, and scheduled tasks.

---

## Architecture

```
User (Telegram/Discord/Slack)
  │
  ▼ Webhook
ALB ──► ECS Fargate (Control Plane)
         ├── Webhook Handler → SQS FIFO
         ├── SQS Consumer → AgentCore Runtime (microVM)
         │                    └── Claude Agent SDK
         │                        └── Bedrock Claude
         ├── Reply Consumer → Channel API → User
         └── REST API (JWT auth) ◄── Web Console (React SPA on CloudFront)

Data Layer: DynamoDB (state) │ S3 (sessions, memory) │ Secrets Manager (credentials)
Scheduling: EventBridge Scheduler → SQS → Agent
Auth: Cognito User Pool (JWT)
Security: WAF │ ABAC via STS SessionTags │ Per-tenant S3/DynamoDB isolation
```

> **Deployment modes:** The diagram above shows the default `agentcore` mode. In `ecs` mode (for AWS China regions), AgentCore is replaced by an ECS Fargate agent service, Cognito is replaced by a self-hosted OIDC auth service, and Bedrock is replaced by Anthropic API. See [ECS Mode](#ecs-mode-china-regions) below.

```mermaid
graph TB
    Users["👤 用户终端<br/>飞书/ Discord / Slack "]

    subgraph Ingress["入口层"]
        CloudFront["CloudFront + S3<br/>Web 控制台"]
        ALB["ALB<br/>/api/* · /webhook/*"]
    end

    subgraph ECS["ECS Fargate (Control Plane)"]
        Fastify["Fastify HTTP Server<br/>REST API · Webhook · 健康检查"]
        SQSConsumer["SQS Consumer<br/>入站 FIFO "]
        Adapters["Channel Adapters"]
    end

    subgraph Agent["Agent Execution Layer"]
        MicroVM["AgentCore microVM<br/>Claude Agent SDK + Bedrock<br/>工具 · MCP · Skills"]
    end

    subgraph Data["Data Layer"]
        DynamoDB[(DynamoDB)]
        S3[(S3)]
        Secrets[(Secrets Mgr)]
        EventBridge[(EventBridge)]
    end

    Users -->|HTTPS / Webhook| Ingress
    CloudFront --> ALB
    ALB --> Fastify
    Fastify --> SQSConsumer
    SQSConsumer -->|InvokeAgent| MicroVM
    MicroVM -->|send_message| SQSConsumer
    SQSConsumer --> Adapters
    Adapters -->|回复| Users

    MicroVM --> DynamoDB
    MicroVM --> S3
    Fastify --> Secrets
    MicroVM --> EventBridge

    style Ingress fill:#E3F2FD,stroke:#1565C0,color:#000
    style ECS fill:#FFF3E0,stroke:#E65100,color:#000
    style Agent fill:#F3E5F5,stroke:#6A1B9A,color:#000
    style Data fill:#FCE4EC,stroke:#C62828,color:#000

```

## Packages

| Package | Description |
|---------|-------------|
| `shared/` | TypeScript types and utilities (ported from NanoClaw) |
| `infra/` | AWS CDK — 6 stacks (Foundation, Auth, Agent, ControlPlane, Frontend, Monitoring) |
| `control-plane/` | Fastify HTTP server + SQS consumers (runs on ECS Fargate) |
| `agent-runtime/` | Claude Agent SDK wrapper (runs in AgentCore microVMs) |
| `web-console/` | React SPA — bot management, channel config, message history, tasks |
| `auth-service/` | Self-hosted OIDC auth service (JWT + DynamoDB user store, ECS mode only) |

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Tenant model | One user, many Bots | Per-scenario isolation |
| Channel credentials | BYOK (Bring Your Own Key) | User controls their bots |
| Control plane | ECS Fargate (always-on) | No 15-min Lambda timeout |
| Agent runtime | AgentCore (microVM) / ECS Fargate (China) | Per-session isolation (global) / shared service with ABAC (China) |
| Agent SDK | Claude Agent SDK + Bedrock / Anthropic API | Configurable via AGENT_MODE |
| Message queue | SQS FIFO | Per-group ordering, cross-group parallelism |
| Database | DynamoDB | Serverless, millisecond latency |
| Auth | Cognito / Self-hosted OIDC | Cognito globally, self-hosted JWT for China |
| IaC | CDK (TypeScript) | Type-safe, same language as app |

## NanoClaw → Cloud Mapping

| NanoClaw (single-user) | ClawBot Cloud (multi-tenant) |
|------------------------|------------------------------|
| SQLite | DynamoDB (7 tables) |
| Local filesystem (`groups/`) | S3 (sessions, CLAUDE.md memory) |
| Docker containers | AgentCore microVMs |
| File-based IPC | MCP tools → AWS SDK (SQS, DynamoDB, EventBridge) |
| Polling loop | SQS FIFO consumer |
| Channel self-registration | Webhook HTTP endpoints |
| Credential proxy | IAM Roles + STS ABAC |

## Prerequisites

- Node.js >= 20
- Docker (for building ARM64 container images)
- AWS CLI configured (`aws configure`)
- AWS CDK bootstrapped (`cd infra && npx cdk bootstrap`)
- `jq` installed (used by deploy script for JSON parsing)

## Deployment

### One-Command Deploy

```bash
# Full deployment (default stage: dev)
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SecurePass123! ./scripts/deploy.sh

# Deploy to a specific stage
CDK_STAGE=prod AWS_REGION=us-east-1 ADMIN_EMAIL=admin@company.com ADMIN_PASSWORD=Pr0d!Pass ./scripts/deploy.sh
```

> `ADMIN_EMAIL` and `ADMIN_PASSWORD` are **required** — the script will abort if not set.

### ECS Mode (China Regions)

For deployment in AWS China regions (cn-north-1, cn-northwest-1) where Cognito, Bedrock, and AgentCore are unavailable:

```bash
# ECS mode deployment
DEPLOY_MODE=ecs ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SecurePass123! \
  ADMIN_BOOTSTRAP_SECRET=your-secret ./scripts/deploy.sh

# ECS mode uses:
# - Self-hosted OIDC auth service (replaces Cognito)
# - ECS Fargate agent service (replaces AgentCore microVMs)
# - Anthropic API (replaces Bedrock) — requires per-user API keys
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEPLOY_MODE` | No | `agentcore` | Deployment mode: `agentcore` (default) or `ecs` (China regions) |
| `ADMIN_EMAIL` | Yes | — | Email for the initial admin account |
| `ADMIN_PASSWORD` | Yes | — | Password for the initial admin account |
| `ADMIN_BOOTSTRAP_SECRET` | ECS only | `bootstrap` | One-time secret for creating the first admin user via auth-service API. In ECS mode there is no Cognito CLI — the deploy script calls `POST /admin/users` with this secret in the `X-Bootstrap-Secret` header to bypass JWT auth before any admin exists. Can be removed from the auth-service environment after the first deploy. |
| `CDK_STAGE` | No | `dev` | Deployment stage name |
| `AWS_REGION` | No | `us-west-2` | Target AWS region |

The `DEPLOY_MODE=ecs` flag:
- Builds and pushes an additional auth-service Docker image
- Passes `--context mode=ecs` to CDK (creates auth ECS service + agent ECS service instead of Cognito + AgentCore)
- Skips AgentCore registration steps (8, 9, 9b, 10, 11)
- Configures web-console for OIDC auth instead of Cognito
- Seeds admin via auth-service API (using `ADMIN_BOOTSTRAP_SECRET`) instead of Cognito

The deploy script runs 17 steps in order:
1. Pre-flight checks (aws, docker, node, jq)
2. `npm install` + build all workspaces
3. ECR login (creates repos if missing)
4. Build & push control-plane Docker image (ARM64)
5. Build & push agent-runtime Docker image (ARM64)
6. CDK deploy all 6 stacks
7. Read stack outputs (Cognito IDs, bucket names, role ARNs, ALB DNS, CDN domain)
8. Register AgentCore runtime (idempotent — skips if already exists)
9. Wait for AgentCore status READY
10. Update ECS task definition with `AGENTCORE_RUNTIME_ARN` env var
11. Force new ECS deployment
12. Build web-console with Cognito config injected via env vars
13. Sync `web-console/dist/` to S3 frontend bucket
14. CloudFront cache invalidation
15. Smoke test (`/health` endpoint)
16. Seed default admin account (idempotent — skips if already exists)
17. Write AgentCore runtime ARN to SSM Parameter Store

> Steps 5b, 8-11, 16-17 behave differently in ECS mode. See `DEPLOY_MODE=ecs` above.

> **Admin account:** Since Cognito self-signup is disabled, Step 16 creates the initial admin user. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are required env vars — the script will not start without them.

### Teardown

```bash
./scripts/destroy.sh                    # default stage: dev
CDK_STAGE=prod ./scripts/destroy.sh     # specific stage
```

Reverse order: delete AgentCore runtime (wait for deletion) → CDK destroy all stacks → delete ECR repos.

### Local Development

```bash
# Run control plane locally (pointing at deployed AWS resources)
cd control-plane
cp .env.example .env   # fill in values from CDK outputs
npm run dev

# Run web console locally
cd web-console
npm run dev            # opens http://localhost:5173
```

## Project Structure

```
cloud_native_nanoclaw/
├── scripts/
│   ├── deploy.sh             # One-command full deployment (17 steps)
│   └── destroy.sh            # Reverse teardown
├── shared/src/
│   ├── types.ts              # User, Bot, Channel, Message, Task, Session...
│   ├── xml-formatter.ts      # Agent context formatting (from NanoClaw)
│   └── text-utils.ts         # Output processing
├── auth-service/src/
│   ├── server.ts             # Fastify auth service (login, refresh, admin)
│   ├── jwt.ts                # RS256 signing, JWKS endpoint
│   └── password.ts           # bcrypt password hashing
├── infra/
│   ├── bin/app.ts            # CDK app entry
│   └── lib/
│       ├── foundation-stack.ts   # VPC, S3, DynamoDB, SQS, ECR
│       ├── auth-stack.ts         # Cognito
│       ├── agent-stack.ts        # IAM Roles (ABAC)
│       ├── control-plane-stack.ts# ALB, ECS Fargate, WAF
│       ├── frontend-stack.ts     # CloudFront + S3
│       └── monitoring-stack.ts   # CloudWatch, alarms
├── control-plane/src/
│   ├── index.ts              # Fastify app + SQS consumer startup
│   ├── webhooks/             # Telegram, Discord, Slack handlers
│   ├── sqs/                  # Message dispatcher + reply consumer
│   ├── routes/api/           # REST API (bots, channels, groups, tasks)
│   ├── services/             # DynamoDB, cache, credential lookups
│   └── channels/             # Channel API clients
├── agent-runtime/src/
│   ├── server.ts             # HTTP server (/invocations, /ping)
│   ├── agent.ts              # Claude Agent SDK integration
│   ├── session.ts            # S3 session sync
│   ├── memory.ts             # Multi-layer CLAUDE.md
│   ├── scoped-credentials.ts # STS ABAC
│   ├── mcp-tools.ts          # send_message, schedule_task, etc.
│   └── mcp-server.ts         # MCP stdio server
└── web-console/src/
    ├── pages/                # Login, Dashboard, BotDetail, ChannelSetup...
    ├── lib/                  # Auth (Cognito), API client
    └── components/           # Layout
```

## Message Flow

1. User sends `@Bot hello` in Telegram group
2. Telegram POST → `/webhook/telegram/{bot_id}` (ALB → Fargate)
3. Webhook handler verifies signature, stores message in DynamoDB, enqueues to SQS FIFO
4. SQS consumer dequeues, loads recent messages, invokes AgentCore Runtime (async fire-and-forget)
5. AgentCore returns `accepted` immediately, agent runs in background → Claude Agent SDK `query()`
6. Agent generates response, optionally uses MCP tools (schedule_task, send_message)
7. Final reply sent via SQS reply queue → Reply Consumer stores in DynamoDB, sends via Telegram API
8. User sees reply in Telegram

## Security

- **Auth**: Cognito JWT on all `/api/*` routes (agentcore mode) or self-hosted JWKS JWT (ecs mode)
- **Webhooks**: Per-channel signature verification (Telegram secret token, Discord Ed25519, Slack HMAC-SHA256)
- **Data isolation**: ABAC via STS SessionTags — agents can only access their owner's S3 paths and DynamoDB records
- **Network**: Fargate in private subnets, WAF rate limiting (2000 req/5min/IP)
- **Credentials**: Channel tokens stored in Secrets Manager, never exposed to agents

## Cost Estimate (single user)

| Component | ~Monthly Cost |
|-----------|--------------|
| AgentCore (30 msgs/day, 18s avg) | $0.40 |
| Bedrock Claude tokens | $5.40 |
| Fargate (2 tasks, 0.5 vCPU) | $30 |
| ALB | $16 |
| DynamoDB (on-demand) | $0.50 |
| S3 + CloudFront | $0.60 |
| **Total (1 user)** | **~$53/mo** |
| **100 users (amortized)** | **~$8/user/mo** |

## Documentation

| Resource | Description |
|----------|-------------|
| [📊 Architecture PPT](./docs/nanoclaw-architecture.pptx) | Visual system overview slides |
| [📐 Cloud Architecture](./docs/CLOUD_ARCHITECTURE.md) | Full design document with all details |
| [📋 TODO & Roadmap](./docs/TODO.md) | Backlog, deferred items, future work |