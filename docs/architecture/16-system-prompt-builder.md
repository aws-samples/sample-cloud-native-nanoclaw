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
│   ├── CLAUDE.md                 ← User 级：跨 Bot 共享记忆 (read-only)
│   └── USER.md                   ← User 级：关于人类用户 (read-write by Agent)
└── {botId}/
    ├── IDENTITY.md               ← Bot 级：身份定义 (read-write by Agent)
    ├── SOUL.md                   ← Bot 级：价值观和行为准则 (read-write by Agent)
    ├── BOOTSTRAP.md              ← Bot 级：首次引导 (Agent 完成后删除)
    └── memory/
        ├── global/
        │   └── CLAUDE.md         ← Bot 级：运营手册 (read-write by Agent)
        └── {groupJid}/
            └── CLAUDE.md         ← Group 级：对话记忆 (read-write)
```

| 文件 | 层级 | 读写 | 用途 | 类比 OpenClaw |
|------|------|------|------|--------------|
| `USER.md` | User | 读写 | 关于人类用户（跨 Bot 共享） | USER.md |
| `IDENTITY.md` | Bot | 读写 | 身份定义（名字、角色、性格） | IDENTITY.md |
| `SOUL.md` | Bot | 读写 | 价值观和行为准则 | SOUL.md |
| `BOOTSTRAP.md` | Bot | 读写 | 首次对话引导（Agent 完成后自行删除） | BOOTSTRAP.md |
| `CLAUDE.md` (shared) | User | 只读 | 跨 Bot 共享知识 | — |
| `CLAUDE.md` (global) | Bot | 读写 | Bot 运营手册（规则、记忆管理、自改进、反循环） | MEMORY.md |
| `CLAUDE.md` (group) | Group | 读写 | 对话级记忆，Agent 可自主更新 | memory/*.md |

### 默认模板与 Agent 自主引导

默认模板文件打包在 Agent Runtime Docker 镜像中（`/app/templates/`）：

```
agent-runtime/templates/
├── BOT_CLAUDE.md        — Bot 运营手册（→ /workspace/global/CLAUDE.md）
├── BOOTSTRAP.md         — 首次对话引导脚本（灵感来自 OpenClaw）
├── CODING_REFERENCE.md  — 编码参考指南（→ /workspace/reference/）
├── IDENTITY.md          — 身份模板（空白字段）
├── SOUL.md              — 价值观模板
├── system-prompt-base.md — 基础系统提示词模板
└── USER.md              — 用户档案模板
```

**BOT_CLAUDE.md** 是 Bot 的运营手册，首次运行时复制到 `/workspace/global/CLAUDE.md`。包含：
- 每次会话的开场检查清单
- 记忆管理规则（何时写入、写到哪里）
- 自我改进流程（学习日志、错误记录、能力请求）
- 群聊行为（何时发言、何时沉默）
- 反循环规则（Bot-to-Bot 对话限制）
- 安全边界（内部 vs 外部操作）

Agent 可以读写此文件——随着使用积累，Bot 会添加自己的规则和笔记。

**首次运行流程：**

```
1. syncFromS3()           → S3 无文件，workspace 为空
2. 检查 IDENTITY.md       → 不存在 → 复制 BOOTSTRAP.md, IDENTITY.md, SOUL.md 模板
3. 检查 USER.md           → 不存在 → 复制 USER.md 模板
4. 检查 global/CLAUDE.md  → 不存在 → 复制 BOT_CLAUDE.md → /workspace/global/CLAUDE.md
5. 复制 CODING_REFERENCE.md → /workspace/reference/ (每次运行)
6. buildSystemPrompt()    → BOOTSTRAP.md 注入 system prompt
7. Agent 与用户对话        → 共同定义身份、价值观、用户信息
8. Agent 用 Write 工具     → 更新 IDENTITY.md, SOUL.md, USER.md
9. Agent 用 Bash rm       → 删除 BOOTSTRAP.md
10. syncToS3()            → 上传修改的文件，删除 BOOTSTRAP.md 的 S3 key
```

**后续运行：** S3 已有 IDENTITY.md + global/CLAUDE.md → syncFromS3 下载 → 模板检查跳过 → Agent 正常工作。

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
    │    Base Template + 9 Dynamic Sections         │
    │                                               │
    │  [Base Template] ← system-prompt-base.md      │
    │     Role, Tools, Tool Call Style,             │
    │     Context Files, Communication Style        │
    │  1. Identity      ← botName                   │
    │  2. About You     ← IDENTITY.md / systemPrompt│
    │  3. Your Soul     ← SOUL.md                   │
    │  4. Bootstrap     ← BOOTSTRAP.md (new only)   │
    │  5. Channel       ← channelType               │
    │  6. Reply Guide   ← isScheduledTask           │
    │  7. User Context  ← USER.md (user-level)      │
    │  8. Memory        ← 3× CLAUDE.md (budgeted)   │
    │     Shared + Bot Global (operating manual)    │
    │     + Group                                   │
    │  9. Runtime       ← metadata line (+ model)   │
    └──────────────────────────────────────────────┘
                              │
                              ▼
              Direct mode (string systemPrompt)
              ─────────────────────────────────
              Base template + sections joined by ---
```

