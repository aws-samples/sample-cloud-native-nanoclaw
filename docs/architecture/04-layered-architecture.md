[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 4. 分层架构详解

### 4.1 Web 控制台

```
技术栈: React 19 + Vite + TailwindCSS
部署:   S3 (静态资源) + CloudFront (CDN + HTTPS)
认证:   AWS Amplify (aws-amplify) + Cognito (自定义登录表单)
路由:   react-router-dom v7
国际化: react-i18next (中英文双语, 浏览器语言自动检测)
```

**页面结构：**

| 页面 | 路由 | 功能 |
|------|------|------|
| 登录/注册 | (未认证时显示) | Cognito 认证 (自定义表单: 登录/注册/强制改密) |
| Dashboard | `/` | Bot 列表、用量统计、共享记忆快捷入口 |
| Bot 详情 | `/bots/:botId` | 7 Tab: 概览、渠道、会话、任务、记忆、文件、设置 |
| Channel 配置 | `/bots/:botId/channels/new` | 添加频道 (Telegram/Discord/Slack/Feishu)，含分步配置指南 |
| 对话历史 | `/bots/:botId/messages/:groupJid` | 按 Group 查看消息记录 (聊天气泡视图) |
| 记忆编辑器 | `/memory`, `/bots/:botId/groups/:groupJid/memory` | 3 级 CLAUDE.md 记忆编辑 (Shared / Bot Memory / Group Memory) |
| 设置 | `/settings` | 模型供应商管理 (Admin)、API 凭证代理规则 |
| 管理员 | `/admin` | 用户管理 (列表 + 详情)、Plan 配额管理 |
| 用户详情 | `/admin/users/:userId` | 用量统计、配额调整、Plan 变更、状态管理 |

**国际化 (i18n)：**
- `react-i18next` + `i18next-browser-languagedetector`
- 浏览器语言自动检测 (localStorage → navigator)，语言偏好持久化
- 侧栏底部 `EN | 中文` 语言切换按钮
- ~485 个翻译键覆盖所有页面，含频道配置分步指南的完整翻译
- 富文本指南使用 `Trans` 组件处理内联 JSX

**API 客户端** (`lib/api.ts`) — 统一 fetch 封装，自动注入 Cognito Bearer token，类型化响应。

### 4.2 ECS Fargate Service (Control Plane + Dispatcher)

Control Plane 和 Dispatcher 合并为一个常驻 Fargate Service，消除 Lambda 15 分钟超时限制。

```
技术栈: ECS Fargate Service (Node.js/TypeScript, Fastify 5)
部署:   ALB (Application Load Balancer) → Fargate Task
认证:   Cognito JWT (aws-jwt-verify 中间件)
规格:   0.5 vCPU / 1GB Memory, 最小 2 Task (高可用)
```

**进程内部结构：**

```
Fargate Task (单进程, 多线程)
├── HTTP Server (Fastify, 主线程)
│   ├── /api/*          → REST API 端点 (需 JWT 认证)
│   │   ├── /api/bots, /api/bots/:botId/channels, /api/bots/:botId/groups
│   │   ├── /api/bots/:botId/tasks, /api/bots/:botId/memory
│   │   ├── /api/bots/:botId/identity, /soul, /bootstrap
│   │   ├── /api/shared-memory, /api/user-profile, /api/me
│   │   └── /api/admin/* → 管理员 API (需 clawbot-admins 组)
│   ├── /webhook/*      → Webhook 接收端点 (无需认证, 签名验证)
│   └── /health         → ALB 健康检查
│
├── SQS Inbound Consumer (后台线程, 长轮询)
│   ├── sqs.receiveMessage({ WaitTimeSeconds: 20 })
│   ├── 配额检查 → 并发控制 (Semaphore) → InvokeAgentRuntime
│   └── 结果 → Channel Adapter → 频道 API 回复
│
├── SQS Reply Consumer (后台线程, 长轮询)
│   ├── 消费 Agent send_message 工具产生的中间回复
│   └── 路由 → Channel Adapter Registry → 频道 API
│
├── Channel Adapter Registry (频道适配层)
│   ├── DiscordAdapter — Gateway (WebSocket) + Leader 选举 + Slash Commands + 打字指示器
│   ├── FeishuAdapter  — Gateway (Lark WSClient) + Leader 选举 + 卡片消息 + Reaction 确认
│   ├── TelegramAdapter — Webhook 模式, sendReply via REST API
│   └── SlackAdapter — Webhook 模式, sendReply via REST API
│
├── Health Checker (定时后台线程, 每 60 分钟)
│   └── 验证所有 Channel 凭证有效性, 标记 unhealthy
│
├── SSM Config Resolver (启动时)
│   └── 从 SSM Parameter Store 解析 Webhook Base URL、AgentCore Runtime ARN
│
└── 内存缓存 (TTL 5min)
    ├── Bot 配置缓存:     Map<bot_id, Bot>
    └── Channel 凭证缓存: Map<secret_arn, Credentials>
```

**API 端点设计：**

```
# 用户相关 (需 JWT)
GET    /api/me                              # 当前用户信息

# Bot 管理 (需 JWT)
POST   /api/bots                            # 创建 Bot
GET    /api/bots                            # 列出用户的所有 Bot
GET    /api/bots/{bot_id}                   # Bot 详情
PUT    /api/bots/{bot_id}                   # 更新 Bot 配置
DELETE /api/bots/{bot_id}                   # 删除 Bot

# Channel 管理 (需 JWT)
POST   /api/bots/{bot_id}/channels          # 添加 Channel
GET    /api/bots/{bot_id}/channels          # 列出 Bot 的 Channels
DELETE /api/bots/{bot_id}/channels/{ch_id}  # 删除 Channel
POST   /api/bots/{bot_id}/channels/{ch_id}/test  # 测试连接

# Group 管理 (需 JWT)
GET    /api/bots/{bot_id}/groups            # 列出 Bot 的 Groups
PUT    /api/bots/{bot_id}/groups/{group_id} # 更新 Group 配置

# 消息历史 (需 JWT)
GET    /api/bots/{bot_id}/groups/{gid}/messages  # 对话历史

# 定时任务 (需 JWT)
POST   /api/bots/{bot_id}/tasks             # 创建任务
GET    /api/bots/{bot_id}/tasks             # 列出任务
PUT    /api/bots/{bot_id}/tasks/{task_id}   # 更新/暂停/恢复
DELETE /api/bots/{bot_id}/tasks/{task_id}   # 删除任务

# 记忆管理 — 原生 CLAUDE.md, 3 级 (需 JWT)
GET    /api/shared-memory                   # 获取用户共享记忆 (跨 Bot)
PUT    /api/shared-memory                   # 更新用户共享记忆
GET    /api/bots/{bot_id}/memory            # 获取 Bot 全局记忆 (CLAUDE.md)
PUT    /api/bots/{bot_id}/memory            # 更新 Bot 全局记忆
GET    /api/bots/{bot_id}/groups/{gid}/memory  # Group 记忆
PUT    /api/bots/{bot_id}/groups/{gid}/memory  # 更新 Group 记忆

# 模型供应商 (公开列表 + 管理员 CRUD)
GET    /api/providers                       # 列出可用供应商 (公开, 隐藏密钥)
POST   /api/admin/providers                 # 创建供应商 (需 Admin)
GET    /api/admin/providers                 # 列出供应商完整信息 (需 Admin)
PUT    /api/admin/providers/{provider_id}   # 更新供应商 (需 Admin)
DELETE /api/admin/providers/{provider_id}   # 删除供应商 (需 Admin)

# API 凭证代理规则 (需 JWT)
GET    /api/proxy-rules                     # 列出用户的代理规则
POST   /api/proxy-rules                     # 创建代理规则
PUT    /api/proxy-rules/{rule_id}           # 更新代理规则
DELETE /api/proxy-rules/{rule_id}           # 删除代理规则

# 管理员 (需 JWT + isAdmin)
GET    /api/admin/users                     # 列出所有用户
POST   /api/admin/users                     # 创建用户 (指定邮箱和 Plan)
GET    /api/admin/users/{user_id}           # 用户详情 + 用量
PUT    /api/admin/users/{user_id}/quota     # 更新配额
PUT    /api/admin/users/{user_id}/plan      # 更新 Plan
PUT    /api/admin/users/{user_id}/status    # 更新状态 (active/suspended)
DELETE /api/admin/users/{user_id}           # 删除用户
GET    /api/admin/plans                     # 获取 Plan 配额配置
PUT    /api/admin/plans                     # 更新 Plan 配额配置

# Webhook (无需 JWT, 签名验证)
POST   /webhook/telegram/{bot_id}           # Telegram Webhook
POST   /webhook/discord/{bot_id}            # Discord Interactions Endpoint
POST   /webhook/slack/{bot_id}              # Slack Events API

# 注意: 飞书使用 WebSocket 长连接 (Lark SDK WSClient), 无 Webhook 端点
```

### 4.3 Webhook 接收 (HTTP Server 内)

Webhook 请求由同一个 Fargate Service 的 HTTP Server 处理：

```
POST /webhook/telegram/{bot_id}
    │
    ▼
HTTP Server (Fargate 内)
    │
    ├── 1. 从路径提取 bot_id
    ├── 2. 从 DynamoDB 加载 Bot + Channel 配置
    ├── 3. 从 Secrets Manager 获取 Channel 凭证 (带缓存)
    ├── 4. 验证 Webhook 签名 (防伪造)
    │      ├── Telegram: 验证 secret_token header
    │      ├── Discord: 验证 Ed25519 签名
    │      └── Slack: 验证 signing secret
    │      # 飞书使用 WSClient 长连接, 不走 Webhook
    ├── 5. 解析消息格式 → 统一 Message 结构
    ├── 6. 写入 DynamoDB (messages 表, ttl = now + 90天)
    ├── 7. 检查触发条件 (@mention / 私聊)
    ├── 8. 如果触发 → 发送到 SQS FIFO
    │      MessageGroupId = {bot_id}#{group_jid}
    └── 9. 立即返回 200 (Webhook 要求快速响应)
```

**常驻进程的缓存优势：**

```
Lambda 模式: 每次冷启动都要查 DynamoDB + Secrets Manager
Fargate 模式: 进程内缓存 (TTL 5min)
  ├── Bot 配置缓存:     Map<bot_id, BotConfig>
  ├── Channel 凭证缓存: Map<channel_id, Credentials>
  └── Session 映射缓存: Map<bot_id#group_jid, SessionInfo>
  → 热路径零 DB 查询，Secrets Manager 调用量降低 90%+
```

### 4.4 SQS Inbound Consumer (后台线程)

同一 Fargate 进程内的后台消费者，采用异步 fire-and-forget 模式：

```
SQS Inbound Consumer (后台长轮询, consumer.ts → dispatcher.ts)
    │
    │ sqs.receiveMessage({ WaitTimeSeconds: 20, VisibilityTimeout: 600 })
    │
    ├── 1. 从消息提取 payload (inbound_message 或 scheduled_task)
    ├── 2. 加载 Bot 配置 (getCachedBot — 内存缓存)
    ├── 3. 配额检查:
    │      ├── ensureUser() — 自动创建用户 (首次)
    │      ├── 月度 Token 限额检查 → 超限则通知 Channel 并丢弃
    │      └── 并发 Agent 槽位 (checkAndAcquireAgentSlot, 原子 DDB 递增)
    ├── 4. 从 DynamoDB 加载近期消息 (逆序取最近 50 条, 过滤 bot 消息)
    ├── 5. 格式化为 XML (formatMessages, NanoClaw router 格式)
    ├── 6. 解析模型供应商 (Bot.providerId → Providers 表 → 凭证 + modelId)
    ├── 7. 构建 InvocationPayload (含 memoryPaths, 供应商凭证, 飞书工具配置, replyContext)
    ├── 8. InvokeAgentRuntimeCommand (异步 — 立即返回 { status: 'accepted' })
    │      Agent 在后台执行，结果通过 SQS Reply Queue 回传
    ├── 9. 检查 ack 状态 (非 accepted 则通知 Channel 调用失败)
    ├── 10. 释放 Agent 槽位 (releaseAgentSlot)
    └── 11. sqs.deleteMessage() 确认消费 (失败则不删, VisibilityTimeout 后重试)

    并发控制: Semaphore(MAX_CONCURRENT_DISPATCHES=20)
    释放: finally 块中 releaseAgentSlot(), semaphore.release()
```

### 4.5 SQS Reply Consumer (后台线程)

消费 Agent 回复消息：包括 MCP `send_message` 发送的中间消息，以及异步调用完成后的最终回复（含 session/usage metadata）。

```
SQS Reply Consumer (后台长轮询, reply-consumer.ts)
    │
    │ sqs.receiveMessage({ WaitTimeSeconds: 20, VisibilityTimeout: 60 })
    │
    ├── 1. 解析 SqsReplyPayload (botId, groupJid, channelType, text, metadata?)
    ├── 2. 查找 Channel Adapter (registry.get(channelType))
    ├── 3. adapter.sendReply(ctx, formattedText) → 频道 API
    └── 4. 处理 metadata (仅最终回复携带):
           ├── isFinalReply → 写入 DynamoDB messages 表 (bot 回复记录)
           ├── newSessionId → 更新 DynamoDB sessions 表
           └── tokensUsed   → 更新用量统计 (updateUserUsage)
```

### 4.6 Channel Adapter Registry

统一频道出站接口，解耦 Dispatcher 与具体频道 API：

```
ChannelAdapter (interface, @clawbot/shared/channel-adapter)
├── channelType: string
├── start(): Promise<void>
├── stop(): Promise<void>
├── sendReply(ctx: ReplyContext, text: string, opts?: ReplyOptions): Promise<void>
└── registerCommands?() / unregisterCommands?()  — 可选 (Discord Slash)

BaseChannelAdapter (abstract class, adapters/base.ts)
└── 提供公共日志 logger, init() 方法

AdapterRegistry (singleton, adapters/registry.ts)
├── register(adapter) → 注册 adapter
├── get(channelType) → 按类型查找
├── startAll() / stopAll()
└── 启动时在 index.ts 中初始化: Discord, Feishu, Telegram, Slack

DiscordAdapter (adapters/discord/index.ts)
├── Gateway 连接 (discord.js Client)
│   ├── DynamoDB 分布式锁选举 (sessions 表, TTL=60s, 每 30s 续约)
│   ├── Leader 连接 Gateway → 接收 MessageCreate, InteractionCreate
│   └── Standby 每 30s 轮询锁, Leader 失效时接管
├── 消息处理: @mention 检测, 触发判断, 附件下载, SQS 入队
├── 打字指示器: startTyping() → 每 9s sendTyping(), 回复后清除
├── Slash Commands: 自动注册 guild commands (registerGuildCommands)
├── Embeds: formatDiscordReply() → 富文本 Embed + 溢出分段
└── 回复路由: Gateway client 优先 → REST fallback

FeishuAdapter (adapters/feishu/index.ts)
├── Gateway 连接 (Lark SDK WSClient)
│   ├── DynamoDB 分布式锁选举 (sessions 表, TTL=30s, 每 15s 续约)
│   ├── Leader 通过 FeishuGatewayManager 管理所有飞书 Bot 的 WSClient
│   └── Standby 每 15s 轮询锁, Leader 失效 → 30s 内接管
├── 消息处理: @bot 提及检测, 私聊/群聊触发, 附件下载, SQS 入队
├── Reaction 确认: 收到消息 → 添加 "OnIt" reaction → 回复完成后移除
├── 卡片消息: Markdown 包装为 Interactive Card (schema 2.0)
├── 文本分块: 4000 字符上限, Markdown 感知分割 (不截断代码块)
├── 域名支持: feishu.cn (中国区) / larksuite.com (国际版)
└── MCP 工具集: feishu_doc, feishu_wiki, feishu_drive, feishu_perm (Agent Runtime 侧)

TelegramAdapter (adapters/telegram/index.ts)
├── start/stop: no-op (Webhook 模式)
└── sendReply: 加载凭证 → sendMessage(botToken, chatId, text)

SlackAdapter (adapters/slack/index.ts)
├── start/stop: no-op (Webhook 模式)
└── sendReply: 加载凭证 → sendMessage(botToken, channelId, text)
```

**并发控制：** SQS Consumer 并行处理多条消息，通过信号量控制并发：

```typescript
const MAX_CONCURRENT_DISPATCHES = 20; // 单 Task 最大并发
const semaphore = new Semaphore(MAX_CONCURRENT_DISPATCHES);

async function consumeLoop() {
  while (running) {
    const messages = await sqs.receiveMessage({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 10,     // 批量拉取
      WaitTimeSeconds: 20,         // 长轮询
      VisibilityTimeout: 600,      // 10 分钟处理窗口
    });

    for (const msg of messages.Messages ?? []) {
      await semaphore.acquire();
      dispatch(msg).finally(() => semaphore.release());
    }
  }
}
```

**多 Task 分摊负载：**

```
ECS Service: desiredCount = 2 (最小高可用)
  Task-1: SQS Consumer × 20 并发 + HTTP Server
  Task-2: SQS Consumer × 20 并发 + HTTP Server

ALB 在两个 Task 间做 HTTP 负载均衡。
SQS FIFO 的 MessageGroupId 保证同一 group 的消息
被同一个 consumer 顺序处理 (同一时刻只有一个 consumer 可见)。

SQS FIFO 吞吐:
  使用高吞吐模式 (PER_MESSAGE_GROUP_ID):
  每个 MessageGroupId 独立 300 msg/s 限额
  整体队列吞吐 = 300 × 活跃 MessageGroupId 数
  1000 个活跃 group → 300,000 msg/s (远超需求)

Auto Scaling:
  指标: SQS ApproximateNumberOfMessagesVisible
  阈值: > 50 → 扩容, 持续 0 达 30min → 缩至 2 (不缩到 0, 保高可用)
```
