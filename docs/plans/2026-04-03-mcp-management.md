# MCP Server Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCP server management — admin defines MCP servers (STDIO/SSE/HTTP), bot owners enable or add custom ones, agent runtime installs and launches them per invocation.

**Architecture:** Three-layer design mirroring existing Skills management. Platform MCP definitions in DynamoDB, per-bot enablement with Secrets Manager for credentials, control-plane resolves configs into invocation payloads, agent runtime installs npm packages and builds mcpServers config for `query()`.

**Tech Stack:** TypeScript (ESM), Fastify, AWS SDK v3 (DynamoDB, Secrets Manager), AWS CDK, React 19, TailwindCSS, Claude Agent SDK, Vitest.

---

### Task 1: Add MCP Types to Shared Package

**Files:**
- Modify: `shared/src/types.ts` (after line 412, after the `Skill` interface)

**Step 1: Add MCP type definitions**

Add these types after the existing `Skill` interface (line 412) in `shared/src/types.ts`:

```typescript
// ── MCP Server Management ──────────────────────────────────────────────

export interface McpEnvVar {
  name: string;
  description: string;
  required: boolean;
  template: string;
}

export interface McpToolDef {
  name: string;
  description: string;
}

export interface McpServer {
  mcpServerId: string;
  name: string;
  description: string;
  version: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  npmPackages?: string[];
  url?: string;
  headers?: Record<string, string>;
  envVars?: McpEnvVar[];
  tools?: McpToolDef[];
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface BotMcpConfig {
  botId: string;
  mcpServerId: string;
  source: 'platform' | 'custom';
  enabled: boolean;
  customConfig?: {
    name: string;
    description: string;
    version: string;
    type: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    npmPackages?: string[];
    url?: string;
    headers?: Record<string, string>;
    envVars?: McpEnvVar[];
    tools?: McpToolDef[];
  };
  secretRefs?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedMcpConfig {
  mcpServerId: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  npmPackages?: string[];
  url?: string;
  headers?: Record<string, string>;
  envVars?: Record<string, string>;
}
```

**Step 2: Add `mcpServers` to Bot type**

In the `Bot` interface (line 100, after `skills?: string[];`), add:

```typescript
  mcpServers?: string[];
```

**Step 3: Add `mcpConfigs` to InvocationPayload**

In the `InvocationPayload` interface (line 286, after `skills?: string[];`), add:

```typescript
  mcpConfigs?: ResolvedMcpConfig[];
```

**Step 4: Build shared package**

Run: `npm run build -w shared`
Expected: Clean compile, no errors.

**Step 5: Commit**

```bash
git add shared/src/types.ts
git commit -m "feat(shared): add MCP server management types"
```

---

### Task 2: Add DynamoDB Tables to CDK Infrastructure

**Files:**
- Modify: `infra/lib/foundation-stack.ts` (add table properties + table definitions)
- Modify: `infra/bin/app.ts` (pass new tables to ControlPlaneStack)
- Modify: `infra/lib/control-plane-stack.ts` (add table props, env vars)

**Step 1: Add table properties to FoundationStack**

In `infra/lib/foundation-stack.ts`, add two new public properties after `skillsTable` (line 28):

```typescript
  public readonly mcpServersTable: dynamodb.Table;
  public readonly botMcpConfigsTable: dynamodb.Table;
```

**Step 2: Add table definitions**

After the Skills table definition (line 198), add:

```typescript
    // 10. MCP Servers table (global platform-level, admin-managed)
    this.mcpServersTable = new dynamodb.Table(this, 'McpServersTable', {
      ...tableDefaults,
      tableName: `nanoclawbot-${stage}-mcp-servers`,
      partitionKey: { name: 'mcpServerId', type: dynamodb.AttributeType.STRING },
    });

    // 11. Bot MCP Configs table (per-bot MCP enablement + custom definitions)
    this.botMcpConfigsTable = new dynamodb.Table(this, 'BotMcpConfigsTable', {
      ...tableDefaults,
      tableName: `nanoclawbot-${stage}-bot-mcp-configs`,
      partitionKey: { name: 'botId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'mcpServerId', type: dynamodb.AttributeType.STRING },
    });
```

**Step 3: Update ControlPlaneStackProps**

