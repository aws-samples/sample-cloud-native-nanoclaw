[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 6. 消息生命周期

```
步骤 1: 用户在 Telegram 群里发消息
  Telegram Server → POST /webhook/telegram/{bot_id}

步骤 2: Fargate HTTP Server (Webhook 处理)
  ├── 验证签名 (从内存缓存获取凭证)
  ├── 解析消息 → 统一 Message 格式
  ├── 写入 DynamoDB messages 表
  ├── 检查触发条件
  │   ├── 私聊 → 始终触发
  │   └── 群聊 → 检查 @mention 或 trigger_pattern
  ├── 触发 → SQS FIFO (MessageGroupId = {bot_id}#{group_jid})
  └── 立即返回 200 OK (< 100ms)

步骤 3: Fargate SQS Consumer (同一进程, 后台线程)
  ├── 长轮询拉取消息
  ├── 加载 Bot 配置 (内存缓存, 命中率 > 95%)
  ├── 加载近期消息 (Query, 逆序最近 50 条, 过滤 bot 自身消息)
  ├── 格式化为 XML (NanoClaw router 格式)
  ├── 查询 session 映射 (内存缓存 → DynamoDB 兜底)
  └── InvokeAgentRuntime(runtimeSessionId, payload)
      → 同步等待, 无超时限制

步骤 4: AgentCore Runtime (microVM)
  ├── /invocations 端点收到请求
  ├── 从 S3 恢复 session 文件 (如果新 session)
  ├── 从 S3 加载 CLAUDE.md 记忆
  ├── Claude Agent SDK 处理消息
  │   └── Bedrock Claude (通过 IAM Role)
  ├── 生成回复
  ├── 回写 session 文件到 S3
  └── 返回结果给 Fargate SQS Consumer

步骤 5: Fargate SQS Consumer (收到结果)
  ├── 写入 DynamoDB messages 表 (Bot 回复)
  ├── 更新 session 缓存 + DynamoDB sessions 表
  ├── 从内存缓存获取 Channel 凭证
  ├── 调用 Telegram Bot API 发送回复
  └── sqs.deleteMessage() 确认消费

步骤 6: 用户在 Telegram 收到回复
```

**错误恢复：**
- Webhook 处理失败 → ALB 返回 500，Telegram 会重试
- SQS 消息处理失败 → VisibilityTimeout 到期后自动重新可见 → 重试
- 重试 3 次仍失败 → 进入 DLQ (死信队列)，触发告警
- AgentCore 调用失败 → 不删除 SQS 消息，等待重试
- Session 恢复失败 → 创建新 session，丢失上下文但不丢消息
- Fargate Task 崩溃 → ECS 自动重启 + ALB 健康检查摘除

---

## 7. Bot 生命周期

```
┌─────────┐    创建     ┌──────────┐   添加 Channel   ┌────────────┐
│ (不存在)  │──────────→│  created  │────────────────→│  ready     │
└─────────┘            └──────────┘                  └─────┬──────┘
                                                           │
                                              激活 (自动)   │
                                                           ▼
                       ┌──────────┐    暂停    ┌────────────┐
                       │  paused  │←──────────│   active    │
                       └────┬─────┘           └────────────┘
                            │                      ▲
                            │    恢复               │
                            └──────────────────────┘

                       任何状态 → deleted (软删除, 30天后硬删除)
```

**创建 Bot 流程：**

```typescript
// POST /api/bots
{
  name: "工作助手",
  description: "帮我处理日常工作事务",
  system_prompt: "你是一个专业的工作助手...",  // 可选
  trigger_pattern: "@Andy"                    // 可选，默认 @BotName
}
```

**配置项：**

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `name` | 必填 | Bot 显示名 |
| `system_prompt` | 默认 prompt | 注入到 CLAUDE.md 的全局指令 |
| `trigger_pattern` | `@{name}` | 群聊触发模式 |
| `max_turns` | 50 | 单次对话最大 Agent 轮次 |
| `timeout` | 300s | 单次执行超时 |
| `idle_memory_prompt` | 默认 | 空闲时写入记忆的指令 |
