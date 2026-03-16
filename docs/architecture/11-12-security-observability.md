[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 11. 安全架构

### 11.1 安全分层

```
┌─────────────────────────────────────┐
│ 层级 1: 用户认证                      │
│ ├── Cognito User Pool (JWT)          │
│ ├── Express 中间件 JWT 验证           │
│ └── 所有 /api/* 端点需要认证           │
├─────────────────────────────────────┤
│ 层级 2: 资源隔离 (Control Plane)      │
│ ├── Bot 查询附加 user_id 条件         │
│ ├── 用户只能操作自己的 Bot            │
│ └── S3 路径包含 user_id 前缀          │
├─────────────────────────────────────┤
│ 层级 3: Agent 数据隔离 (ABAC)        │
│ ├── 双 Role 架构: 基础 Role 无 S3    │
│ ├── STS AssumeRole + Session Tags   │
│ ├── S3 路径: ${userId}/${botId}/*    │
│ ├── DynamoDB: LeadingKeys = botId   │
│ └── Scheduler: 资源名含 botId        │
├─────────────────────────────────────┤
│ 层级 4: 凭证安全                      │
│ ├── Channel 凭证存 Secrets Manager   │
│ ├── Agent 通过 IAM Role 访问 Bedrock │
│ ├── Agent 容器内无 Channel 凭证       │
│ └── Bash 工具继承基础 Role (无 S3)    │
├─────────────────────────────────────┤
│ 层级 5: Agent 执行隔离                │
│ ├── AgentCore microVM (进程+内存隔离) │
│ ├── 每 session 独立文件系统            │
│ ├── 15 分钟空闲后销毁 + 内存清零       │
│ └── 网络隔离 (可选 VPC 模式)          │
├─────────────────────────────────────┤
│ 层级 6: Webhook 安全                  │
│ ├── 每种 Channel 的签名验证           │
│ ├── bot_id 合法性检查                 │
│ ├── 速率限制 (ALB + 应用层限流)       │
│ └── WAF 防 DDoS (ALB 关联 WAF)      │
└─────────────────────────────────────┘
```

### 11.2 租户数据隔离 (双层防御)

**第一层：Control Plane 应用层隔离 (API 请求)**

```
所有 DynamoDB 查询强制附加 owner 校验:

// ❌ 不安全
const bot = await getBot(botId);

// ✅ 安全 (查询层面隔离)
const bot = await dynamodb.get({
  TableName: 'bots',
  Key: { user_id: currentUserId, bot_id: botId }
});
```

**第二层：Agent 容器 IAM ABAC 隔离 (数据访问)**

```
Agent 基础 Role (AgentCore 绑定)
  ├── Bedrock: ✅ (所有 session 共享，无需隔离)
  ├── STS AssumeRole: ✅ (获取 scoped 凭证)
  ├── SQS 回复队列: ✅ (公共通道)
  ├── S3: ❌ 无权限
  ├── DynamoDB: ❌ 无权限
  └── Scheduler: ❌ 无权限

Agent Scoped Role (STS AssumeRole 获取, 带 Session Tags)
  ├── S3: ✅ 仅 {userId}/{botId}/* (IAM 条件)
  ├── DynamoDB: ✅ 仅 LeadingKeys={botId} (IAM 条件)
  └── Scheduler: ✅ 仅 clawbot-{botId}-* (资源名)

安全效果:
  - Agent 代码 bug → IAM 403 (跨租户路径被拒绝)
  - Bash 工具 aws s3 ls → 基础 Role 无 S3 权限，失败
  - Prompt 注入 → Scoped 凭证只能访问当前 bot 数据
```

详见 [9.10 Agent IAM — 双 Role ABAC 隔离](./09-10-agent-runtime.md#910-agent-iam--双-role-abac-隔离)。

### 11.3 Channel 凭证安全

```
用户输入 Token → HTTPS → Fargate API
    │
    ├── 验证 Token 有效性 (调用 Channel API)
    ├── 加密存入 Secrets Manager
    │   └── KMS 加密，IAM Policy 限制访问
    ├── DynamoDB 只存 Secret ARN (不存明文)
    │
    └── Agent 执行时:
        Fargate SQS Consumer 从内存缓存获取 Token
        仅在回复时使用，不传入 Agent 容器
```

**Agent 容器内没有 Channel 凭证。** Agent 通过 SQS 回复队列发送消息，Fargate Control Plane 消费后调 Channel API。Agent 只生产文本，不接触任何 Channel 凭证。

### 11.4 用量配额与限流

多租户平台必须防止单用户耗尽共享资源。在 Dispatcher 调度 Agent 之前进行配额检查。

#### 配额模型

```
Plan 配置 (users 表 quota 字段):

| 配额项                  | Free   | Pro     | Enterprise |
|------------------------|--------|---------|------------|
| max_bots               | 1      | 5       | 50         |
| max_groups_per_bot     | 3      | 20      | 200        |
| max_tasks_per_bot      | 5      | 50      | 500        |
| max_concurrent_agents  | 1      | 3       | 10         |
| max_monthly_tokens     | 100K   | 1M      | 10M        |
| max_message_length     | 4K     | 16K     | 64K        |
```

#### 检查时机

```
Webhook 接收消息
    │
    ├── 检查 1: Bot 状态 (active?)
    ├── 检查 2: 消息长度 (< max_message_length?)
    └── 入队 SQS
          │
          ▼
SQS Consumer (Dispatcher)
    │
    ├── 检查 3: 月度 token 配额
    │   └── users.usage_tokens < users.quota.max_monthly_tokens?
    │       ├── 是 → 继续
    │       └── 否 → 回复 "本月用量已达上限" + 不调 Agent
    │
    ├── 检查 4: 并发 Agent 数
    │   └── users.active_agents < users.quota.max_concurrent_agents?
    │       ├── 是 → 继续
    │       └── 否 → SQS 消息不删除，等待重试 (VisibilityTimeout 后重新可见)
    │
    └── 通过 → InvokeAgentRuntime
          │
          ▼
Agent 返回结果
    │
    ├── 更新 users.usage_tokens += response_tokens
    ├── 更新 users.usage_invocations += 1
    └── 更新 users.active_agents -= 1
```

#### 资源创建时配额检查

```
POST /api/bots (创建 Bot)
    └── 检查: 用户当前 bot 数 < quota.max_bots

POST /api/bots/{bot_id}/channels (添加 Channel)
    └── 无 Channel 数限制 (每种类型最多 1 个自然限制)

Webhook 自动发现 Group
    └── 检查: bot 当前 group 数 < quota.max_groups_per_bot
        超限 → 消息不入队，不自动注册 Group

schedule_task (MCP 工具, Agent 内)
    └── 检查: bot 当前 task 数 < quota.max_tasks_per_bot
        超限 → MCP 工具返回错误信息给 Agent
```

#### 并发计数的原子性

```typescript
// 使用 DynamoDB 原子操作更新 active_agents

// 获取 Agent slot (调度前)
const acquired = await dynamodb.send(new UpdateItemCommand({
  TableName: 'clawbot-users',
  Key: { user_id: { S: userId } },
  UpdateExpression: 'SET active_agents = active_agents + :one',
  ConditionExpression: 'active_agents < quota.max_concurrent_agents',
  ExpressionAttributeValues: { ':one': { N: '1' } },
}));
// ConditionExpression 失败 → ConditionalCheckFailedException → 不调度

// 释放 Agent slot (完成后, 在 finally 块中)
await dynamodb.send(new UpdateItemCommand({
  TableName: 'clawbot-users',
  Key: { user_id: { S: userId } },
  UpdateExpression: 'SET active_agents = active_agents - :one',
  ExpressionAttributeValues: { ':one': { N: '1' } },
}));
```

**防泄漏：** 如果 Dispatcher 进程崩溃导致 `active_agents` 没有 -1，加一个补偿机制：

```
每 5 分钟扫描: 查询所有 active_agents > 0 的用户
对比实际 AgentCore 活跃 session 数 (ListRuntimeSessions API)
如有差异 → 修正 active_agents 计数
```

#### 月度用量自动重置

```
每月 1 号 00:00 UTC (EventBridge Scheduler)
    │
    ▼
扫描所有 users 表
    ├── 如果 usage_month != 当前月 → 重置:
    │   usage_month = "2026-04"
    │   usage_tokens = 0
    │   usage_invocations = 0
    └── 如果 usage_month == 当前月 → 跳过
```

#### 超限用户通知

```
Token 配额用到 80% → 通知: "您本月已使用 80% token 配额"
Token 配额用到 100% → 通知: "本月 token 配额已用完，Agent 暂停响应"
并发 Agent 达上限 → 排队，不通知 (自动等待)
Bot/Group/Task 数达上限 → 创建时拒绝 + 返回错误信息
```

---

## 12. 可观测性

### 12.1 监控指标

| 指标 | 来源 | 告警阈值 |
|------|------|---------|
| Webhook 延迟 (p99) | ALB access log | > 1s |
| SQS 队列深度 | CloudWatch | > 50 条 |
| Agent 执行时长 (p95) | AgentCore Observability | > 120s |
| Agent 错误率 | AgentCore Observability | > 5% |
| Session 创建频率 | AgentCore | 突增告警 |
| DynamoDB 读写容量 | CloudWatch | > 80% 预置容量 |
| Fargate CPU/内存 | CloudWatch | > 80% |
| Fargate Task 数量 | ECS metrics | auto-scaling 触发 |
| Secrets Manager 调用量 | CloudWatch | 成本告警 |
| 配额拒绝次数 | Custom CloudWatch | > 10/min (可能有滥用) |
| Channel 健康检查失败数 | Custom CloudWatch | > 0 (需通知用户) |
| Token 用量 top 10 用户 | Custom Dashboard | 监控大户 |

### 12.2 日志结构

```
Fargate Service   → CloudWatch Logs (JSON structured, pino)
  ├── HTTP 请求日志 (Webhook + API)
  ├── SQS Consumer 日志 (消费 + 分发)
  └── 错误 + 异常日志
Agent Runtime     → AgentCore Observability (traces + spans)
                  → CloudWatch Logs (agent-runner 日志)
```

### 12.3 用户可见日志

Web 控制台展示给用户的日志（脱敏后）：

```
[2026-03-14 14:30:01] Telegram 消息接收: group-123, sender: Alice
[2026-03-14 14:30:02] Agent 开始处理 (session: active, 复用)
[2026-03-14 14:30:15] Agent 调用工具: Read("report.md")
[2026-03-14 14:30:28] Agent 回复发送 (耗时: 27s, tokens: 1,234)
```
