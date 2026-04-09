# ECS Mode & China Region Deployment Design

**Date**: 2026-04-09
**Status**: Approved

## Problem

ClawBot Cloud currently depends on three AWS services unavailable in China regions:

| Service | China Status |
|---------|-------------|
| Amazon Cognito User Pools | Not available (not expanding) |
| Amazon Bedrock | Not available (being planned) |
| Amazon Bedrock AgentCore | Planned Q3 2026 cn-north-1 |

This blocks deployment in cn-north-1 (Beijing) and cn-northwest-1 (Ningxia). All other required services (ECS/Fargate, DynamoDB, SQS, S3, CloudFront, ALB, WAF, Secrets Manager, STS, ECR) are available in both China regions.

## Solution

Introduce a **deployment mode** via CDK context variable:

- **`agentcore`** (default) — current behavior: AgentCore + Cognito + Bedrock
- **`ecs`** — new: ECS agent service + self-hosted OIDC + configurable LLM provider

```bash
# Global (default)
npx cdk deploy --all -c stage=prod
DEPLOY_MODE=agentcore bash scripts/deploy.sh

# China / ECS mode
npx cdk deploy --all -c stage=prod -c mode=ecs
DEPLOY_MODE=ecs bash scripts/deploy.sh
```

## Architecture: Mode Comparison

| Component | `agentcore` mode | `ecs` mode |
|-----------|-----------------|------------|
| Agent runtime | AgentCore microVM | ECS Fargate service (internal ALB) |
| Agent invocation | `InvokeAgentRuntimeCommand` | HTTP POST to internal ALB |
| Auth | Cognito User Pool | Self-hosted OIDC (ECS service) |
| LLM provider | Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) | Anthropic API (API key in Secrets Manager) |
| Session persistence | AgentCore `runtimeSessionId` (warm VM) | Stateless per request, S3 session sync |
| Deploy steps 8-9b | Register/wait/stop AgentCore runtime | Skipped — standard ECS deploy |

### What stays the same (both modes)

- Webhook handling (Telegram, Discord, Slack, Feishu)
- SQS FIFO message ordering with per-group parallelism
- Channel Adapter Registry
- DynamoDB schema (all 11 tables)
- S3 session sync
- ABAC scoped credentials (STS session tags)
- MCP tools in agent-runtime
- Web-console UI (pages, components)

## Design: Self-Hosted OIDC Auth Service

A lightweight Fastify auth service deployed as a separate ECS Fargate service in `ecs` mode. Replaces Cognito User Pools.

### User store

Reuses existing DynamoDB `users` table with additional fields:

- `passwordHash` — bcrypt hash
- `refreshToken` — opaque token for session refresh

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /auth/login` | Email + password → access token + refresh token |
| `POST /auth/refresh` | Refresh token → new access token |
| `POST /auth/change-password` | Password change (first-login force-change) |
| `GET /auth/.well-known/jwks.json` | Public key for JWT verification |
| `POST /admin/users` | Create user (admin only) |
| `PUT /admin/users/:id/status` | Enable/disable user (admin only) |

### JWT claims (compatible with Cognito JWT shape)

```json
{
  "sub": "user-ulid",
  "email": "user@example.com",
  "cognito:groups": ["clawbot-admins"],
  "token_use": "access",
  "iss": "https://auth.internal",
  "exp": 1234567890
}
```

Keeping the `cognito:groups` claim name ensures the control-plane middleware (admin check, user extraction) requires zero changes beyond swapping the JWT verifier.

### JWT signing

- RS256 with key pair stored in Secrets Manager
- JWKS endpoint exposes public key
- Access token TTL: 1 hour
- Refresh token TTL: 30 days

### Package structure

```
auth-service/
  src/
    server.ts          # Fastify app
    jwt.ts             # RS256 sign/verify, JWKS endpoint
    password.ts        # bcrypt hash/verify
    admin.ts           # Admin user CRUD
  Dockerfile           # ARM64
  package.json
  tsconfig.json
```

Dependencies: Fastify, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-secrets-manager`, `bcrypt`, `jose`.

## Design: ECS Agent Runtime

### Architecture

Agent-runtime runs as a standard ECS Fargate service behind an internal ALB (private subnets, not internet-facing).

```
Control-Plane (SQS consumer)
    ↓ HTTP POST /invocations (internal ALB)
Agent-Runtime ECS Service (2-20 tasks, auto-scaling)
    ↓ (async processing)
SQS Reply Queue → Control-Plane Reply Consumer
```

### Invocation abstraction

```typescript
// dispatcher.ts
interface AgentInvoker {
  invoke(payload: InvocationPayload, sessionKey: string): Promise<{ status: string }>;
}

// AgentCore mode (existing)
class AgentCoreInvoker implements AgentInvoker {
  // Uses InvokeAgentRuntimeCommand
}

// ECS mode (new)
class EcsHttpInvoker implements AgentInvoker {
  // HTTP POST to internal ALB, fire-and-forget (202 accepted)
}
```

Factory function selects invoker based on `config.agentMode`.

### Agent-runtime changes

Minimal — the runtime already serves `/invocations` and `/ping`. Changes:

1. **LLM provider**: When `CLAUDE_CODE_USE_BEDROCK` is absent/falsy, use `ANTHROPIC_API_KEY` from env (loaded from Secrets Manager by ECS task definition)
2. **Session handling**: No `runtimeSessionId` — S3 session sync handles state persistence (already implemented in `session.ts`)

### Session isolation in shared ECS

Three layers:

1. **Concurrency isolation**: Each ECS task handles one invocation at a time. ALB health check on `/ping` — tasks returning `HealthyBusy` receive no new requests. Auto-scaling adds tasks when all are busy.