In `infra/lib/control-plane-stack.ts`, add to the `tables` interface (line 34, after `skills: dynamodb.ITable;`):

```typescript
    mcpServers: dynamodb.ITable;
    botMcpConfigs: dynamodb.ITable;
```

**Step 4: Add env vars to ECS container**

In `infra/lib/control-plane-stack.ts`, add after `SKILLS_TABLE` line (148):

```typescript
        MCP_SERVERS_TABLE: tables.mcpServers.tableName,
        BOT_MCP_CONFIGS_TABLE: tables.botMcpConfigs.tableName,
```

**Step 5: Pass new tables in app.ts**

In `infra/bin/app.ts`, add after `skills: foundation.skillsTable,` (line 66):

```typescript
    mcpServers: foundation.mcpServersTable,
    botMcpConfigs: foundation.botMcpConfigsTable,
```

**Step 6: Verify CDK synth**

Run: `cd infra && npx cdk synth --quiet && cd ..`
Expected: Synthesizes without errors.

**Step 7: Commit**

```bash
git add infra/lib/foundation-stack.ts infra/lib/control-plane-stack.ts infra/bin/app.ts
git commit -m "feat(infra): add MCP servers and bot MCP configs DynamoDB tables"
```

---

### Task 3: Add DynamoDB Operations for MCP Servers

**Files:**
- Modify: `control-plane/src/config.ts` (add table names)
- Modify: `control-plane/src/services/dynamo.ts` (add MCP CRUD functions)

**Step 1: Add table names to config**

In `control-plane/src/config.ts`, add to the `tables` object (line 30, after `skills`):

```typescript
    mcpServers: process.env.MCP_SERVERS_TABLE || 'nanoclawbot-dev-mcp-servers',
    botMcpConfigs: process.env.BOT_MCP_CONFIGS_TABLE || 'nanoclawbot-dev-bot-mcp-configs',
```

**Step 2: Add MCP server CRUD functions to dynamo.ts**

After the Skills section (line 1233), add a new section following the same pattern as `createSkill`, `getSkill`, `listSkills`, `updateSkill`, `deleteSkill`:

```typescript
// ── MCP Servers (global, admin-managed) ──────────────────────────────

const mcpServerIdSchema = z.string().min(1);

export async function createMcpServer(server: McpServer): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.mcpServers,
      Item: server,
      ConditionExpression: 'attribute_not_exists(mcpServerId)',
    }),
  );
}

export async function getMcpServer(mcpServerId: string): Promise<McpServer | null> {
  mcpServerIdSchema.parse(mcpServerId);
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.mcpServers,
      Key: { mcpServerId },
    }),
  );
  return (result.Item as McpServer) ?? null;
}

export async function listMcpServers(status?: string): Promise<McpServer[]> {
  const items: McpServer[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: config.tables.mcpServers,
        ExclusiveStartKey: lastKey,
        ...(status && {
          FilterExpression: '#status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': status },
        }),
      }),
    );
    if (result.Items) items.push(...(result.Items as McpServer[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function updateMcpServer(
  mcpServerId: string,
  updates: Partial<Omit<McpServer, 'mcpServerId' | 'createdAt' | 'createdBy'>>,
): Promise<void> {
  mcpServerIdSchema.parse(mcpServerId);

  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const allowedFields = [
    'name', 'description', 'version', 'type', 'status',
    'command', 'args', 'npmPackages', 'url', 'headers',
    'envVars', 'tools',
  ] as const;

  for (const field of allowedFields) {
    if ((updates as Record<string, unknown>)[field] !== undefined) {
      expressions.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = (updates as Record<string, unknown>)[field];
    }
  }

  if (expressions.length === 0) return;

  expressions.push('#updatedAt = :updatedAt');
  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();

  await client.send(
    new UpdateCommand({
      TableName: config.tables.mcpServers,
      Key: { mcpServerId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deleteMcpServer(mcpServerId: string): Promise<void> {
  mcpServerIdSchema.parse(mcpServerId);
  await client.send(
    new DeleteCommand({
      TableName: config.tables.mcpServers,
      Key: { mcpServerId },
    }),
  );
}

// ── Bot MCP Configs (per-bot enablement) ─────────────────────────────

export async function putBotMcpConfig(cfg: BotMcpConfig): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.botMcpConfigs,
      Item: cfg,
    }),
  );
}

export async function getBotMcpConfig(
  botId: string,
  mcpServerId: string,
): Promise<BotMcpConfig | null> {
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.botMcpConfigs,
      Key: { botId, mcpServerId },
    }),
  );
  return (result.Item as BotMcpConfig) ?? null;
}

export async function listBotMcpConfigs(botId: string): Promise<BotMcpConfig[]> {
  const items: BotMcpConfig[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: config.tables.botMcpConfigs,
        KeyConditionExpression: 'botId = :botId',
        ExpressionAttributeValues: { ':botId': botId },
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as BotMcpConfig[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function deleteBotMcpConfig(
  botId: string,
  mcpServerId: string,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: config.tables.botMcpConfigs,
      Key: { botId, mcpServerId },
    }),
  );
}

/** Delete all bot MCP configs referencing a given mcpServerId (for admin cascade delete). */
export async function deleteBotMcpConfigsByServer(mcpServerId: string): Promise<void> {
  const items: Array<{ botId: string; mcpServerId: string }> = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: config.tables.botMcpConfigs,
        FilterExpression: 'mcpServerId = :id',
        ExpressionAttributeValues: { ':id': mcpServerId },
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as Array<{ botId: string; mcpServerId: string }>));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  for (const item of items) {
    await deleteBotMcpConfig(item.botId, item.mcpServerId);
  }
}
```

