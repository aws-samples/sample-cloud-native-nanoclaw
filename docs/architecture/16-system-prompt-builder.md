# 16. System Prompt Builder

> Agent 的系统提示词构建架构：模块化 Section、Context 文件层级、Token 预算管理

---

## 16.1 设计动机

Agent 运行时需要一个结构化的系统提示词来引导 Claude 的行为。提示词不仅包含记忆内容，还需要：

- **身份定义** — Bot 是谁、扮演什么角色
- **人格语气** — 如何说话、什么风格
- **频道适配** — Discord Markdown ≠ Slack mrkdwn ≠ Telegram MarkdownV2
- **上下文管理** — 多层记忆文件的加载与 token 预算控制
- **生命周期感知** — 新会话 vs 续接会话的不同行为

灵感来自 [OpenClaw 的系统提示词架构](https://deepwiki.com/openclaw/openclaw/3.2-system-prompt-and-context)，针对 NanoClaw 的多租户模型做了简化适配。

---

## 16.2 Context 文件层级

```
S3 存储结构:
{userId}/
├── shared/
│   └── CLAUDE.md                 ← 用户级：跨 Bot 共享记忆 (read-only)
└── {botId}/
    ├── PERSONA.md                ← Bot 级：身份 + 语气 (read-only)
    ├── BOOTSTRAP.md              ← Bot 级：新会话首次指令 (read-only)
    └── memory/
        ├── global/
        │   └── CLAUDE.md         ← Bot 级：持久记忆 (read-only)
        └── {groupJid}/
            ├── CLAUDE.md         ← Group 级：对话记忆 (read-write)
            └── USER.md           ← Group 级：关于对话中的人 (read-only)
```

| 文件 | 层级 | 读写 | 用途 | 类比 OpenClaw |
|------|------|------|------|--------------|
| `PERSONA.md` | Bot | 只读 | 身份定义 + 语气风格 | IDENTITY.md + SOUL.md |
| `BOOTSTRAP.md` | Bot | 只读 | 新会话首次指令（仅首次注入） | BOOTSTRAP.md |
| `USER.md` | Group | 只读 | 关于对话中的人类用户 | USER.md |
| `CLAUDE.md` (shared) | User | 只读 | 跨 Bot 共享知识 | — |
| `CLAUDE.md` (global) | Bot | 只读 | Bot 级持久记忆 | MEMORY.md |
| `CLAUDE.md` (group) | Group | 读写 | 对话级记忆，Agent 可自主更新 | memory/*.md |

---

## 16.3 System Prompt 组装流程

```
                    ┌─────────────────────────┐
                    │   buildSystemPrompt()    │
                    │   agent-runtime/src/     │
                    │   system-prompt.ts       │
                    └─────────┬───────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
      ┌──────────┐    ┌──────────┐    ┌───────────────┐
      │ S3 Files │    │ Payload  │    │ Channel Type  │
      │ (synced) │    │ Fields   │    │ (from message)│
      └────┬─────┘    └────┬─────┘    └───────┬───────┘
           │               │                  │
           ▼               ▼                  ▼
    ┌──────────────────────────────────────────────┐
    │              8 Sections (in order)             │
    │                                               │
    │  1. Identity      ← botName                   │
    │  2. Persona       ← PERSONA.md / systemPrompt │
    │  3. Bootstrap     ← BOOTSTRAP.md (new only)   │
    │  4. Channel       ← channelType               │
    │  5. Reply Guide   ← isScheduledTask           │
    │  6. User Context  ← USER.md                   │
    │  7. Memory        ← 3× CLAUDE.md (budgeted)   │
    │  8. Runtime       ← metadata line              │
    └──────────────────────────────────────────────┘
                              │
                              ▼
              Claude Code Preset + append
              ─────────────────────────
              systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: builtContent    ← 8 sections joined by ---
              }
```

---

## 16.4 Section 详解

### Section 1: Identity

```
# Identity
You are {botName}, a personal AI assistant.
```

始终存在。为 Agent 建立基本身份。

### Section 2: Persona

```
# Persona
Embody this persona in all your interactions — adopt its identity, tone, and style:

{PERSONA.md 内容}
```

**优先级：** PERSONA.md > Bot.systemPrompt > 跳过

PERSONA.md 是独立文件，支持长篇人设定义（如角色背景、知识领域、禁忌话题等）。当 PERSONA.md 不存在时，回退到 Bot 记录中的 `systemPrompt` 字段。两者都没有则跳过此 section。

### Section 3: Bootstrap

```
# First Session Instructions
This is a new conversation. Follow these initial instructions:

{BOOTSTRAP.md 内容}
```

**仅在新会话时注入。** 通过 `detectExistingSession()` 判断：
- 无已有 session → `isNewSession = true` → 注入
- 有 session ID（续接对话） → `isNewSession = false` → 跳过

典型用途：首次交互时自我介绍、询问用户需求、建立对话基调。

### Section 4: Channel Guidance

根据 `channelType` 注入对应的格式指导：

| Channel | 关键指导 |
|---------|---------|
| **Discord** | 标准 Markdown、2000 字符 content / 4096 embed、`<@userId>` mention 格式 |
| **Telegram** | MarkdownV2（需转义特殊字符 `_ * [ ] ( ) ~ > # + - = \| { } . !`）、4096 字符限制 |
| **Slack** | mrkdwn（非标准 Markdown）、`*bold*` 单星号、`<url\|text>` 链接格式 |
| **WhatsApp** | 简单格式化、对话式简洁回复 |

这确保 Agent 生成的回复在目标平台上正确渲染。

### Section 5: Reply Guidelines

```
# Reply Guidelines
- Keep responses concise and focused on what was asked
- Use the `send_message` MCP tool when you need to send intermediate updates
- Match the language of the user — if they write in Chinese, respond in Chinese
```

如果是定时任务，追加：

```
**Note:** This is an automated scheduled task, not a direct user message.
Complete the task and report results.
```

### Section 6: User Context

```
# About Your Users
{USER.md 内容}
```

GROUP 级别的文件，描述对话中的人类用户。仅在 `USER.md` 存在时注入。

### Section 7: Memory

```
# Shared Memory
{shared/CLAUDE.md}

---

# Bot Memory
{global/CLAUDE.md}

---

# Group Memory
{group/CLAUDE.md}
```

三层记忆按层级加载，每层受 token 预算约束（见 §16.5）。

### Section 8: Runtime Metadata

```
Runtime: bot=01KKRN... | name=MyBot | channel=discord | group=dc:1234567
```

单行元数据，用于调试和 Agent 自我感知。

---

## 16.5 Token 预算管理

防止大量记忆内容超出上下文窗口的关键机制。

### 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `perFileCap` | 20,000 字符 | 单个文件最大字符数 |
| `totalCap` | 100,000 字符 | 所有 Memory 层总字符数 |
| `headRatio` | 0.7 | 截断时保留文件头部的比例 |
| `tailRatio` | 0.2 | 截断时保留文件尾部的比例 |

### 截断策略

```
原始文件（30,000 字符）
┌──────────────────────────────────────────────────┐
│ HEAD (70%)         │ [...truncated...] │ TAIL (20%) │
│ 前 13,986 字符     │    marker (21c)   │ 后 3,996 字符│
└──────────────────────────────────────────────────┘
→ 输出 ≤ 20,000 字符（perFileCap）
```

- **头部优先**：文件开头通常包含最重要的定义和结构
- **保留尾部**：最新的记忆条目通常在文件末尾
- **Marker 计入预算**：marker 长度从可用空间中扣除，确保输出不超限

### 总量控制

```
Layer 1 (Shared):  读入 → 截断至 perFileCap → 累加 totalChars
Layer 2 (Global):  读入 → 截断至 min(perFileCap, totalCap - totalChars) → 累加
Layer 3 (Group):   读入 → 截断至 min(perFileCap, totalCap - totalChars) → 累加
                   如果 remaining ≤ 0 → 跳过
```

### 容量估算

| 场景 | 预算使用 | 约合 Token |
|------|---------|-----------|
| 最小（空记忆） | ~500 字符 (Identity + Channel + Reply + Runtime) | ~150 |
| 典型（有 Persona + 部分记忆） | ~5,000-10,000 字符 | ~2,000-3,000 |
| 满载（所有文件达上限） | ~100,000 字符 | ~25,000-30,000 |

Claude 的上下文窗口为 200K tokens，即使满载也只占 ~15%，为对话历史留出充足空间。

---

## 16.6 与 Claude Code Preset 的关系

System prompt 通过 `append` 模式注入：

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: builtContent   // ← 我们构建的 8 sections
}
```

**不替换 Claude Code 的内置提示词。** Claude Code preset 提供：
- 文件操作工具指导（Read, Write, Edit, Glob, Grep）
- Bash 执行规范
- 代码安全最佳实践
- 工具使用约定

我们的内容是**追加**在其后的，提供 Bot 身份、频道适配、记忆上下文等业务层面的指导。

---

## 16.7 数据流时序

```
1. Control Plane (dispatcher.ts)
   │  构建 InvocationPayload，包含:
   │  - prompt: XML 格式的消息历史
   │  - systemPrompt: Bot.systemPrompt 字段
   │  - memoryPaths: { shared, botGlobal, group, persona, bootstrap, user }
   │
   ▼
2. AgentCore invocation → Agent Runtime (agent.ts)
   │
   ├─ syncFromS3(): 下载 session + 6 个 context 文件到 /workspace/
   │
   ├─ detectExistingSession(): 判断 isNewSession
   │
   ├─ buildSystemPrompt():
   │    ├─ loadPersonaFile()     → /workspace/persona/PERSONA.md
   │    ├─ loadBootstrapFile()   → /workspace/persona/BOOTSTRAP.md (if new)
   │    ├─ loadUserFile()        → /workspace/group/USER.md
   │    ├─ loadMemoryLayers()    → 3× CLAUDE.md with truncation
   │    └─ assemble 8 sections   → joined string
   │
   ├─ query({ prompt, systemPrompt: { preset: 'claude_code', append: built } })
   │    └─ Claude Agent SDK 执行...
   │
   └─ syncToS3(): 回写 session + group CLAUDE.md
```

---

## 16.8 API 与 Web Console

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/bots/:botId/persona` | PERSONA.md (Bot 身份+语气) |
| GET/PUT | `/bots/:botId/bootstrap` | BOOTSTRAP.md (新会话指令) |
| GET/PUT | `/bots/:botId/groups/:gid/user-context` | USER.md (关于用户) |
| GET/PUT | `/bots/:botId/memory` | Bot Global CLAUDE.md |
| GET/PUT | `/bots/:botId/groups/:gid/memory` | Group CLAUDE.md |
| GET/PUT | `/shared-memory` | User Shared CLAUDE.md |

### Web Console Memory Editor

6 个标签页，通过 `?tab=` 查询参数切换：

```
[Shared] [Persona] [Bootstrap] [Bot Memory] [Group Memory] [User Context]
```

- Bot 级标签（Persona, Bootstrap, Bot Memory）：在 `/bots/:botId/memory` 路径下显示
- Group 级标签（Group Memory, User Context）：在 `/bots/:botId/groups/:gid/memory` 路径下显示
- User 级标签（Shared）：在 `/memory` 路径下显示

---

## 16.9 关键文件

| 文件 | 职责 |
|------|------|
| `agent-runtime/src/system-prompt.ts` | 核心 builder：`buildSystemPrompt()` + 8 个 section 函数 |
| `agent-runtime/src/memory.ts` | Token 预算：`truncateContent()` + `loadMemoryLayers()` + context loaders |
| `agent-runtime/src/session.ts` | S3 同步：SyncPaths 包含 persona/bootstrap/user 下载 |
| `agent-runtime/src/agent.ts` | 入口：调用 builder，传递给 Claude SDK query() |
| `control-plane/src/routes/api/memory.ts` | REST API：6 种 context 文件的 GET/PUT |
| `shared/src/types.ts` | MemoryPaths 接口定义 |
