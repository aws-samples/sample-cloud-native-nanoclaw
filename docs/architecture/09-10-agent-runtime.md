[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 9. Agent 执行层

> 对应 NanoClaw 的 `container/agent-runner/` + `container/Dockerfile`。
> 从 stdin/stdout + 文件 IPC 模式改造为 HTTP 服务 + AWS SDK 直调。

### 9.1 AgentCore Runtime 部署配置

部署通过 `scripts/deploy.sh` 自动完成 (Step 8)，等效于:

```bash
aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name "nanoclawbot_${STAGE}" \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"${ECR_URI}/nanoclawbot-agent:latest"}}' \
  --role-arn "${AGENT_BASE_ROLE_ARN}" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --environment-variables '{
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "SCOPED_ROLE_ARN": "...",
    "SESSION_BUCKET": "nanoclawbot-${STAGE}-data-...",
    "SQS_REPLIES_URL": "...",
    "TABLE_TASKS": "nanoclawbot-${STAGE}-tasks",
    "SCHEDULER_ROLE_ARN": "...",
    "SQS_MESSAGES_ARN": "..."
  }'
```

脚本会先检查同名 runtime 是否已存在 (幂等)，创建后轮询 `get-agent-runtime` 直到状态为 `READY`。

**调用方式 (Dispatcher → AgentCore):**

Control Plane 使用 `@aws-sdk/client-bedrock-agentcore` SDK 调用，而非直接 HTTP:

```typescript
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

const agentcoreClient = new BedrockAgentCoreClient({ region });

const response = await agentcoreClient.send(new InvokeAgentRuntimeCommand({
  agentRuntimeArn: config.agentcore.runtimeArn,
  payload: Buffer.from(JSON.stringify(invocationPayload)),
  contentType: 'application/json',
  accept: 'application/json',
  runtimeSessionId: `${botId}---${groupJid}`,
}));

const resultText = await response.response?.transformToString();
const body = JSON.parse(resultText) as { output: InvocationResult };
```

使用 AWS SDK 而非 `fetch()` 的优势: 自动处理 IAM SigV4 签名、重试、区域路由。

### 9.2 容器架构

```
clawbot-agent 容器 (ARM64, node:22-slim)
│
├── Fastify HTTP 服务 (:8080)
│   ├── POST /invocations   → Agent 执行入口
│   └── GET  /ping          → 健康检查 (Healthy / HealthyBusy)
│
├── Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
│   ├── query() — 流式消息处理
│   ├── MessageStream — 保持 AsyncIterable 开启 (支持 Agent Teams)
│   ├── Hooks: PreCompact → 归档对话到 S3
│   └── CLAUDE_CODE_USE_BEDROCK=1 → Bedrock Claude (IAM Role)
│
├── MCP Server (clawbot-tools)
│   ├── send_message     → SQS (回复队列)
│   ├── schedule_task    → DynamoDB + EventBridge Scheduler
│   ├── list_tasks       → DynamoDB 查询
│   ├── pause/resume/cancel_task → DynamoDB 更新
│   └── (不再有 register_group, 改由 Web UI 完成)
│
├── S3 Client
│   ├── 启动时: 恢复 session 文件 + CLAUDE.md 记忆
│   └── 结束时: 回写 session 文件 + 记忆变更
│
├── 系统依赖
│   ├── Chromium (agent-browser 浏览器自动化)
│   ├── git, curl (Agent Bash 工具需要)
│   └── agent-browser CLI (全局安装)
│
└── 工作目录结构
    /workspace/
    ├── group/            # 工作目录 (cwd), S3 恢复的群组文件
    │   ├── CLAUDE.md     # 群组记忆 (从 S3 加载, 读写)
    │   ├── conversations/ # 对话归档 (PreCompact hook 写入)
    │   └── attachments/  # 多媒体附件 (从 S3 下载)
    ├── global/           # Bot 全局记忆 (从 S3 加载, 只读)
    │   └── CLAUDE.md
    ├── shared/           # 用户共享知识 (从 S3 加载, 只读, 跨 Bot)
    │   └── CLAUDE.md
    └── .claude/          # Claude SDK session 文件 (从 S3 恢复)
        └── projects/
```

### 9.3 Dockerfile

多阶段构建，从仓库根目录执行 (`docker build -f agent-runtime/Dockerfile .`)，
与 control-plane Dockerfile 结构一致，使用 npm workspaces 解析 `@clawbot/shared` 依赖:

```dockerfile
# ── Stage 1: Builder ──────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY shared/tsconfig.json shared/
COPY shared/src/ shared/src/
COPY agent-runtime/package.json agent-runtime/
COPY agent-runtime/tsconfig.json agent-runtime/
COPY tsconfig.base.json ./

RUN npm ci --workspace=@clawbot/shared --workspace=@clawbot/agent-runtime

COPY shared/ shared/
RUN npm run build --workspace=@clawbot/shared

COPY agent-runtime/src/ agent-runtime/src/
RUN npm run build --workspace=@clawbot/agent-runtime

# ── Stage 2: Runner ───────────────────────────────────────────────────────
FROM --platform=linux/arm64 node:22-slim

# 系统依赖: Chromium + 字体 + 构建工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libasound2 \
    libpangocairo-1.0-0 libcups2 libdrm2 libxshmfence1 \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# 全局安装 agent-browser 和 claude-code CLI
RUN npm install -g @anthropic-ai/claude-code agent-browser

WORKDIR /app
COPY --from=builder /app/agent-runtime/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/shared/dist/ ./node_modules/@clawbot/shared/dist/
COPY --from=builder /app/shared/package.json ./node_modules/@clawbot/shared/
COPY --from=builder /app/agent-runtime/package.json ./

# 工作目录
RUN mkdir -p /workspace/group /workspace/global /workspace/shared /workspace/extra /home/node/.claude
RUN chown -R node:node /workspace && chmod 777 /home/node

ENV CLAUDE_CODE_USE_BEDROCK=1
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
```

### 9.4 HTTP 服务实现

#### 入口 `server.ts`

```typescript
import Fastify from 'fastify';
import { handleInvocation } from './handler.js';
import { isAgentBusy } from './state.js';

const app = Fastify({ logger: true });

// AgentCore 健康检查 — 必须快速返回，不能被 Agent 执行阻塞
app.get('/ping', async () => ({
  status: isAgentBusy() ? 'HealthyBusy' : 'Healthy',
  time_of_last_update: Math.floor(Date.now() / 1000),
}));

// Agent 调用入口
app.post('/invocations', async (req, reply) => {
  const result = await handleInvocation(req.body as InvocationPayload);
  return reply.send({ output: result });
});

app.listen({ port: 8080, host: '0.0.0.0' });
```

**关键：`/ping` 必须在独立线程响应。** AgentCore 通过 `/ping` 判断 session 是否存活。如果主线程被 `query()` 阻塞导致 `/ping` 不响应，AgentCore 会在 15 分钟后终止 session。Fastify 在 Node.js 事件循环中处理 HTTP，而 `query()` 是 async 的（内部 spawn 子进程），不会阻塞事件循环。

#### 调用处理 `handler.ts`

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { syncFromS3, syncToS3 } from './s3-sync.js';
import { createScopedClients, ScopedClients } from './scoped-credentials.js';
import { MessageStream } from './message-stream.js';
import { createMcpConfig } from './mcp-tools.js';
import { createPreCompactHook } from './hooks.js';
import { formatMessages, stripInternalTags } from './router.js';
import { setBusy, setIdle } from './state.js';

export interface InvocationPayload {
  input: {
    botId: string;
    botName: string;
    groupJid: string;
    userId: string;
    prompt: string;           // 已格式化的 XML 消息
    systemPrompt?: string;    // Bot 自定义 system prompt
    sessionPath: string;      // S3: {userId}/{botId}/sessions/{groupJid}/
    memoryPath: string;       // S3: {userId}/{botId}/memory/{groupJid}/
    globalMemoryPath: string; // S3: {userId}/{botId}/memory/global/
    sharedMemoryPath: string; // S3: {userId}/shared/ (跨 Bot 共享, 只读)
    attachments?: Attachment[];  // 多媒体附件 (Webhook 预上传到 S3)
    isScheduledTask?: boolean;
    maxTurns?: number;
  };
}

export interface Attachment {
  type: 'image' | 'voice' | 'document' | 'video';
  s3Key: string;             // S3 对象 key
  fileName: string;          // 原始文件名
  mimeType: string;          // MIME 类型
  size: number;              // 字节数
}

export interface InvocationResult {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// 按 session 维度跟踪状态，防止 microVM 被 AgentCore 复用给不同 session 时污染
// 关键假设: AgentCore 当前保证 1 microVM = 1 runtimeSessionId。
// 此处用 sessionKey 防御该假设被破坏的情况。
let currentSessionKey: string | null = null;     // "{botId}#{groupJid}"
let scopedClients: ScopedClients | null = null;

export async function handleInvocation(payload: InvocationPayload): Promise<InvocationResult> {
  const { botId, botName, groupJid, userId, prompt, systemPrompt,
          sessionPath, memoryPath, globalMemoryPath, sharedMemoryPath,
          attachments, isScheduledTask, maxTurns } = payload.input;

  setBusy();

  try {
    const sessionKey = `${botId}#${groupJid}`;

    // ── 0. 检测 session 切换 (防御 microVM 复用) ──
    // 如果 AgentCore 将此 microVM 路由给了不同的 bot/group,
    // 必须清空本地文件系统并重新获取 scoped 凭证
    if (currentSessionKey !== null && currentSessionKey !== sessionKey) {
      console.warn(`Session switch detected: ${currentSessionKey} → ${sessionKey}, resetting`);
      await cleanLocalWorkspace();   // rm -rf /workspace/group/* /workspace/global/* /home/node/.claude/*
      scopedClients = null;
    }
    currentSessionKey = sessionKey;

    // ── 1. 获取 Scoped 凭证 (ABAC: IAM 层面限定 {userId}/{botId}/) ──
    if (!scopedClients) {
      scopedClients = await createScopedClients(userId, botId);
    }

    // ── 2. S3 同步 (session 切换或首次调用时恢复, 使用 scoped S3 client) ──
    if (!scopedClients._restored) {
      await syncFromS3(scopedClients.s3, {
        sessionPath,                           // → /home/node/.claude/
        memoryPath,                            // → /workspace/group/
        globalMemoryPath,                      // → /workspace/global/
        sharedMemoryPath,                      // → /workspace/shared/ (跨 Bot 只读)
      });
      scopedClients._restored = true;
    }

    // ── 2. 构建 prompt ──
    let formattedPrompt = prompt;
    if (isScheduledTask) {
      formattedPrompt = `[SCHEDULED TASK]\n\n${prompt}`;
    }

    // ── 3. 加载多层记忆 (追加到 system prompt) ──
    const memoryParts: string[] = [];

    // 用户共享记忆 (跨 Bot, 如公司上下文)
    try {
      const shared = fs.readFileSync('/workspace/shared/CLAUDE.md', 'utf-8');
      if (shared.trim()) memoryParts.push(`# Shared Knowledge\n${shared}`);
    } catch { /* 无共享记忆 */ }

    // Bot 全局记忆
    try {
      const global = fs.readFileSync('/workspace/global/CLAUDE.md', 'utf-8');
      if (global.trim()) memoryParts.push(global);
    } catch { /* 无全局记忆 */ }

    const combinedMemory = memoryParts.length > 0 ? memoryParts.join('\n\n---\n\n') : undefined;

    // ── 3.5 下载并引用附件 (图片/文件/语音) ──
    if (attachments?.length) {
      await downloadAttachments(scopedClients.s3, attachments, '/workspace/group/attachments/');
    }

    // ── 4. 构建 MCP 工具配置 (传入 scoped clients 供 MCP 工具使用) ──
    const mcpConfig = createMcpConfig({ botId, groupJid, userId });

    // ── 5. 执行 Claude Agent SDK ──
    const stream = new MessageStream();
    stream.push(formattedPrompt);

    let newSessionId: string | undefined;
    let lastResult: string | null = null;

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        systemPrompt: combinedMemory
          ? { type: 'preset', preset: 'claude_code', append: combinedMemory }
          : undefined,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'NotebookEdit',
          'mcp__clawbot__*',
        ],
        maxTurns: maxTurns || 50,
        env: { ...process.env },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: mcpConfig,
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(botName, sessionPath)] }],
        },
      }
    })) {
      // 捕获 session ID
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      // 捕获最终结果
      if (message.type === 'result') {
        const text = 'result' in message ? (message as any).result : null;
        if (text) lastResult = text;
      }
    }

    stream.end();

    // ── 6. 回写变更到 S3 (使用 scoped S3 client) ──
    await syncToS3(scopedClients.s3, {
      sessionPath,   // /home/node/.claude/ → S3
      memoryPath,    // /workspace/group/CLAUDE.md → S3 (如果有变更)
    });

    setIdle();

    return {
      status: 'success',
      result: lastResult ? stripInternalTags(lastResult) : null,
      newSessionId,
    };

  } catch (err) {
    setIdle();
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { status: 'error', result: null, error: errorMessage };
  }
}
```

### 9.5 MCP 工具 (替代文件 IPC)

> 对应 NanoClaw 的 `container/agent-runner/src/ipc-mcp-stdio.ts`。
> 核心变化：**从文件 IPC 改为直接调用 AWS SDK。**

```typescript
// mcp-tools.ts — Agent 容器内的 MCP Server

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, PutItemCommand, ... } from '@aws-sdk/client-dynamodb';
import { SchedulerClient, CreateScheduleCommand, ... } from '@aws-sdk/client-scheduler';