2. **Data isolation (ABAC)**: Each invocation assumes scoped IAM role via STS with session tags (`userId`, `botId`). S3 paths and DynamoDB conditions enforced at IAM policy level.

3. **Session state isolation**: Session keyed by `{botId}#{groupJid}`, stored in S3. No shared in-memory cache. Single-concurrency per task eliminates race conditions.

### ECS agent service configuration

- Fargate ARM64 (Graviton)
- CPU: 512, Memory: 1024 MB (same as control-plane)
- Desired: 2, Min: 2, Max: 20
- Auto-scaling: CPU utilization target 70%
- Health check: `GET /ping` (30s interval)
- Internal ALB listener: port 8080

## Design: CDK Stack Changes

### `infra/bin/app.ts`

```typescript
const mode = app.node.tryGetContext('mode') ?? 'agentcore';
// Pass mode to all stacks as prop
```

### AuthStack (conditional)

- **`agentcore`**: Cognito User Pool + Client (existing)
- **`ecs`**: Auth service ECS task definition + internal ALB target group
  - Exports: `AUTH_JWKS_URL`, `AUTH_ENDPOINT`

### AgentStack (conditional)

- **`agentcore`**: AgentCore base role + scoped role (existing)
- **`ecs`**: Agent ECS service + internal ALB + task role
  - Task role: S3, DynamoDB, SQS, Secrets Manager, EventBridge (direct, no AgentCore trust)
  - Scoped role retained for ABAC
  - Exports: `AGENT_ENDPOINT`

### ControlPlaneStack (env vars per mode)

- **`agentcore`**: `AGENTCORE_RUNTIME_ARN_SSM`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`
- **`ecs`**: `AGENT_ENDPOINT`, `AUTH_JWKS_URL`, `AUTH_ENDPOINT`
- **Both**: `AGENT_MODE=agentcore|ecs`
- Permission: `bedrock-agentcore:InvokeAgentRuntime` only in `agentcore` mode

### FrontendStack

Unchanged structure. Build-time env vars differ:
- **`agentcore`**: `VITE_COGNITO_*`
- **`ecs`**: `VITE_AUTH_ENDPOINT`

## Design: deploy.sh Changes

```bash
DEPLOY_MODE=${DEPLOY_MODE:-agentcore}

# Step 5b: Build auth-service image (ECS mode only)
if [ "$DEPLOY_MODE" = "ecs" ]; then
  build_and_push "auth-service"
fi

# Steps 8-9b: AgentCore (skip in ECS mode)
if [ "$DEPLOY_MODE" = "agentcore" ]; then
  register_agentcore_runtime
  wait_for_ready
  stop_warm_sessions
fi

# CDK deploy with mode
npx cdk deploy --all -c stage=$STAGE -c mode=$DEPLOY_MODE

# Web console build (conditional env vars)
if [ "$DEPLOY_MODE" = "ecs" ]; then
  export VITE_AUTH_ENDPOINT="https://${CDN_DOMAIN}/auth"
else
  export VITE_COGNITO_USER_POOL_ID=...
  export VITE_COGNITO_CLIENT_ID=...
fi

# Seed admin (conditional)
if [ "$DEPLOY_MODE" = "ecs" ]; then
  curl -X POST "https://${CDN_DOMAIN}/auth/admin/users" ...
else
  aws cognito-idp admin-create-user ...
fi
```

## File Changes Summary

### New package

| Package | Purpose |
|---------|---------|
| `auth-service/` | Self-hosted OIDC auth service (~300 LOC) |

### Modified files

| File | Changes |
|------|---------|
| `control-plane/src/config.ts` | Add `agentMode`, `agentEndpoint`, `authJwksUrl`, `authEndpoint` |
| `control-plane/src/sqs/dispatcher.ts` | Add `AgentInvoker` interface, `EcsHttpInvoker`, factory |
| `control-plane/src/routes/api/index.ts` | Pluggable JWT verifier (Cognito vs generic JWKS) |
| `control-plane/src/routes/api/admin.ts` | Admin user ops via auth-service API in ECS mode |
| `agent-runtime/src/agent.ts` | LLM provider config (Bedrock vs Anthropic API) |
| `infra/bin/app.ts` | Read `mode` context, pass to stacks |
| `infra/lib/auth-stack.ts` | Conditional: Cognito vs auth-service ECS |
| `infra/lib/agent-stack.ts` | Conditional: AgentCore roles vs ECS agent service |
| `infra/lib/control-plane-stack.ts` | Env vars and permissions per mode |
| `web-console/src/lib/auth.ts` | Auth provider abstraction (Amplify vs direct JWT) |
| `web-console/src/main.tsx` | Conditional Amplify vs OIDC config |
| `scripts/deploy.sh` | `DEPLOY_MODE` flag, conditional steps |
| `package.json` (root) | Add `auth-service` workspace |

### Updated dependency graph

```
shared ◄── control-plane
       ◄── agent-runtime
       ◄── auth-service (new)

infra (standalone)
web-console (standalone)
```

## China Region Notes

- Deploy to `cn-north-1` or `cn-northwest-1`
- AWS China partition uses `amazonaws.com.cn` endpoints (handled by SDK automatically when `AWS_REGION=cn-*`)
- CloudFront in China requires ICP license for custom domains
- S3 bucket naming uses region-specific ARN format (`arn:aws-cn:s3:::...`)
- CDK bootstrap must be run per China account/region with `--trust` for the China partition
- Anthropic API access from China requires outbound HTTPS — ensure NAT Gateway or VPC endpoint configuration allows it
