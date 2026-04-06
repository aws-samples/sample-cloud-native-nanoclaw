# MCP Server Management Design

**Date:** 2026-04-03
**Status:** Approved

## Overview

Add MCP (Model Context Protocol) server management across three layers:
1. **Admin MCP Library** — Platform admins define MCP server configs (STDIO/SSE/HTTP)
2. **Bot-level MCP Selection** — Bot owners enable platform MCP servers or add custom ones
3. **Agent Runtime MCP Sync** — Runtime installs and launches enabled MCP servers per invocation

## Design Decisions

| Decision | Choice |
|----------|--------|
| STDIO handling | NPM install at startup, cached in microVM |
| Config detail | Full config with env var templates, npm packages, tool names |
| Secret storage | Secrets Manager per bot (`nanoclaw/{userId}/{botId}/mcp/...`) |
| User custom MCP | Same freedom as admin (STDIO/SSE/HTTP), scoped to bot |
| Runtime lifecycle | Install once, cache; MCP processes ephemeral per-query |

## Data Model

### McpServer (Platform-level, admin-managed)

```typescript
export interface McpServer {
  mcpServerId: string;          // ULID
  name: string;                 // e.g., "GitHub MCP Server"
  description: string;
  version: string;              // e.g., "1.0.0"
  type: 'stdio' | 'sse' | 'http';

  // STDIO fields
  command?: string;             // e.g., "npx"
  args?: string[];              // e.g., ["-y", "@modelcontextprotocol/server-github"]
  npmPackages?: string[];       // packages to pre-install

  // SSE/HTTP fields
  url?: string;                 // e.g., "https://mcp.example.com/sse"
  headers?: Record<string, string>; // static headers (non-secret)

  // Common fields
  envVars?: McpEnvVar[];        // env var templates
  tools?: McpToolDef[];         // tools this server exposes (for UI/whitelist)

  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  createdBy: string;            // admin userId
}

export interface McpEnvVar {
  name: string;                 // e.g., "GITHUB_TOKEN"
  description: string;          // shown to bot owner
  required: boolean;
  template: string;             // "${secret:github-token}" or plain default value
}

export interface McpToolDef {
  name: string;                 // e.g., "create_issue"
  description: string;
}
```

### BotMcpConfig (Per-bot enablement)

```typescript
export interface BotMcpConfig {
  botId: string;
  mcpServerId: string;          // references platform McpServer or "custom-{ulid}"
  source: 'platform' | 'custom';
  enabled: boolean;

  // Custom MCP definition (when source === 'custom')
  customConfig?: Omit<McpServer, 'mcpServerId' | 'status' | 'createdAt' | 'updatedAt' | 'createdBy'>;

  // Per-bot secret references for env var templates
  secretRefs?: Record<string, string>;  // envVarName → Secrets Manager key suffix

  createdAt: string;
  updatedAt: string;
}
```

### Bot type extension

```typescript
export interface Bot {
  // ... existing fields
  mcpServers?: string[];        // enabled mcpServerId list (parallels skills?: string[])
}
```

### DynamoDB Tables

- `nanoclawbot-{stage}-mcp-servers` — PK: `mcpServerId`
- `nanoclawbot-{stage}-bot-mcp-configs` — PK: `botId`, SK: `mcpServerId`

### Secrets Manager

Path: `nanoclaw/{userId}/{botId}/mcp/{mcpServerId}/{envVarName}`

## API Routes

### Admin MCP Management (`/api/admin/mcp-servers`)

```
GET    /api/admin/mcp-servers              — List all (?status=active|disabled)
POST   /api/admin/mcp-servers              — Create new definition
GET    /api/admin/mcp-servers/:mcpServerId  — Get detail
PUT    /api/admin/mcp-servers/:mcpServerId  — Update definition
DELETE /api/admin/mcp-servers/:mcpServerId  — Delete (cascades to bot configs + secrets)
```

### Bot-level MCP Management (`/api/bots/:botId/mcp-servers`)

```
GET    /api/bots/:botId/mcp-servers              — List all with enabled state
PUT    /api/bots/:botId/mcp-servers              — Update enabled list (platform IDs)
POST   /api/bots/:botId/mcp-servers/custom       — Add custom MCP server
PUT    /api/bots/:botId/mcp-servers/custom/:id   — Update custom MCP server
DELETE /api/bots/:botId/mcp-servers/custom/:id   — Delete custom MCP server
PUT    /api/bots/:botId/mcp-servers/:mcpServerId/secrets — Save per-bot secrets
```