---

## 16.4 Section 详解

### Base Template (`system-prompt-base.md`)

从 `/app/templates/system-prompt-base.md` 加载的静态模板，包含 5 个子节：

| 子节 | 内容 |
|------|------|
| **Role** | "You are a conversational AI assistant running inside a messaging channel" — 覆盖 Claude Code 默认的代码编辑器定位 |
| **Tools** | 列出可用工具（Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch）及使用偏好 |
| **Tool Call Style** | 默认静默调用，仅在复杂/敏感操作时叙述 |
| **Context Files** | 列出所有 workspace 文件路径（identity, soul, bootstrap, user, global CLAUDE.md, group CLAUDE.md, learnings, reference） |
| **Communication Style** | 对话风格指导：自然、简洁、匹配用户语言、有个性 |

> 之前的 "Section 0: Role Override" 已合并到此基础模板中，不再作为独立的动态 section。

### Section 1: Identity

```
# Identity
You are {botName}, a personal AI assistant.
```

始终存在。为 Agent 建立基本身份。

### Section 2: Identity Context

```
# About You
{IDENTITY.md 内容}
```

**优先级：** IDENTITY.md > Bot.systemPrompt > 跳过

IDENTITY.md 定义 Agent 的身份：名字、角色、性格、专长。由 Agent 在首次对话中通过 BOOTSTRAP 流程自主创建。当 IDENTITY.md 不存在时，回退到 Bot 记录中的 `systemPrompt` 字段。

### Section 3: Soul

```
# Your Soul
Embody this persona and tone. Avoid stiff, generic replies; follow its guidance naturally:

{SOUL.md 内容}
```

借鉴 OpenClaw 的措辞："embody its persona and tone"。SOUL.md 定义 Agent 的价值观、沟通风格、边界。如不存在则跳过。

### Section 4: Bootstrap

```
# First Session Instructions
This is a new conversation. Follow these initial instructions:

{BOOTSTRAP.md 内容}
```

**仅在新会话时注入。** 通过 `detectExistingSession()` 判断：
- 无已有 session → `isNewSession = true` → 注入
- 有 session ID（续接对话） → `isNewSession = false` → 跳过

典型用途：首次交互时自我介绍、询问用户需求、建立对话基调。

### Section 5: Channel Guidance

根据 `channelType` 注入对应的格式指导：

| Channel | 关键指导 |
|---------|---------|
| **Discord** | 标准 Markdown、2000 字符 content / 4096 embed、`<@userId>` mention 格式 |
| **Telegram** | MarkdownV2（需转义特殊字符 `_ * [ ] ( ) ~ > # + - = \| { } . !`）、4096 字符限制 |
| **Slack** | mrkdwn（非标准 Markdown）、`*bold*` 单星号、`<url\|text>` 链接格式 |
| **WhatsApp** | 简单格式化、对话式简洁回复 |

这确保 Agent 生成的回复在目标平台上正确渲染。

### Section 6: Reply Guidelines

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

### Section 7: User Context

```
# About Your Users
{USER.md 内容}
```

User 级别的文件（`{userId}/shared/USER.md`），描述人类用户本人。跨 Bot 共享。仅在 `USER.md` 存在时注入。

### Section 8: Memory

```
# Shared Memory
{shared/CLAUDE.md}          ← User 级跨 Bot 共享记忆

---

# Bot Memory
{global/CLAUDE.md}          ← Bot 运营手册 (BOT_CLAUDE.md 模板)
                               包含：会话规则、记忆管理、自我改进、
                               群聊行为、反循环规则、安全边界
                               Agent 可读写，随使用积累自定义规则

---

# Group Memory
{group/CLAUDE.md}           ← 对话级记忆
```

三层记忆按层级加载，每层受 token 预算约束（见 §16.5）。

> **重构说明：** 之前的反循环规则（原 Section 6.5）和自我改进规则（原 SELF_IMPROVEMENT.md 模板）
> 已统一移入 BOT_CLAUDE.md，作为 Bot 运营手册的一部分注入 Memory 层。这使得这些规则：
> 1. 可被 Agent 自主修改和扩展
> 2. 与 Bot 的其他运营规则集中管理
> 3. 无需修改代码即可调整

### Section 9: Runtime Metadata

```
Runtime: bot=01KKRN... | name=MyBot | channel=discord | group=dc:1234567 | model=claude-sonnet-4-20250514
```

单行元数据，用于调试和 Agent 自我感知。包含当前模型 ID（如有）。

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

System prompt 使用 **direct 模式**（纯字符串），不再使用 preset append：

