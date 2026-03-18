# 16. System Prompt & Native Memory

> Agent 的系统提示词与记忆架构：Claude Code 原生 CLAUDE.md 加载 + 精简 Append Content

---

## 16.1 设计动机

Agent 运行时利用 Claude Code 的原生 CLAUDE.md 机制来管理 Bot 记忆和身份，而非自行构建完整的系统提示词。我们只需 append 少量内容：

- **身份覆盖** — 将 Claude Code 的默认身份替换为 Bot 名称
- **频道适配** — Discord Markdown ≠ Slack mrkdwn ≠ Telegram MarkdownV2
- **安全策略** — 组织级管控策略（managed policy），不可被用户覆盖
- **运行时元数据** — 调试和 Agent 自我感知

**关键变化**：之前使用 direct 模式（手动构建完整 system prompt + 9 个 section + 自定义 token 预算），现在使用 **preset append 模式** — Claude Code 原生加载 CLAUDE.md，我们只 append 少量补充内容。

---

## 16.2 三层 CLAUDE.md 层级

Claude Code 通过 `settingSources: ['user', 'project']` 原生加载两级 CLAUDE.md：

```
容器内文件布局:

/etc/claude-code/CLAUDE.md         ← Managed policy（组织级安全策略，只读）
                                      来源: MANAGED_CLAUDE.md 模板，Dockerfile COPY

/home/node/.claude/CLAUDE.md       ← User 级：Bot 运营手册（身份、灵魂、规则、用户信息）
                                      来源: BOT_CLAUDE.md 模板（首次运行复制）
                                      Claude Code settingSources: 'user'

/workspace/group/CLAUDE.md         ← Project 级：Group 对话记忆
                                      来源: S3 同步下载
                                      Claude Code settingSources: 'project'
```

### S3 存储结构（简化后）

```
{userId}/
├── shared/
│   └── CLAUDE.md                       ← User 级：跨 Bot 共享记忆（保留，未来用途）
└── {botId}/
    ├── CLAUDE.md                       ← Bot 运营手册（botClaude，单文件同步）
    │                                      → /home/node/.claude/CLAUDE.md
    ├── learnings/                      ← 学习日志（目录同步）
    │   └── LEARNINGS.md                   → /workspace/learnings/
    ├── sessions/
    │   └── {groupJid}/                 ← Claude Code session state（目录同步）
    │       ├── CLAUDE.md                  → /home/node/.claude/（session 附带的副本）
    │       ├── backups/                   → /home/node/.claude/backups/
    │       ├── plugins/                   → /home/node/.claude/plugins/
    │       ├── skills/                    → /home/node/.claude/skills/
    │       └── projects/                  → /home/node/.claude/projects/
    └── workspace/
        └── {groupJid}/                 ← Group 工作区（目录同步）
            ├── CLAUDE.md                  → /workspace/group/CLAUDE.md（project 级记忆）
            ├── conversations/             → /workspace/group/conversations/（对话归档）
            ├── .claude/                   → /workspace/group/.claude/（project memory）
            └── ...                        → Agent 创建的其他文件

同步顺序（syncFromS3）:
  1. sessions/{gid}/  → /home/node/.claude/     （session state 整体恢复）
  2. botClaude        → /home/node/.claude/CLAUDE.md  （Bot 运营手册覆写 session 中的副本）
  3. workspace/{gid}/ → /workspace/group/       （Group 工作区整体恢复）
  4. learnings/       → /workspace/learnings/    （学习日志）

注意：session 目录会包含 ~/.claude/CLAUDE.md 的副本（因为整体上传）。
syncFromS3 中 botClaude 在 session 之后下载，确保 Bot 运营手册始终是权威版本。
```

| 文件 | 层级 | 容器路径 | 加载方式 | 用途 |
|------|------|---------|---------|------|
| MANAGED_CLAUDE.md | Org | `/etc/claude-code/CLAUDE.md` | Append content 注入 | 安全策略，不可覆盖 |
| BOT_CLAUDE.md | Bot (User) | `/home/node/.claude/CLAUDE.md` | Claude Code 原生（`user`） | 身份、灵魂、用户信息、运营规则 |
| Group CLAUDE.md | Group (Project) | `/workspace/group/CLAUDE.md` | Claude Code 原生（`project`） | 对话级记忆 |

### BOT_CLAUDE.md 模板

之前分散在多个文件（IDENTITY.md, SOUL.md, BOOTSTRAP.md, USER.md, BOT_CLAUDE.md）的内容，统一合并到一个 BOT_CLAUDE.md 模板中。首次运行时复制到 `/home/node/.claude/CLAUDE.md`。包含：