### Key Behaviors

- GET list returns merged view: all active platform servers + bot's custom ones, each with `enabled` flag and `source`
- Admin DELETE cascades: disables in all bots, cleans up secrets
- Secrets endpoint writes to Secrets Manager, stores key references in bot-mcp-configs table

## Web Console UI

### Admin MCP Management Page (`/admin/mcp-servers`)

- **List view** — Table: Name, Type badge (STDIO/SSE/HTTP), Tools count, Status, Created. Edit/Delete actions.
- **Create/Edit form** — Type radio selector showing/hiding relevant fields:
  - STDIO: command, args (tag input), npm packages (tag input)
  - SSE/HTTP: URL, headers (key-value editor)
  - Common: name, description, version, env var templates (repeatable rows), tools list (repeatable rows)

### Bot Detail — Tools Tab MCP Section

New "MCP Servers" section in Tools tab, mirrors Skills section:

- **Platform MCP Servers** — Checkbox list with name, type badge, tools count. On enable with required env vars, expand inline secrets form (password inputs).
- **Custom MCP Servers** — "Add Custom MCP Server" button, same form as admin but bot-scoped. List with edit/delete.
- Saved to `bot.mcpServers[]` (same pattern as `bot.skills[]`)

## Agent Runtime

### Invocation Payload Extension

```typescript
interface InvocationPayload {
  // ... existing fields
  mcpConfigs?: ResolvedMcpConfig[];
}

interface ResolvedMcpConfig {
  mcpServerId: string;
  name: string;                    // used as mcpServers key in query()
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  npmPackages?: string[];
  url?: string;
  headers?: Record<string, string>;
  envVars?: Record<string, string>; // fully resolved by control-plane
}
```

### Resolution Flow (Control-plane, SQS consumer)

1. Read `bot.mcpServers[]` from DynamoDB
2. Fetch each config from `bot-mcp-configs` table
3. For platform sources, fetch `McpServer` definition from `mcp-servers` table
4. Resolve `${secret:*}` templates from Secrets Manager
5. Attach `mcpConfigs[]` to invocation payload

### Runtime Startup (agent-runtime)

1. Parse `mcpConfigs[]` from payload
2. STDIO servers with `npmPackages`: check `/home/node/.mcp-packages/`, `npm install` if missing
3. Build mcpServers config:

```typescript
const mcpServers = {
  nanoclawbot: { /* existing built-in */ },
  ...Object.fromEntries(mcpConfigs.map(cfg => [
    cfg.name,
    cfg.type === 'stdio'
      ? { command: cfg.command, args: cfg.args, env: cfg.envVars }
      : { url: cfg.url, headers: cfg.headers }
  ]))
};
```

4. Add `mcp__{serverName}__*` to `allowedTools` per enabled server
5. Pass merged `mcpServers` to `query()`

### Security

- Secrets resolved in control-plane, not in microVM
- SQS payload encrypted in transit + at rest
- STDIO commands sandboxed in AgentCore microVM
- `allowedTools` wildcard per server for tool gating

## Infrastructure (CDK)

### New DynamoDB Tables

In `FoundationStack`:
- `nanoclawbot-{stage}-mcp-servers` — PK: `mcpServerId`, PAY_PER_REQUEST
- `nanoclawbot-{stage}-bot-mcp-configs` — PK: `botId`, SK: `mcpServerId`, PAY_PER_REQUEST

### IAM Changes

- Control-plane task role: read/write both new tables + Secrets Manager `nanoclaw/*/mcp/*`
- Agent ABAC role: no changes (secrets resolved by control-plane)

### Environment Variables

Control-plane ECS task:
```
TABLE_MCP_SERVERS=nanoclawbot-{stage}-mcp-servers
TABLE_BOT_MCP_CONFIGS=nanoclawbot-{stage}-bot-mcp-configs
```

## Implementation Order

1. **shared** — Add types (McpServer, BotMcpConfig, McpEnvVar, McpToolDef, ResolvedMcpConfig)
2. **infra** — Add DynamoDB tables, IAM permissions, env vars
3. **control-plane** — Admin CRUD routes, bot-level MCP routes, secrets management, SQS consumer MCP resolution
4. **agent-runtime** — NPM install logic, mcpServers config builder, allowedTools expansion
5. **web-console** — Admin MCP page, Bot detail MCP section in Tools tab
