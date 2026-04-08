[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 6. 消息生命周期

### 6.1 Webhook 模式 (Telegram/Slack/WhatsApp)

```
步骤 1: 用户在 Telegram 群里发消息
  Telegram Server → POST /webhook/telegram/{bot_id}

步骤 2: Fargate HTTP Server (Webhook 处理)
  ├── 验证签名 (从内存缓存获取凭证)
  ├── 解析消息 → 统一 Message 格式
  ├── 处理附件 → 下载到 S3 (downloadAndStore)
  ├── 写入 DynamoDB messages 表 (TTL = +90天)
  ├── 检查触发条件
  │   ├── 私聊 → 始终触发
  │   └── 群聊 → 检查 @mention 或 trigger_pattern
  ├── 触发 → SQS FIFO (MessageGroupId = {bot_id}#{group_jid})
  └── 立即返回 200 OK (< 100ms)

步骤 3: Fargate SQS Inbound Consumer (同一进程, 后台线程)
  ├── 长轮询拉取消息 (WaitTimeSeconds: 20)
  ├── 加载 Bot 配置 (getCachedBot, 内存缓存)
  ├── 配额检查:
  │   ├── ensureUser() — 自动创建/获取用户
  │   ├── 月度 Token 限额 → 超限通知 Channel 并丢弃
  │   └── 并发 Agent 槽位 (原子 DDB 递增, maxConcurrentAgents)
  ├── 加载近期消息 (Query, 逆序最近 50 条, 过滤 bot 消息)
  ├── 格式化为 XML (formatMessages)
  ├── 构建 InvocationPayload (含 memoryPaths, replyContext)
  ├── InvokeAgentRuntime(runtimeSessionId, payload)
  │   → 异步 fire-and-forget, 立即返回 { status: 'accepted' }
  ├── 释放 Agent 槽位 (releaseAgentSlot)
  └── sqs.deleteMessage() 确认消费

步骤 4: AgentCore Runtime (microVM, 后台执行)
  ├── /invocations 收到请求, setBusy(), 立即返回 accepted
  ├── 后台执行 runInBackground():
  │   ├── STS AssumeRole (ABAC: userId + botId tags)
  │   ├── Session 切换检测 → 不同 bot/group 则清理 workspace
  │   ├── syncFromS3: 恢复 session + 7 个 context 文件
  │   ├── 模板检查: 首次运行 → 复制 IDENTITY/SOUL/BOOTSTRAP/USER 默认模板
  │   ├── detectExistingSession() → 判断 isNewSession
  │   ├── buildSystemPrompt() → 9 Section 结构化系统提示词
  │   ├── Claude Agent SDK query() 处理消息
  │   │   ├── Bedrock Claude (CLAUDE_CODE_USE_BEDROCK=1)
  │   │   ├── MCP 工具: send_message → SQS 回复队列 (中间消息)
  │   │   └── PreCompact hook: 归档对话到 conversations/
  │   ├── syncToS3: 回写 session + CLAUDE.md + context 文件
  │   └── sendFinalReply() → SQS 回复队列 (含 session/usage metadata)
  ├── 失败 → sendErrorReply() → SQS 回复队列 (通知用户)
  └── finally: setIdle()
  执行期间 /ping 返回 HealthyBusy, 完成后返回 Healthy

步骤 5: Fargate Reply Consumer (收到 SQS 回复)
  ├── 通过 Channel Adapter Registry 发送回复
  │   └── registry.get(channelType) → adapter.sendReply(ctx, text)
  ├── 处理 metadata (最终回复携带):
  │   ├── 写入 DynamoDB messages 表 (Bot 回复, TTL = +90天)
  │   ├── 更新 DynamoDB sessions 表
  │   └── 更新用量统计 (updateUserUsage)
  └── sqs.deleteMessage() 确认消费

步骤 6: 用户在 Telegram 收到回复
```

### 6.2 Gateway 模式 (Discord)

Discord 使用 Gateway (WebSocket) 接收消息，而非 Webhook：

```
步骤 1: 用户在 Discord 频道里 @Bot
  Discord Gateway → DiscordAdapter (Leader 实例)

步骤 2: DiscordAdapter.handleMessage()
  ├── 过滤 bot 消息
  ├── @mention 翻译 (移除 <@botId> 标记)
  ├── 触发检测: DM 始终触发 / Guild 需 @mention 或 pattern
  ├── 开始 typing 指示器 (每 9s sendTyping)
  ├── 处理附件 → downloadAndStore → S3
  ├── Group 配额检查 (maxGroupsPerBot)
  ├── getOrCreateGroup (自动发现新频道)
  ├── 写入 DynamoDB messages 表
  └── SQS FIFO 入队 (含 replyContext: { discordChannelId })

步骤 3-4: (同 Webhook 模式)

步骤 5: Channel Adapter 发送回复
  ├── 清除 typing 指示器
  ├── 如有 interactionToken → editInteractionReply (Embed)
  ├── 否则 → sendChannelMessage (Gateway client 优先, REST fallback)
  └── 长消息自动分段 (2000 char limit)
```

**错误恢复：**
- Webhook 处理失败 → ALB 返回 500，Telegram 会重试
- SQS 消息处理失败 → VisibilityTimeout 到期后自动重新可见 → 重试
- 重试 3 次仍失败 → 进入 DLQ (死信队列)，触发告警
- AgentCore ack 失败 → 不删除 SQS 消息，等待重试
- Agent 后台执行失败 → sendErrorReply() 通过 SQS 回复队列通知用户
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