Remember to add the `McpServer` and `BotMcpConfig` imports from `@clawbot/shared/types` at the top of dynamo.ts, and import `QueryCommand` if not already present.

**Step 3: Build and type-check**

Run: `npm run typecheck -w control-plane`
Expected: No errors.

**Step 4: Commit**

```bash
git add control-plane/src/config.ts control-plane/src/services/dynamo.ts
git commit -m "feat(control-plane): add DynamoDB operations for MCP servers and bot MCP configs"
```

---

### Task 4: Add Admin MCP Server CRUD Routes

**Files:**
- Create: `control-plane/src/routes/api/admin-mcp.ts`
- Modify: `control-plane/src/routes/api/admin.ts` (register new sub-route at line 368)

**Step 1: Create admin-mcp.ts**

Create `control-plane/src/routes/api/admin-mcp.ts` following the exact pattern of `admin-skills.ts`. This file should:

- Export `adminMcpRoutes` as a Fastify plugin
- Use Zod schemas for create/update validation
- Implement 5 routes:
  - `GET /` — list all (optional `?status=` filter), calls `listMcpServers(status)`
  - `POST /` — create new MCP server definition. Generate ULID for `mcpServerId`. Validate type-specific fields (STDIO needs command, SSE/HTTP needs url). Call `createMcpServer()`.
  - `GET /:mcpServerId` — get detail, calls `getMcpServer()`
  - `PUT /:mcpServerId` — update definition, calls `updateMcpServer()`
  - `DELETE /:mcpServerId` — delete with cascade. Call `deleteBotMcpConfigsByServer()`, then `deleteMcpServer()`.

Create schema:
```typescript
const createMcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  version: z.string().default('1.0.0'),
  type: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  npmPackages: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  envVars: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    required: z.boolean().default(false),
    template: z.string().default(''),
  })).optional(),
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
  })).optional(),
});
```

Add validation in POST handler: if `type === 'stdio'` require `command`; if `type === 'sse' || type === 'http'` require `url`.

**Step 2: Register in admin.ts**

In `control-plane/src/routes/api/admin.ts`, after line 368 (`adminSkillsRoutes` registration), add:

```typescript
  const { adminMcpRoutes } = await import('./admin-mcp.js');
  await app.register(adminMcpRoutes, { prefix: '/mcp-servers' });
```

**Step 3: Build and type-check**

Run: `npm run typecheck -w control-plane`
Expected: No errors.

**Step 4: Commit**

```bash
git add control-plane/src/routes/api/admin-mcp.ts control-plane/src/routes/api/admin.ts
git commit -m "feat(control-plane): add admin MCP server CRUD routes"
```

---

### Task 5: Add Bot-level MCP Server Routes