const sqs = new SQSClient({});
const dynamodb = new DynamoDBClient({});
const scheduler = new SchedulerClient({});

export function createMcpConfig(ctx: { botId: string; groupJid: string; userId: string }) {
  return {
    clawbot: {
      command: 'node',
      args: [MCP_SERVER_PATH],
      env: {
        CLAWBOT_BOT_ID: ctx.botId,
        CLAWBOT_GROUP_JID: ctx.groupJid,
        CLAWBOT_USER_ID: ctx.userId,
        CLAWBOT_REPLY_QUEUE_URL: process.env.CLAWBOT_REPLY_QUEUE_URL!,
      },
    },
  };
}
```

**工具对比 (NanoClaw vs Cloud):**

| NanoClaw 工具 | 实现方式 | Cloud 工具 | 实现方式 |
|--------------|---------|-----------|---------|
| `send_message` | 写文件到 IPC/messages/ | `send_message` | SQS SendMessage (回复队列) |
| `schedule_task` | 写文件到 IPC/tasks/ | `schedule_task` | DynamoDB PutItem + EventBridge CreateSchedule |
| `list_tasks` | 读 IPC/current_tasks.json | `list_tasks` | DynamoDB Query |
| `pause_task` | 写文件到 IPC/tasks/ | `pause_task` | DynamoDB UpdateItem + EventBridge UpdateSchedule |
| `resume_task` | 写文件到 IPC/tasks/ | `resume_task` | DynamoDB UpdateItem + EventBridge UpdateSchedule |
| `cancel_task` | 写文件到 IPC/tasks/ | `cancel_task` | DynamoDB DeleteItem + EventBridge DeleteSchedule |
| `update_task` | 写文件到 IPC/tasks/ | `update_task` | DynamoDB UpdateItem + EventBridge UpdateSchedule |
| `register_group` | 写文件到 IPC/tasks/ (主群组) | _(移除)_ | 由 Web UI 管理 |

**send_message 实现：**

```typescript
server.tool(
  'send_message',
  'Send a message to the user/group immediately.',
  {
    text: z.string().describe('Message text'),
    sender: z.string().optional().describe('Sender identity name'),
  },
  async (args) => {
    // 发到 SQS 回复队列，Fargate Control Plane 消费后调 Channel API
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.CLAWBOT_REPLY_QUEUE_URL,
      MessageBody: JSON.stringify({
        type: 'reply',
        botId: process.env.CLAWBOT_BOT_ID,
        groupJid: process.env.CLAWBOT_GROUP_JID,
        text: args.text,
        sender: args.sender,
        timestamp: new Date().toISOString(),
      }),
    }));

    return { content: [{ type: 'text', text: 'Message sent.' }] };
  },
);
```

**schedule_task 实现：**

```typescript
server.tool(
  'schedule_task',
  '(同 NanoClaw 的 schedule_task 描述)',
  { /* 同 NanoClaw 的参数 schema */ },
  async (args) => {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const botId = process.env.CLAWBOT_BOT_ID!;

    // 1. 写入 DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: `${process.env.CLAWBOT_DYNAMODB_TABLE_PREFIX}tasks`,
      Item: {
        bot_id: { S: botId },
        task_id: { S: taskId },
        group_jid: { S: process.env.CLAWBOT_GROUP_JID! },
        prompt: { S: args.prompt },
        schedule_type: { S: args.schedule_type },
        schedule_value: { S: args.schedule_value },
        context_mode: { S: args.context_mode || 'group' },
        status: { S: 'active' },
        created_at: { S: new Date().toISOString() },
      },
    }));

    // 2. 创建 EventBridge Schedule
    const scheduleExpression = args.schedule_type === 'cron'
      ? `cron(${args.schedule_value})`
      : args.schedule_type === 'interval'
        ? `rate(${Math.round(parseInt(args.schedule_value) / 60000)} minutes)`
        : `at(${args.schedule_value})`;

    await scheduler.send(new CreateScheduleCommand({
      Name: `clawbot-${botId}-${taskId}`,
      ScheduleExpression: scheduleExpression,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: process.env.CLAWBOT_TASK_QUEUE_ARN!,
        Input: JSON.stringify({
          type: 'scheduled_task', botId, taskId,
          groupJid: process.env.CLAWBOT_GROUP_JID,
        }),
        RoleArn: process.env.CLAWBOT_SCHEDULER_ROLE_ARN!,
      },
      State: 'ENABLED',
    }));

    return {
      content: [{ type: 'text', text: `Task ${taskId} scheduled.` }],
    };
  },
);
```

### 9.6 S3 同步模块

> 对应 NanoClaw 的本地文件挂载。microVM 文件系统临时性，需要与 S3 双向同步。

```typescript
// s3-sync.ts

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
  ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// 注意: 不创建全局 S3Client。所有 S3 操作使用 ABAC scoped client (由调用方传入)。