- **About You (Identity)** — 名字、角色、性格（Agent 首次对话时填写）
- **Your Soul** — 价值观和沟通风格
- **About Your User** — 人类用户信息
- **Communication Style** — 对话风格指导
- **Session Startup** — 每次对话的开场检查
- **Memory Management** — 记忆管理规则
- **Learning & Self-Improvement** — 学习日志和错误记录
- **Group Chat** — 群聊行为规则
- **Anti-Loop** — Bot-to-Bot 对话限制
- **Security** — 安全边界

Agent 可读写此文件——随着使用积累，Bot 会添加自己的规则和笔记。

### Managed Policy

`/etc/claude-code/CLAUDE.md` 由 Dockerfile 从 `MANAGED_CLAUDE.md` 模板 COPY，包含：
- 禁止泄露凭证
- 文件系统访问限制（/workspace 和 /home/node）
- 网络访问限制（禁止内网 IP）
- 权限升级禁止
- 不可被 user/project 级 CLAUDE.md 覆盖

---

## 16.3 Append Content 组装流程

```
                    ┌────────────────────────┐
                    │  buildAppendContent()   │
                    │  agent-runtime/src/     │
                    │  system-prompt.ts       │
                    └────────┬───────────────┘
                             │
           ┌─────────────────┼──────────────────┐
           ▼                 ▼                  ▼
     ┌──────────┐    ┌──────────────┐   ┌───────────────┐
     │ Managed  │    │   Payload    │   │ Channel Type  │
     │ Policy   │    │   Fields     │   │ (from message)│
     │ (static) │    │ (botName,etc)│   │               │
     └────┬─────┘    └──────┬───────┘   └───────┬───────┘
          │                 │                   │
          ▼                 ▼                   ▼
    ┌────────────────────────────────────────────────┐
    │     Append Content (5 sections, --- joined)    │
    │                                                │
    │  1. Managed Policy  ← /etc/claude-code/CLAUDE.md│
    │  2. Identity Override ← botName                │
    │  3. Channel Guidance  ← channelType            │
    │  4. Scheduled Task    ← isScheduledTask (可选)  │
    │  5. Runtime Metadata  ← bot/channel/group/model│
    └────────────────────────────────────────────────┘
                             │
                             ▼
        Preset append mode:
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: appendContent
        }

    Claude Code 原生加载:
    ├─ /home/node/.claude/CLAUDE.md  (user, Bot 运营手册)
    └─ /workspace/group/CLAUDE.md    (project, Group 记忆)
```

---

## 16.4 Append Content 详解

### Section 1: Managed Policy

从 `/etc/claude-code/CLAUDE.md` 读取（模块初始化时加载一次）。包含组织级安全策略，始终作为 append content 的第一部分注入，确保优先级最高。

### Section 2: Identity Override

```
# Identity Override
Ignore the "Claude Code" identity above. You are {botName}, a personal AI assistant running in a messaging channel.
Your identity, personality, values, and operating rules are in ~/.claude/CLAUDE.md — follow them.
```

始终存在。覆盖 Claude Code 默认的代码编辑器身份，引导 Agent 读取 BOT_CLAUDE.md 中的自定义身份。

### Section 3: Channel Guidance

根据 `channelType` 注入对应的格式指导：

| Channel | 关键指导 |
|---------|---------|
| **Discord** | 标准 Markdown、2000 字符 content / 4096 embed、`<@userId>` mention 格式 |
| **Telegram** | MarkdownV2（需转义特殊字符 `_ * [ ] ( ) ~ > # + - = \| { } . !`）、4096 字符限制 |
| **Slack** | mrkdwn（非标准 Markdown）、`*bold*` 单星号、`<url\|text>` 链接格式 |
| **WhatsApp** | 简单格式化、对话式简洁回复 |

### Section 4: Scheduled Task Note (可选)

```
**Note:** This is an automated scheduled task, not a direct user message.
Complete the task and report results. The user is not actively waiting for a reply.
```

仅在 `isScheduledTask = true` 时注入。

### Section 5: Runtime Metadata

```
Runtime: bot=01KKRN... | name=MyBot | channel=discord | group=dc:1234567 | model=claude-sonnet-4-20250514
```

单行元数据，用于调试和 Agent 自我感知。

---

## 16.5 与 Claude Code Preset 的关系