**Files:**
- Modify: `control-plane/src/routes/api/bots.ts` (add MCP endpoints, similar to skills endpoints at lines 198-244)

**Step 1: Add bot MCP endpoints to bots.ts**

Add these endpoints after the existing skills endpoints (after line 244):

1. **GET `/:botId/mcp-servers`** — List all available MCP servers with enabled state for this bot.
   - Get bot (verify ownership)
   - List all active platform MCP servers via `listMcpServers('active')`
   - List bot's MCP configs via `listBotMcpConfigs(botId)`
   - Merge: platform servers with `enabled` flag + custom configs
   - Return `{ mcpServers: [...] }` with fields: mcpServerId, name, type, description, version, tools, enabled, source, envVars (for secrets UI)

2. **PUT `/:botId/mcp-servers`** — Update enabled platform MCP server list.
   - Parse body: `{ mcpServers: string[] }` (max 20)
   - Validate each ID exists and is active
   - Update `bot.mcpServers` array via `updateBot()`
   - For each newly enabled server, create a `BotMcpConfig` record with `source: 'platform'`, `enabled: true`
   - For each disabled server, delete the `BotMcpConfig` record
   - Invalidate cache

3. **POST `/:botId/mcp-servers/custom`** — Add custom MCP server.
   - Parse body with same create schema as admin (name, type, command/url, etc.)
   - Generate custom ID: `custom-{ulid}`
   - Create `BotMcpConfig` with `source: 'custom'`, `enabled: true`, `customConfig` populated
   - Add to `bot.mcpServers` array
   - Return created config

4. **PUT `/:botId/mcp-servers/custom/:mcpServerId`** — Update custom MCP server.
   - Verify it exists and `source === 'custom'`
   - Update the `BotMcpConfig` record

5. **DELETE `/:botId/mcp-servers/custom/:mcpServerId`** — Delete custom MCP server.
   - Verify `source === 'custom'`
   - Delete `BotMcpConfig` record
   - Remove from `bot.mcpServers` array

6. **PUT `/:botId/mcp-servers/:mcpServerId/secrets`** — Save per-bot secrets.
   - Parse body: `{ secrets: Record<string, string> }` (envVarName → value)
   - For each entry, write to Secrets Manager at path `nanoclawbot/{stage}/{userId}/{botId}/mcp/{mcpServerId}/{envVarName}`
   - Update `BotMcpConfig.secretRefs` with Secrets Manager ARN/name references

**Step 2: Add imports**

Add imports for `listMcpServers`, `getMcpServer`, `putBotMcpConfig`, `listBotMcpConfigs`, `getBotMcpConfig`, `deleteBotMcpConfig` from dynamo.ts, and `SecretsManagerClient`, `CreateSecretCommand`, `PutSecretValueCommand` from AWS SDK.

**Step 3: Build and type-check**

Run: `npm run typecheck -w control-plane`
Expected: No errors.

**Step 4: Commit**

```bash
git add control-plane/src/routes/api/bots.ts
git commit -m "feat(control-plane): add bot-level MCP server management routes"
```

---

### Task 6: Add MCP Config Resolution to SQS Dispatcher

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts` (add resolution function + attach to payload)

**Step 1: Add `resolveMcpConfigs` function**

After the existing `resolveSkillPrefixes` function (line 610), add:

```typescript
// ── MCP Config Resolution ───────────────────────────────────────────────────