const BUCKET = process.env.CLAWBOT_S3_BUCKET!;

interface SyncPaths {
  sessionPath: string;      // S3: {userId}/{botId}/sessions/{groupJid}/
  memoryPath: string;       // S3: {userId}/{botId}/memory/{groupJid}/
  globalMemoryPath: string; // S3: {userId}/{botId}/memory/global/
  sharedMemoryPath: string; // S3: {userId}/shared/
}

/**
 * Session 启动时: 从 S3 恢复文件到本地
 * @param s3 - ABAC scoped S3 client (限定 {userId}/{botId}/ 路径)
 * @param sharedS3 - 用户级 S3 client (限定 {userId}/ 路径, 用于共享记忆)
 */
export async function syncFromS3(s3: S3Client, paths: SyncPaths): Promise<void> {
  // 恢复 Claude session 文件
  await downloadPrefix(s3, paths.sessionPath, '/home/node/.claude/');

  // 恢复群组记忆 (读写)
  await downloadPrefix(s3, paths.memoryPath, '/workspace/group/');

  // 恢复 Bot 全局记忆 (只读)
  await downloadPrefix(s3, paths.globalMemoryPath, '/workspace/global/');

  // 恢复用户共享记忆 (只读, 跨 Bot)
  // 注: sharedMemoryPath 在 {userId}/ 前缀下, ABAC scoped role 也有权限
  // (因为 S3 policy 用 ${aws:PrincipalTag/userId}/* 通配)
  await downloadPrefix(s3, paths.sharedMemoryPath, '/workspace/shared/');
}