System prompt 使用 **preset append 模式**：

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: appendContent,    // ← managed policy + identity + channel + runtime
}
```

配合 `settingSources: ['user', 'project']`，Claude Code 原生加载：
- `user` → `/home/node/.claude/CLAUDE.md`（Bot 运营手册）
- `project` → `/workspace/group/CLAUDE.md`（Group 记忆）

**不再需要**：
- `system-prompt-base.md` — Claude Code preset 已包含 Role、Tools、Communication Style
- `memory.ts` — 不再需要自定义 token 预算/截断，Claude Code 原生处理 CLAUDE.md 加载
- 手动加载 IDENTITY.md, SOUL.md, BOOTSTRAP.md, USER.md — 合并到 BOT_CLAUDE.md

---

## 16.6 数据流时序

```
1. Control Plane (dispatcher.ts)
   │  构建 InvocationPayload，包含:
   │  - prompt: 消息内容（SQS payload 直传）
   │  - memoryPaths: { botClaude, groupPrefix, learnings }
   │
   ▼
2. AgentCore invocation → Agent Runtime (agent.ts)
   │
   ├─ syncFromS3():
   │    ├─ 下载 session 目录 → /home/node/.claude/
   │    ├─ 下载 botClaude    → /home/node/.claude/CLAUDE.md
   │    ├─ 下载 groupPrefix  → /workspace/group/ (full directory)
   │    └─ 下载 learnings/   → /workspace/learnings/
   │
   ├─ 模板检查: ~/.claude/CLAUDE.md 不存在?
   │            → 复制 BOT_CLAUDE.md（合并的身份/灵魂/用户/规则模板）
   │            总是复制 CODING_REFERENCE.md → /workspace/reference/
   │
   ├─ buildAppendContent():
   │    ├─ managed policy    → /etc/claude-code/CLAUDE.md
   │    ├─ identity override → botName
   │    ├─ channel guidance  → channelType
   │    ├─ scheduled task    → isScheduledTask (可选)
   │    └─ runtime metadata  → bot/channel/group/model
   │
   ├─ query({
   │    prompt,
   │    systemPrompt: { type: 'preset', preset: 'claude_code', append },
   │    continue: true,
   │    settingSources: ['user', 'project'],
   │  })
   │    └─ Claude Code 原生加载 CLAUDE.md（user + project 两级）
   │    └─ Agent 可用 Write/Edit 修改文件，syncToS3 回写
   │
   └─ syncToS3():
        ├─ 上传 session 目录
        ├─ 上传 ~/.claude/CLAUDE.md → botClaude S3 key
        ├─ 上传 /workspace/group/ → groupPrefix (full directory)
        └─ 上传 learnings/ → 学习日志
```

---

## 16.7 API 与 Web Console

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/shared-memory` | User Shared CLAUDE.md（跨 Bot 共享） |
| GET/PUT | `/bots/:botId/memory` | Bot CLAUDE.md（运营手册） |
| GET/PUT | `/bots/:botId/groups/:gid/memory` | Group CLAUDE.md（对话记忆） |

> **简化说明：** 之前有 7 个端点（shared, user-profile, identity, soul, bootstrap, bot-memory, group-memory），
> 现在只有 3 个。Identity/Soul/Bootstrap/User 统一合并到 Bot CLAUDE.md 中。

### Web Console Memory Editor

3 个标签页，通过 `?tab=` 查询参数切换：

```
[Shared Memory] [Bot Memory] [Group Memory]
```

- Shared Memory：`/memory` 路径，跨 Bot 共享
- Bot Memory：`/bots/:botId/memory` 路径，Bot 运营手册
- Group Memory：`/bots/:botId/groups/:gid/memory` 路径，对话记忆

---

## 16.8 关键文件

| 文件 | 职责 |
|------|------|
| `agent-runtime/src/system-prompt.ts` | Append content builder：`buildAppendContent()` + channel guidance + identity override |
| `agent-runtime/src/session.ts` | S3 同步：SyncPaths（sessionPath, botClaude, groupPrefix, learnings） |
| `agent-runtime/src/agent.ts` | 入口：模板复制、调用 builder、传递给 Claude SDK query()（preset append 模式） |
| `agent-runtime/templates/BOT_CLAUDE.md` | 合并的 Bot 运营手册模板：身份、灵魂、用户、规则、记忆管理 |
| `agent-runtime/templates/MANAGED_CLAUDE.md` | 组织级安全策略 → Dockerfile COPY → `/etc/claude-code/CLAUDE.md` |
| `agent-runtime/templates/CODING_REFERENCE.md` | 编码参考指南 → /workspace/reference/ |
| `control-plane/src/routes/api/memory.ts` | REST API：3 种 CLAUDE.md 文件的 GET/PUT |
| `shared/src/types.ts` | MemoryPaths 接口：`{ botClaude, groupPrefix, learnings }` |

> **已删除**：`memory.ts`（token 预算/截断逻辑）、`system-prompt-base.md`（直接模式基础模板）。
> Claude Code 原生处理 CLAUDE.md 加载和 token 管理。