async function resolveMcpConfigs(bot: Bot): Promise<ResolvedMcpConfig[]> {
  if (!bot.mcpServers?.length) return [];

  const botMcpConfigs = await listBotMcpConfigs(bot.botId);
  const enabledConfigs = botMcpConfigs.filter((c) => c.enabled);
  if (enabledConfigs.length === 0) return [];

  const resolved: ResolvedMcpConfig[] = [];

  for (const cfg of enabledConfigs) {
    let serverDef: {
      name: string; type: 'stdio' | 'sse' | 'http';
      command?: string; args?: string[]; npmPackages?: string[];
      url?: string; headers?: Record<string, string>;
      envVars?: McpEnvVar[];
    };

    if (cfg.source === 'platform') {
      const platformServer = await getMcpServer(cfg.mcpServerId);
      if (!platformServer || platformServer.status !== 'active') continue;
      serverDef = platformServer;
    } else {
      if (!cfg.customConfig) continue;
      serverDef = cfg.customConfig;
    }

    // Resolve env var templates: ${secret:key} → Secrets Manager value
    const resolvedEnvVars: Record<string, string> = {};
    if (serverDef.envVars) {
      for (const ev of serverDef.envVars) {
        const secretRef = cfg.secretRefs?.[ev.name];
        if (secretRef) {
          try {
            const secret = await secretsManager.send(
              new GetSecretValueCommand({ SecretId: secretRef }),
            );
            resolvedEnvVars[ev.name] = secret.SecretString || '';
          } catch {
            // Skip if secret not found — env var will be empty
          }
        } else if (ev.template && !ev.template.startsWith('${secret:')) {
          resolvedEnvVars[ev.name] = ev.template; // plain default value
        }
      }
    }

    resolved.push({
      mcpServerId: cfg.mcpServerId,
      name: serverDef.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
      type: serverDef.type,
      ...(serverDef.command && { command: serverDef.command }),
      ...(serverDef.args && { args: serverDef.args }),
      ...(serverDef.npmPackages && { npmPackages: serverDef.npmPackages }),
      ...(serverDef.url && { url: serverDef.url }),
      ...(serverDef.headers && { headers: serverDef.headers }),
      ...(Object.keys(resolvedEnvVars).length > 0 && { envVars: resolvedEnvVars }),
    });
  }

  return resolved;
}
```

**Step 2: Attach mcpConfigs to invocation payloads**

In the inbound message dispatch section, after line 374 (`invocationPayload.skills = skillPrefixes`), add:

```typescript
    const mcpConfigs = await resolveMcpConfigs(bot);
    if (mcpConfigs.length > 0) invocationPayload.mcpConfigs = mcpConfigs;
```

In the scheduled task dispatch section, after line 549 (`invocationPayload.skills = taskSkillPrefixes`), add the same:

```typescript
  const taskMcpConfigs = await resolveMcpConfigs(bot);
  if (taskMcpConfigs.length > 0) invocationPayload.mcpConfigs = taskMcpConfigs;
```

**Step 3: Add imports**

Add imports for `listBotMcpConfigs`, `getMcpServer` from dynamo.ts, `SecretsManagerClient`, `GetSecretValueCommand` from AWS SDK, and `ResolvedMcpConfig`, `McpEnvVar` from `@clawbot/shared/types`.

**Step 4: Build and type-check**

Run: `npm run typecheck -w control-plane`
Expected: No errors.

**Step 5: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts
git commit -m "feat(control-plane): resolve MCP configs in SQS dispatcher invocation payload"
```

---

### Task 7: Add MCP Server Setup to Agent Runtime

**Files:**
- Modify: `agent-runtime/src/agent.ts` (install npm packages + build mcpServers config)

**Step 1: Add npm package installation function**

Add a helper function (near the top of agent.ts, after imports):

```typescript
import { execSync } from 'node:child_process';

const MCP_PACKAGES_DIR = '/home/node/.mcp-packages';

async function installMcpPackages(
  configs: ResolvedMcpConfig[],
  logger: pino.Logger,
): Promise<void> {
  const packagesToInstall: string[] = [];

  for (const cfg of configs) {
    if (cfg.type === 'stdio' && cfg.npmPackages?.length) {
      for (const pkg of cfg.npmPackages) {
        // Check if already installed
        const pkgDir = path.join(MCP_PACKAGES_DIR, 'node_modules', pkg.split('/').pop()!);
        if (!fs.existsSync(pkgDir)) {
          packagesToInstall.push(pkg);
        }
      }
    }
  }

  if (packagesToInstall.length === 0) return;

  fs.mkdirSync(MCP_PACKAGES_DIR, { recursive: true });
  logger.info({ packages: packagesToInstall }, 'Installing MCP npm packages');

  try {
    execSync(
      `npm install --prefix ${MCP_PACKAGES_DIR} ${packagesToInstall.join(' ')}`,
      { timeout: 120_000, stdio: 'pipe' },
    );
    logger.info('MCP npm packages installed successfully');
  } catch (err) {
    logger.error({ err }, 'Failed to install MCP npm packages');
  }
}
```