/**
 * Agent 执行结束后: 回写变更到 S3
 * @param s3 - ABAC scoped S3 client (限定 {userId}/{botId}/ 路径)
 */
export async function syncToS3(s3: S3Client, paths: Pick<SyncPaths, 'sessionPath' | 'memoryPath'>): Promise<void> {
  // 回写 Claude session 文件
  await uploadDirectory(s3, '/home/node/.claude/', paths.sessionPath);

  // 回写群组记忆 (仅 CLAUDE.md 和 conversations/)
  await uploadFileIfChanged(s3, '/workspace/group/CLAUDE.md', `${paths.memoryPath}CLAUDE.md`);
  await uploadDirectory(s3, '/workspace/group/conversations/', `${paths.memoryPath}conversations/`);
}

async function downloadPrefix(s3: S3Client, s3Prefix: string, localDir: string): Promise<void> {
  let continuationToken: string | undefined;
  let totalFiles = 0;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: s3Prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const obj of response.Contents ?? []) {
      const relativePath = obj.Key!.slice(s3Prefix.length);
      if (!relativePath) continue;  // 跳过前缀本身

      const localPath = path.join(localDir, relativePath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      const data = await s3.send(new GetObjectCommand({
        Bucket: BUCKET, Key: obj.Key!,
      }));
      const body = await data.Body!.transformToByteArray();
      fs.writeFileSync(localPath, body);
      totalFiles++;
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (totalFiles > 0) {
    console.log(`Downloaded ${totalFiles} files from s3://${BUCKET}/${s3Prefix}`);
  }
}

async function uploadFileIfChanged(s3: S3Client, localPath: string, s3Key: string): Promise<void> {
  if (!fs.existsSync(localPath)) return;

  const content = fs.readFileSync(localPath);

  // 对比 ETag 避免无变更的重复上传
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    const localMd5 = createHash('md5').update(content).digest('hex');
    // S3 ETag 对单次上传的对象就是 MD5 (加引号)
    if (head.ETag === `"${localMd5}"`) return;  // 无变更，跳过
  } catch {
    // 对象不存在或 HeadObject 失败，继续上传
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: s3Key, Body: content,
  }));
}

