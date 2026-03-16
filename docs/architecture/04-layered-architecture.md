[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 4. 分层架构详解

### 4.1 Web 控制台

```
技术栈: React / Next.js
部署:   S3 (静态资源) + CloudFront (CDN + HTTPS)
认证:   Cognito Hosted UI 或自建登录页 + Cognito SDK
```

**页面结构：**

| 页面 | 功能 |
|------|------|
| 登录/注册 | Cognito 认证 |
| Dashboard | Bot 列表、状态概览、用量统计 |
| Bot 详情 | 配置、Channel 管理、记忆编辑 |
| Channel 配置 | 添加/删除频道、填写凭证、连接状态 |
| 对话历史 | 按 Group 查看消息记录 |
| 定时任务 | 创建/暂停/恢复/删除任务 |
| 日志 | Agent 执行日志、错误追踪 |

### 4.2 ECS Fargate Service (Control Plane + Dispatcher)

Control Plane 和 Dispatcher 合并为一个常驻 Fargate Service，消除 Lambda 15 分钟超时限制。

```
技术栈: ECS Fargate Service (Node.js/TypeScript, Express/Fastify)
部署:   ALB (Application Load Balancer) → Fargate Task
认证:   Cognito JWT (Express 中间件验证)
规格:   0.5 vCPU / 1GB Memory, 最小 2 Task (高可用)
```

**进程内部结构：**

```
Fargate Task (单进程, 多线程)
├── HTTP Server (主线程)
│   ├── /api/*       → REST API 端点 (需 JWT 认证)
│   ├── /webhook/*   → Webhook 接收端点 (无需认证, 签名验证)
│   └── /health      → ALB 健康检查
│
├── SQS Consumer (后台线程, 长轮询)
│   ├── sqs.receiveMessage({ WaitTimeSeconds: 20 })
│   ├── 消费消息 → InvokeAgentRuntime (无超时限制)
│   └── 结果 → Channel API 回复
│
└── Session Tracker (内存缓存)
    └── Map<botId#groupJid, { sessionId, lastActiveAt }>
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

# 记忆管理 (需 JWT)
GET    /api/shared-memory                   # 获取用户共享记忆 (跨 Bot)
PUT    /api/shared-memory                   # 更新用户共享记忆
GET    /api/bots/{bot_id}/memory            # 获取 Bot 全局记忆
PUT    /api/bots/{bot_id}/memory            # 更新 Bot 全局记忆
GET    /api/bots/{bot_id}/groups/{gid}/memory  # Group 记忆
PUT    /api/bots/{bot_id}/groups/{gid}/memory  # 更新 Group 记忆

# Webhook (无需 JWT, 签名验证)
POST   /webhook/telegram/{bot_id}           # Telegram Webhook
POST   /webhook/discord/{bot_id}            # Discord Webhook
POST   /webhook/slack/{bot_id}              # Slack Events API
POST   /webhook/whatsapp/{bot_id}           # WhatsApp Webhook
GET    /webhook/whatsapp/{bot_id}           # WhatsApp 验证
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
    │      ├── Slack: 验证 signing secret
    │      └── WhatsApp: 验证 app secret
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

### 4.4 SQS Consumer (后台线程)

同一 Fargate 进程内的后台消费者，无超时限制：

```
SQS Consumer (后台长轮询)
    │
    │ sqs.receiveMessage({ WaitTimeSeconds: 20 })
    │
    ├── 1. 从消息提取 bot_id, group_jid
    ├── 2. 查内存缓存: 该 group 是否有活跃 AgentCore Session
    │      ├── 有 (< 15min) → 直接 InvokeAgentRuntime (复用)
    │      └── 无 / 过期 → 创建新 session
    ├── 3. 从 DynamoDB 加载近期消息 (逆序取最近 50 条)
    │      Query(PK={bot_id}#{group_jid}, ScanIndexForward=false, Limit=50)
    ├── 4. 格式化为 XML (复用 NanoClaw router 逻辑)
    ├── 5. AWS SDK InvokeAgentRuntimeCommand (同步等待, 无超时限制):
    │      agentcoreClient.send(new InvokeAgentRuntimeCommand({
    │        agentRuntimeArn: AGENTCORE_RUNTIME_ARN,
    │        runtimeSessionId: "{bot_id}---{group_jid}",
    │        payload: Buffer.from(JSON.stringify(invocationPayload)),
    │        contentType: 'application/json',
    │        accept: 'application/json',
    │      }))
    ├── 6. 解析 Agent 返回结果
    ├── 7. 写入 DynamoDB (bot 消息记录)
    ├── 8. 调用 Channel API 发送回复
    │      (从内存缓存获取凭证)
    └── 9. sqs.deleteMessage() 确认消费
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
