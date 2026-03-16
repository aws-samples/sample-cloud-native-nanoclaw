[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 5. 数据模型

### 5.1 DynamoDB 表设计

采用**多表设计**（比单表更清晰，多租户场景下查询模式明确）：

#### users 表

```
PK: user_id (Cognito sub)
─────────────────────────
email, display_name, created_at, last_login,

# 配额与计划
plan (free/pro/enterprise),
quota (JSON): {
  max_bots: 3,                    # 最大 Bot 数
  max_groups_per_bot: 10,         # 每 Bot 最大 Group 数
  max_tasks_per_bot: 20,          # 每 Bot 最大定时任务数
  max_concurrent_agents: 2,       # 最大并发 Agent 数
  max_monthly_tokens: 500000,     # 每月最大 Bedrock token 用量
},

# 用量追踪 (按月滚动)
usage_month: "2026-03",           # 当前计费月
usage_tokens: 123456,             # 当月已用 token 数
usage_invocations: 456,           # 当月 Agent 调用次数
active_agents: 1,                 # 当前活跃 Agent 数 (实时)
```

#### bots 表

```
PK: user_id    SK: bot_id
─────────────────────────
name, description, system_prompt, status (active/paused/deleted),
trigger_pattern, container_config (JSON), created_at, updated_at

GSI: bot_id-index
  PK: bot_id  → 用于 Webhook 路由 (通过 bot_id 查 Bot)
```

#### channels 表

```
PK: bot_id    SK: channel_type#channel_id
─────────────────────────────────────────
channel_type (telegram/discord/slack/whatsapp),
credential_secret_arn (Secrets Manager ARN),
webhook_url, status (connected/disconnected/error),
config (JSON), created_at,

# 凭证健康检查
last_health_check: "2026-03-14T10:00:00Z",  # 上次检查时间
health_status: "healthy" | "unhealthy" | "unknown",
health_error: "401 Unauthorized",             # 最近的错误信息 (如有)
consecutive_failures: 0,                      # 连续失败次数
user_notified_at: null                        # 通知用户的时间 (避免重复通知)
```

#### groups 表

```
PK: bot_id    SK: group_jid
─────────────────────────────
name, channel_type, is_group (bool),
requires_trigger (bool), last_message_at,
agentcore_session_id, session_status (active/idle/terminated)
```

#### messages 表

```
PK: bot_id#group_jid    SK: timestamp (ISO 8601, 毫秒精度)
─────────────────────────────────────
message_id, sender, sender_name, content,
is_from_me (bool), is_bot_message (bool), channel_type,
ttl (Number, Unix epoch seconds)   # DynamoDB TTL 自动过期

TTL 策略: created_at + 90 天 (7,776,000 秒)
  → 90 天前的消息自动删除，无需手动清理
  → 对话归档已通过 PreCompact hook 持久化到 S3

热分区缓解:
  DynamoDB 按需模式会对高流量分区自适应分裂 (adaptive capacity)。
  单分区写入上限 1,000 WCU/s，对应约 1,000 条消息/秒/group。
  超出此限制的极端场景 (如 Bot 被拉入万人群):
    1. Webhook 层的 WAF 速率限制先拦截 (2000 req/5min/IP)
    2. SQS FIFO 的 MessageGroupId 天然限流 (300 msg/s/group)
    3. 如仍不够 → 消息写入改为批量写入 (BatchWriteItem, 25条/批)

查询优化:
  加载上下文时使用 ScanIndexForward=false + Limit，只取最近 N 条:
    Query(PK=xx, ScanIndexForward=false, Limit=50)
  → 无论历史消息多少，查询时间恒定 O(1)
  → 不使用 Scan，不做全量加载
```

#### tasks 表

```
PK: bot_id    SK: task_id
──────────────────────────
group_jid, prompt, schedule_type (cron/interval/once),
schedule_value, context_mode (isolated/group),
next_run, last_run, last_result, status (active/paused/cancelled),
eventbridge_schedule_arn, created_at
```

#### sessions 表

```
PK: bot_id#group_jid    SK: "current"
──────────────────────────────────────
agentcore_session_id, s3_session_path,
last_active_at, status
```

### 5.2 S3 存储结构

```
s3://clawbot-data/
├── {user_id}/
│   ├── shared/                          # 用户级共享知识 (跨 Bot 只读)
│   │   └── CLAUDE.md                    # 用户共享记忆 (如公司上下文)
│   │
│   └── {bot_id}/
│       ├── memory/
│       │   ├── global/CLAUDE.md         # Bot 全局记忆
│       │   └── {group_jid}/CLAUDE.md    # Group 记忆
│       ├── sessions/
│       │   └── {group_jid}/
│       │       └── .claude/             # Claude Agent SDK session 文件
│       │           ├── session.jsonl
│       │           └── projects/...
│       ├── archives/
│       │   └── conversations/           # 对话归档
│       └── attachments/                 # 多媒体附件 (图片/文件/语音)
│           └── {message_id}/
│               ├── image.jpg
│               ├── voice.ogg
│               └── document.pdf

记忆加载优先级 (Agent 启动时):
  1. {userId}/shared/CLAUDE.md          → /workspace/shared/ (只读, 跨 Bot)
  2. {userId}/{botId}/memory/global/    → /workspace/global/ (只读, Bot 级)
  3. {userId}/{botId}/memory/{groupJid}/ → /workspace/group/ (读写, Group 级)

记忆写入权限:
  - shared/CLAUDE.md:   仅用户通过 Web UI 编辑 (Agent 只读)
  - global/CLAUDE.md:   Agent 可写 (Bot 级持久记忆)
  - {groupJid}/CLAUDE.md: Agent 可写 (Group 级持久记忆)
```

### 5.3 Secrets Manager 结构

```
每个 Channel 一个 Secret:
clawbot/{bot_id}/telegram/{channel_id}
  → { "bot_token": "123456:ABC-DEF..." }

clawbot/{bot_id}/discord/{channel_id}
  → { "bot_token": "...", "public_key": "..." }

clawbot/{bot_id}/slack/{channel_id}
  → { "bot_token": "xoxb-...", "signing_secret": "..." }

clawbot/{bot_id}/whatsapp/{channel_id}
  → { "phone_number_id": "...", "access_token": "...", "app_secret": "..." }
```