**Step 2: Add MCP servers to query() config**

In agent.ts, after the skills download section (line 191), add:

```typescript
  // 2d. Install MCP server npm packages
  if (payload.mcpConfigs?.length) {
    await installMcpPackages(payload.mcpConfigs, logger);
  }
```

Then modify the `mcpServers` config (line 393) to merge dynamic MCP servers:

```typescript
        mcpServers: {
          nanoclawbot: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              // ... existing env vars (lines 398-412)
            },
          },
          // Dynamic MCP servers from payload
          ...buildDynamicMcpServers(payload.mcpConfigs),
        },
```

Add the helper function:

```typescript
function buildDynamicMcpServers(
  configs?: ResolvedMcpConfig[],
): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }> {
  if (!configs?.length) return {};

  return Object.fromEntries(
    configs.map((cfg) => [
      cfg.name,
      cfg.type === 'stdio'
        ? {
            command: cfg.command || 'node',
            args: cfg.args || [],
            env: {
              ...cfg.envVars,
              PATH: `${MCP_PACKAGES_DIR}/node_modules/.bin:${process.env.PATH}`,
            },
          }
        : {
            url: cfg.url!,
            ...(cfg.headers && { headers: cfg.headers }),
          },
    ]),
  );
}
```

**Step 3: Expand allowedTools for dynamic MCP servers**

Modify the `allowedTools` array (line 362) to add wildcards for each dynamic server:

```typescript
        allowedTools: [
          // ... existing tools (lines 363-381)
          'mcp__nanoclawbot__*',
          // Dynamic MCP server wildcards
          ...(payload.mcpConfigs?.map((cfg) => `mcp__${cfg.name}__*`) ?? []),
        ],
```

**Step 4: Add ResolvedMcpConfig import**

Add `ResolvedMcpConfig` to the imports from `@clawbot/shared/types`.

**Step 5: Build and type-check**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors.

**Step 6: Commit**

```bash
git add agent-runtime/src/agent.ts
git commit -m "feat(agent-runtime): install and launch dynamic MCP servers from payload"
```

---

### Task 8: Add Admin MCP Management UI

**Files:**
- Modify: `web-console/src/lib/api.ts` (add admin MCP API methods + types)
- Modify: `web-console/src/pages/admin/AdminPage.tsx` (add McpServersTab)

**Step 1: Add MCP types and API methods to api.ts**

Add types near existing Skill type definitions:

```typescript
export interface McpEnvVar {
  name: string;
  description: string;
  required: boolean;
  template: string;
}

export interface McpToolDef {
  name: string;
  description: string;
}

export interface McpServer {
  mcpServerId: string;
  name: string;
  description: string;
  version: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  npmPackages?: string[];
  url?: string;
  headers?: Record<string, string>;
  envVars?: McpEnvVar[];
  tools?: McpToolDef[];
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
```

Add admin MCP API methods alongside existing admin skills methods:

```typescript
// MCP server management
listMcpServers: () => request<{ mcpServers: McpServer[] }>('/admin/mcp-servers'),
getMcpServer: (id: string) => request<McpServer>(`/admin/mcp-servers/${id}`),
createMcpServer: (data: Omit<McpServer, 'mcpServerId' | 'status' | 'createdAt' | 'updatedAt' | 'createdBy'>) =>
  request<McpServer>('/admin/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
updateMcpServer: (id: string, data: Partial<McpServer>) =>
  request<McpServer>(`/admin/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteMcpServer: (id: string) => request<void>(`/admin/mcp-servers/${id}`, { method: 'DELETE' }),
```

**Step 2: Add McpServersTab to AdminPage.tsx**

Add a new `McpServersTab` component following the exact pattern of `SkillsTab`. Key UI elements:

- **Add form**: Type selector (radio: STDIO/SSE/HTTP), conditionally shows:
  - STDIO: command input, args tag input, npm packages tag input
  - SSE/HTTP: URL input, headers key-value editor
  - Common: name, description, version, env vars (repeatable: name + description + required toggle + template), tools list (repeatable: name + description)
- **Table**: Name (with description), Type badge, Tools count, Status badge (clickable toggle), Created, Delete action
- Add a "MCP Servers" tab to the admin page tab bar (alongside existing "Users" and "Skills" tabs)

The tab selector in AdminPage should be updated to include `'mcp-servers'` as a third tab option.

**Step 3: Build web-console**

Run: `npm run build -w web-console`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add web-console/src/lib/api.ts web-console/src/pages/admin/AdminPage.tsx
git commit -m "feat(web-console): add admin MCP server management page"
```