```typescript
systemPrompt: builtContent   // ← base template + 9 dynamic sections
```

基础模板 (`system-prompt-base.md`) 直接定义了 Role 和工具使用指导，替代了之前依赖 Claude Code preset 的方式。这使得 system prompt 完全自包含，便于调试和定制。

---

## 16.7 数据流时序

```
1. Control Plane (dispatcher.ts)
   │  构建 InvocationPayload，包含:
   │  - prompt: XML 格式的消息历史
   │  - systemPrompt: Bot.systemPrompt 字段
   │  - memoryPaths: { shared, botGlobal, group, identity, soul, bootstrap, user }
   │
   ▼
2. AgentCore invocation → Agent Runtime (agent.ts)
   │
   ├─ syncFromS3(): 下载 session + context 文件到 /workspace/
   │
   ├─ 模板检查: IDENTITY.md 不存在? → 复制 BOOTSTRAP.md, IDENTITY.md, SOUL.md
   │            USER.md 不存在? → 复制 USER.md
   │            global/CLAUDE.md 不存在? → 复制 BOT_CLAUDE.md (运营手册)
   │            总是复制 CODING_REFERENCE.md → /workspace/reference/
   │
   ├─ detectExistingSession(): 判断 isNewSession
   │
   ├─ buildSystemPrompt():
   │    ├─ loadBaseTemplate()    → /app/templates/system-prompt-base.md
   │    ├─ loadIdentityFile()    → /workspace/identity/IDENTITY.md
   │    ├─ loadSoulFile()        → /workspace/identity/SOUL.md
   │    ├─ loadBootstrapFile()   → /workspace/identity/BOOTSTRAP.md (if new)
   │    ├─ loadUserFile()        → /workspace/shared/USER.md
   │    ├─ loadMemoryLayers()    → 3× CLAUDE.md with truncation
   │    └─ assemble base + 9 sections → joined string
   │
   ├─ query({ prompt, systemPrompt: built })  ← direct mode
   │    └─ Claude Agent SDK 执行...
   │    └─ Agent 可用 Write/Edit 修改 IDENTITY.md, SOUL.md, USER.md, global/CLAUDE.md
   │    └─ Agent 可用 Bash rm 删除 BOOTSTRAP.md
   │
   └─ syncToS3():
        ├─ 回写 session + group CLAUDE.md
        ├─ 上传 IDENTITY.md, SOUL.md, USER.md, global/CLAUDE.md (如存在)
        └─ 删除 BOOTSTRAP.md 的 S3 key (如已被 Agent 删除)
```

---

## 16.8 API 与 Web Console

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/bots/:botId/identity` | IDENTITY.md (Bot 身份) |
| GET/PUT | `/bots/:botId/soul` | SOUL.md (Bot 价值观) |
| GET/PUT | `/bots/:botId/bootstrap` | BOOTSTRAP.md (新会话指令) |
| GET/PUT | `/user-profile` | USER.md (用户档案，跨 Bot 共享) |
| GET/PUT | `/bots/:botId/memory` | Bot Global CLAUDE.md |
| GET/PUT | `/bots/:botId/groups/:gid/memory` | Group CLAUDE.md |
| GET/PUT | `/shared-memory` | User Shared CLAUDE.md |

### Web Console Memory Editor

6 个标签页，通过 `?tab=` 查询参数切换：

```
[Shared] [User Profile] [Identity] [Soul] [Bootstrap] [Bot Memory] [Group Memory]
```

- User 级标签（Shared, User Profile）：在 `/memory` 路径下显示
- Bot 级标签（Identity, Soul, Bootstrap, Bot Memory）：在 `/bots/:botId/memory` 路径下显示
- Group 级标签（Group Memory）：在 `/bots/:botId/groups/:gid/memory` 路径下显示

---

## 16.9 关键文件

| 文件 | 职责 |
|------|------|
| `agent-runtime/src/system-prompt.ts` | 核心 builder：`buildSystemPrompt()` + 9 个 section 函数 |
| `agent-runtime/src/memory.ts` | Token 预算：`truncateContent()` + `loadMemoryLayers()` + context loaders |
| `agent-runtime/src/session.ts` | S3 同步：SyncPaths 包含 persona/bootstrap/user/global 下载 |
| `agent-runtime/src/agent.ts` | 入口：模板复制、调用 builder，传递给 Claude SDK query() |
| `agent-runtime/templates/system-prompt-base.md` | 基础模板：Role, Tools, Tool Call Style, Context Files, Communication Style |
| `agent-runtime/templates/BOT_CLAUDE.md` | Bot 运营手册模板：会话规则、记忆管理、自改进、群聊、反循环、安全 |
| `control-plane/src/routes/api/memory.ts` | REST API：6 种 context 文件的 GET/PUT |
| `shared/src/types.ts` | MemoryPaths 接口定义 |