async function uploadDirectory(s3: S3Client, localDir: string, s3Prefix: string): Promise<void> {
  if (!fs.existsSync(localDir)) return;

  const files = walkDir(localDir);
  for (const file of files) {
    const relativePath = path.relative(localDir, file);
    await uploadFileIfChanged(s3, file, s3Prefix + relativePath);
  }
}

/**
 * 清空本地工作目录 (session 切换时调用)
 */
export async function cleanLocalWorkspace(): Promise<void> {
  for (const dir of ['/workspace/group', '/workspace/global', '/home/node/.claude']) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
```

### 9.7 PreCompact Hook (对话归档)

> 直接移植 NanoClaw 的 `createPreCompactHook`，区别是归档文件同时写 S3。

```typescript
// hooks.ts

import { HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { uploadFileIfChanged } from './s3-sync.js';
import fs from 'fs';

export function createPreCompactHook(botName: string, sessionPath: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);   // 复用 NanoClaw 的 parseTranscript
      if (messages.length === 0) return {};

      const date = new Date().toISOString().split('T')[0];
      const name = sanitizeFilename(messages[0]?.content || 'conversation');
      const filename = `${date}-${name}.md`;

      // 写本地
      const localPath = `/workspace/group/conversations/${filename}`;
      fs.mkdirSync('/workspace/group/conversations', { recursive: true });
      const markdown = formatTranscriptMarkdown(messages, null, botName);
      fs.writeFileSync(localPath, markdown);

      // 同步到 S3
      await uploadFileIfChanged(localPath, `${sessionPath}conversations/${filename}`);
    } catch (err) {
      console.error(`PreCompact hook error: ${err}`);
    }

    return {};
  };
}
```

### 9.8 MessageStream (保留 NanoClaw 设计)

> 直接复用 NanoClaw 的 `MessageStream` 类。在 AgentCore 场景下，同一 session 内的后续
> `/invocations` 调用通过 push 新消息到 stream，支持 Agent Teams 子代理。

```typescript
// message-stream.ts — 与 NanoClaw 完全相同

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
```

### 9.9 Session 映射策略

```
AgentCore runtimeSessionId = "{bot_id}---{group_jid}"
                              (用 --- 分隔, 避免 # 在 URL 中转义)

每个 Bot 的每个 Group 有独立 Session:
  bot-abc---tg:-1001234     → microVM-1 (独立文件系统、CPU、内存)
  bot-abc---tg:-1005678     → microVM-2
  bot-xyz---tg:-1001234     → microVM-3 (不同 Bot 完全隔离)
```

**Session 生命周期 (AgentCore 管理):**

```
首次消息到达 (该 group 无活跃 session)
    │
    ▼
Dispatcher: InvokeAgentRuntime(runtimeSessionId=新)
    │
    ▼
AgentCore: 创建 microVM → 拉取容器镜像 → 启动 HTTP 服务
    │
    ▼
Agent: /invocations 收到请求
    ├── syncFromS3() 恢复 session + 记忆 (~1-2s)
    ├── query() 执行 Claude Agent SDK
    ├── syncToS3() 回写变更
    └── 返回结果
    │
    ▼
AgentCore: session 状态 → Idle
    │
    ├── 15 分钟内有新消息 → /invocations 再次调用
    │   └── 复用 microVM (无需 S3 恢复, < 100ms)
    │
    └── 15 分钟无消息 → session 终止
        └── microVM 销毁, 内存清零
            下次消息 → 创建新 session → syncFromS3() 恢复
```

**优化与防御：**
- S3 恢复状态绑定到 `scopedClients._restored`，凭证重建时自动重置
- 通过 `sessionKey` 检测 microVM 是否被 AgentCore 路由给了不同的 bot/group
- 如果 session 切换，清空本地文件系统 + 重新获取 scoped 凭证 + 重新从 S3 恢复
- 同一 session 内的后续 `/invocations` 调用跳过 S3 下载（< 100ms）

### 9.10 Agent IAM — 双 Role ABAC 隔离

采用 **STS AssumeRole + Session Tags** 实现 IAM 层面的 per-user/per-bot 数据隔离。Agent 基础 Role 没有 S3 权限，所有数据访问必须通过 Scoped Role 的临时凭证。

```
InvokeAgentRuntime(payload: { userId, botId, ... })
    │
    ▼
Agent Runner (基础 Role: ClawBotAgentRole)
    │  ← 只有 Bedrock + STS + SQS 权限，无 S3 权限
    │
    ├── sts.assumeRole({
    │     RoleArn: ClawBotAgentScopedRole,
    │     Tags: [{ userId: "u-123" }, { botId: "b-456" }]
    │   })
    │
    ▼
Scoped 临时凭证
    └── S3 路径限定: clawbot-data/u-123/b-456/*
    └── DynamoDB 限定: LeadingKeys = "b-456"
    └── Scheduler 限定: clawbot-b-456-*
```

#### 基础 Role (ClawBotAgentRole) — AgentCore Runtime 绑定

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModelAccess",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.*"
    },
    {
      "Sid": "AssumeScopedRole",
      "Effect": "Allow",
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Resource": "arn:aws:iam::ACCOUNT:role/ClawBotAgentScopedRole"
    },
    {
      "Sid": "SQSSendReply",
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:*:*:clawbot-reply-*"
    }
  ]
}
```

**注意：基础 Role 没有 S3、DynamoDB、EventBridge 权限。** 即使 Agent 通过 Bash 执行 `aws s3 ls`，也会因权限不足而失败。

#### Scoped Role (ClawBotAgentScopedRole) — Session Tags 动态限定

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3BotDataAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::clawbot-data/${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*"
    },
    {
      "Sid": "S3SharedMemoryReadOnly",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::clawbot-data/${aws:PrincipalTag/userId}/shared/*"
    },
    {
      "Sid": "S3ListScopedPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::clawbot-data",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*",
            "${aws:PrincipalTag/userId}/shared/*"
          ]
        }
      }
    },
    {
      "Sid": "DynamoDBScopedAccess",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                 "dynamodb:DeleteItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:*:*:table/clawbot-tasks",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["${aws:PrincipalTag/botId}"]
        }
      }
    },
    {
      "Sid": "SchedulerScopedAccess",
      "Effect": "Allow",
      "Action": ["scheduler:CreateSchedule", "scheduler:UpdateSchedule",
                 "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
      "Resource": "arn:aws:scheduler:*:*:schedule/default/clawbot-${aws:PrincipalTag/botId}-*"
    }
  ]
}
```

#### Scoped Role Trust Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT:role/ClawBotAgentRole"
      },
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Condition": {
        "StringLike": {
          "aws:RequestTag/userId": "*",
          "aws:RequestTag/botId": "*"
        }
      }
    }
  ]
}
```

#### Agent Runner 中获取 Scoped Credentials

```typescript
// scoped-credentials.ts

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';

const sts = new STSClient({});

export interface ScopedClients {
  s3: S3Client;
  dynamodb: DynamoDBClient;
  scheduler: SchedulerClient;
  _restored: boolean;  // S3 恢复完成标记，绑定到凭证生命周期
}

export async function createScopedClients(userId: string, botId: string): Promise<ScopedClients> {
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: process.env.CLAWBOT_SCOPED_ROLE_ARN!,
    RoleSessionName: `${userId}--${botId}`.slice(0, 64),
    Tags: [
      { Key: 'userId', Value: userId },
      { Key: 'botId', Value: botId },
    ],
    DurationSeconds: 3600,
  }));

  const credentials = {
    accessKeyId: assumed.Credentials!.AccessKeyId!,
    secretAccessKey: assumed.Credentials!.SecretAccessKey!,
    sessionToken: assumed.Credentials!.SessionToken!,
  };

  return {
    s3: new S3Client({ credentials }),
    dynamodb: new DynamoDBClient({ credentials }),
    scheduler: new SchedulerClient({ credentials }),
    _restored: false,
  };
}
```

#### 安全效果

| 攻击场景 | 仅应用层隔离 | ABAC 双 Role |
|---------|------------|-------------|
| Agent 代码 bug 拼错 S3 路径 | 访问到其他用户数据 | IAM 403 拒绝 |
| Prompt 注入构造恶意 S3 请求 | 可能成功 | IAM 403 拒绝 |
| Bash 执行 `aws s3 ls s3://clawbot-data/` | 列出所有用户目录 | 基础 Role 无 S3 权限，失败 |
| Bash 执行 `aws dynamodb scan` | 扫描所有 bot 任务 | 基础 Role 无 DynamoDB 权限，失败 |
| MCP 工具传错 botId | 操作其他 bot 的 schedule | Scheduler 资源名限定 botId |

### 9.11 NanoClaw Agent Runner → Cloud Agent Runner 映射

| NanoClaw (container/agent-runner) | Cloud (clawbot-agent) | 变更原因 |
|---|---|---|
| stdin 读取 ContainerInput JSON | `/invocations` POST body | AgentCore 服务契约 |
| stdout OUTPUT_START/END marker | HTTP JSON response | AgentCore 服务契约 |
| 文件 IPC (`/workspace/ipc/input/`) 接收后续消息 | 同一 session 多次 `/invocations` 调用 | AgentCore 自动保持 session |
| `_close` sentinel 文件退出 | AgentCore 15min 空闲自动回收 | 无需手动关闭 |
| `drainIpcInput()` 轮询 IPC 目录 | _(移除)_ | 无文件 IPC |
| `waitForIpcMessage()` 等待新消息 | _(移除)_ | Dispatcher 直接调用 |
| MCP 写文件 → Host IPC watcher 消费 | MCP 直调 AWS SDK | 无 Host 中转 |
| 挂载 `/workspace/group` (Docker volume) | S3 同步到 `/workspace/group` | 无持久挂载 |
| `process.env` 凭证代理 URL | IAM Role (自动注入临时凭证) | 零凭证管理 |
| MessageStream (保留) | MessageStream (保留) | Agent Teams 支持不变 |
| PreCompact hook → 写本地文件 | PreCompact hook → 写本地 + S3 | 增加 S3 持久化 |
| `query()` 调用和参数 (保留大部分) | `query()` 调用和参数 (保留大部分) | 核心逻辑不变 |

---

## 10. 任务调度

### 10.1 创建定时任务

NanoClaw 用文件 IPC 创建任务。Cloud 版通过两个路径：

```
路径 A: 用户通过 Web UI 创建
  Web UI → POST /api/bots/{bot_id}/tasks → DynamoDB + EventBridge Scheduler

路径 B: Agent 在对话中创建 (MCP 工具)
  Agent → send_message / schedule_task (MCP)
  → Agent Runner 直接调用 AWS SDK
  → DynamoDB + EventBridge Scheduler
```

### 10.2 EventBridge Scheduler 集成

每个定时任务对应一个 EventBridge Schedule：

```typescript
// 创建定时任务
await scheduler.createSchedule({
  Name: `clawbot-${botId}-${taskId}`,
  ScheduleExpression: 'cron(0 9 ? * MON-FRI *)',  // 工作日 9 点
  FlexibleTimeWindow: { Mode: 'OFF' },
  Target: {
    Arn: DISPATCHER_LAMBDA_ARN,
    Input: JSON.stringify({
      type: 'scheduled_task',
      botId, taskId, groupJid, prompt
    }),
    RoleArn: SCHEDULER_ROLE_ARN,
  },
  State: 'ENABLED',
});
```

**任务触发链：**

```
EventBridge Schedule (到期)
    │
    ▼
SQS FIFO (type: "scheduled_task", taskId, botId)
    │
    ▼
Fargate SQS Consumer
    ├── 从 DynamoDB 加载 Task 详情
    ├── 构建 prompt
    ├── InvokeAgentRuntime (context_mode 决定是否新 session)
    ├── 结果写入 DynamoDB (task.last_result)
    └── 结果发送到 Channel (如果配置了通知)
```

EventBridge Schedule 的 Target 设为 SQS（而非直接调用 Lambda），由 Fargate SQS Consumer 统一消费。所有 Agent 调用走同一条路径，简化运维。