---

### Task 9: Add Bot-level MCP Server UI

**Files:**
- Modify: `web-console/src/lib/api.ts` (add bot MCP API methods)
- Modify: `web-console/src/pages/BotDetail.tsx` (add MCP section to Tools tab or new MCP tab)

**Step 1: Add bot MCP API methods to api.ts**

Add to the `bots` API object:

```typescript
listMcpServers: (botId: string) =>
  request<{ mcpServers: BotMcpServerEntry[] }>(`/bots/${botId}/mcp-servers`),
updateMcpServers: (botId: string, mcpServers: string[]) =>
  request<{ ok: boolean }>(`/bots/${botId}/mcp-servers`, { method: 'PUT', body: JSON.stringify({ mcpServers }) }),
addCustomMcpServer: (botId: string, data: object) =>
  request<BotMcpServerEntry>(`/bots/${botId}/mcp-servers/custom`, { method: 'POST', body: JSON.stringify(data) }),
updateCustomMcpServer: (botId: string, mcpServerId: string, data: object) =>
  request<BotMcpServerEntry>(`/bots/${botId}/mcp-servers/custom/${mcpServerId}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteCustomMcpServer: (botId: string, mcpServerId: string) =>
  request<void>(`/bots/${botId}/mcp-servers/custom/${mcpServerId}`, { method: 'DELETE' }),
saveMcpSecrets: (botId: string, mcpServerId: string, secrets: Record<string, string>) =>
  request<{ ok: boolean }>(`/bots/${botId}/mcp-servers/${mcpServerId}/secrets`, { method: 'PUT', body: JSON.stringify({ secrets }) }),
```

Add the entry type:

```typescript
export interface BotMcpServerEntry {
  mcpServerId: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  description: string;
  version: string;
  tools?: McpToolDef[];
  envVars?: McpEnvVar[];
  enabled: boolean;
  source: 'platform' | 'custom';
}
```

**Step 2: Add BotMcpServersSection to BotDetail.tsx**

Add a new section in the Tools tab (or as a separate "MCP" tab alongside "Tools", "Skills"), following the `BotSkillsTab` two-tier pattern:

**Section 1: Platform MCP Servers**
- Checkbox list from `botsApi.listMcpServers(botId)`
- Each entry shows: name, type badge, tools count, description
- When enabled and server has required `envVars`, expand inline secrets form with password inputs
- Save writes to `botsApi.updateMcpServers()` + `botsApi.saveMcpSecrets()` for each server with secrets

**Section 2: Custom MCP Servers**
- "Add Custom MCP Server" button opens form (same as admin: type selector + conditional fields)
- List of custom servers with edit/delete actions
- Save via `botsApi.addCustomMcpServer()` / `botsApi.updateCustomMcpServer()` / `botsApi.deleteCustomMcpServer()`

**Single save button** saves both platform selection and custom configs.

**Step 3: Build web-console**

Run: `npm run build -w web-console`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add web-console/src/lib/api.ts web-console/src/pages/BotDetail.tsx
git commit -m "feat(web-console): add bot-level MCP server management in Tools tab"
```

---

### Task 10: Integration Testing and Build Verification

**Step 1: Full workspace build**

Run: `npm run build --workspaces`
Expected: All 5 packages build cleanly.

**Step 2: Run existing tests**

Run: `npm test -w control-plane`
Expected: All existing tests pass (no regressions).

**Step 3: Type-check all packages**

Run: `npm run typecheck -w shared && npm run typecheck -w control-plane && npm run typecheck -w agent-runtime && npm run typecheck -w infra`
Expected: No type errors.

**Step 4: CDK synth verification**

Run: `cd infra && npx cdk synth --quiet && cd ..`
Expected: Synthesizes without errors, new tables appear in CloudFormation template.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: MCP server management — admin library, bot enablement, runtime sync"
```
