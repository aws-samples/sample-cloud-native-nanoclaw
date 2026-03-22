[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 8. Channel 管理

### 8.1 添加 Channel 流程

```
用户在 Web UI 点击 "添加 Telegram"
    │
    ▼
Web UI 显示表单: 填入 Bot Token
    │
    ▼
POST /api/bots/{bot_id}/channels
  { type: "telegram", credentials: { bot_token: "123:ABC" } }
    │
    ▼
Fargate Control Plane (HTTP API):
  ├── 1. 验证凭证有效性
  │      └── 调用 Telegram getMe API → 确认 Token 有效
  ├── 2. 存储凭证到 Secrets Manager
  │      └── clawbot/{bot_id}/telegram/{channel_id}
  ├── 3. 注册 Webhook
  │      └── 调用 Telegram setWebhook API
  │          url: https://api.clawbot.com/webhook/telegram/{bot_id}
  │          secret_token: {随机生成，存入 Secret}
  ├── 4. 写入 DynamoDB channels 表
  └── 5. 返回 Channel 状态
```

### 8.2 各 Channel 类型对比

| | Telegram | Discord | Slack | Feishu/Lark |
|---|---|---|---|---|
| 认证方式 | Bot Token | Bot Token + Public Key | Bot Token + Signing Secret | App ID + App Secret + Encrypt Key + Verification Token |
| 连接模式 | Webhook | Gateway (WebSocket) + Leader 选举 | Webhook (Events API) | **WebSocket 长连接 (Lark SDK WSClient) + Leader 选举** |
| 消息格式 | Update JSON | Interaction JSON | Event JSON | Event v2.0 JSON (im.message.receive_v1) |
| 签名验证 | secret_token header | Ed25519 签名 | HMAC-SHA256 | SDK 内部处理 (WebSocket 模式无需手动验证) |
| 群组支持 | 是 | 是 (Guild) | 是 (Channel) | 是 (群组 + 话题线程) |
| 回复方式 | sendMessage API | REST API | chat.postMessage | im.message.create / im.message.reply (卡片消息优先) |
| 域名支持 | — | — | — | 飞书 (feishu.cn) / Lark (larksuite.com) |
| 特殊能力 | — | Slash Commands、Rich Embeds | — | 卡片消息、Reaction 确认、MCP 文档/知识库/云盘工具 |
| 用户侧配置 | 只需 Bot Token | Token + 回调 URL 配置 | App 安装 + 权限 | 飞书开放平台创建自建应用 + 权限申请 |
| 接入难度 | 低 | 中 | 中 | 中 |

### 8.3 Webhook 签名验证

每种 Channel 的签名验证在 Fargate HTTP Server 内完成：

```typescript
// Telegram: 验证 X-Telegram-Bot-Api-Secret-Token header
function verifyTelegram(headers, secretToken): boolean {
  return headers['x-telegram-bot-api-secret-token'] === secretToken;
}

// Discord: 验证 Ed25519 签名
function verifyDiscord(headers, body, publicKey): boolean {
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  return nacl.sign.detached.verify(
    Buffer.from(timestamp + body),
    Buffer.from(signature, 'hex'),
    Buffer.from(publicKey, 'hex')
  );
}

// Slack: 验证 HMAC-SHA256
function verifySlack(headers, body, signingSecret): boolean {
  const timestamp = headers['x-slack-request-timestamp'];
  const sig = 'v0=' + hmacSha256(signingSecret, `v0:${timestamp}:${body}`);
  return timingSafeEqual(sig, headers['x-slack-signature']);
}
```

### 8.4 删除 Channel 流程

```
DELETE /api/bots/{bot_id}/channels/{channel_id}
    │
    ├── 1. 注销 Webhook (调用 Channel API)
    ├── 2. 删除 Secrets Manager 中的凭证
    ├── 3. 更新 DynamoDB channels 表 (标记 deleted)
    └── 4. 该 Channel 相关的 Groups 标记为 disconnected
```

### 8.5 Channel 凭证健康检查

用户的 Bot Token 可能被撤销、过期或泄露。平台需要主动检测并通知用户。

**检查机制：** Fargate Control Plane 内运行定时健康检查循环（每小时）。

```
健康检查循环 (每 60 分钟)
    │
    ├── 1. 扫描 DynamoDB channels 表
    │      条件: status = "connected" AND
    │            (last_health_check < 1 小时前 OR last_health_check 为空)
    │
    ├── 2. 对每个 Channel 调用验证 API
    │      ├── Telegram: getMe (验证 Bot Token)
    │      ├── Discord:  /users/@me (验证 Bot Token)
    │      ├── Slack:    auth.test (验证 Bot Token)
    │      └── Feishu:   /open-apis/bot/v3/info/ (验证 App ID + App Secret)
    │
    ├── 3. 更新 DynamoDB channels 表
    │      ├── 成功 → health_status="healthy", consecutive_failures=0
    │      └── 失败 → health_status="unhealthy", consecutive_failures++
    │
    └── 4. 如果 consecutive_failures >= 3 且 user_notified_at 为空
           ├── 通过 Channel 所属 Bot 的其他健康 Channel 通知用户
           │   "⚠️ Your Telegram Bot Token for bot 'xxx' is invalid.
           │    Please update it at https://app.clawbot.com/bots/{bot_id}/channels"
           ├── 如果无其他健康 Channel → 发邮件 (通过 SES)
           └── 更新 user_notified_at，避免重复通知
```

**Webhook 触发时的实时检测：**

```
Webhook 收到消息 → 调 Channel API 回复 → 失败 (401/403)
    │
    ├── 更新 health_status = "unhealthy"
    ├── 记录 health_error
    └── 如果是首次失败 → 立即触发一次完整健康检查
```

**Channel 验证 API 参考：**

```typescript
const healthCheckers: Record<string, (creds: any) => Promise<boolean>> = {
  telegram: async (creds) => {
    const res = await fetch(`https://api.telegram.org/bot${creds.bot_token}/getMe`);
    return res.ok;
  },
  discord: async (creds) => {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${creds.bot_token}` },
    });
    return res.ok;
  },
  slack: async (creds) => {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${creds.bot_token}` },
    });
    const data = await res.json();
    return data.ok === true;
  },
  feishu: async (creds) => {
    // 先获取 tenant_access_token，再调用 bot info API
    const domain = creds.domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
    const tokenRes = await fetch(`https://${domain}/open-apis/auth/v3/tenant_access_token/internal/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    });
    const { tenant_access_token } = await tokenRes.json();
    const res = await fetch(`https://${domain}/open-apis/bot/v3/info/`, {
      headers: { Authorization: `Bearer ${tenant_access_token}` },
    });
    return res.ok;
  },
};
```

**凭证更新流程（用户在 Web UI 操作）：**

```
用户在 Web UI 更新 Token
    │
    ▼
PUT /api/bots/{bot_id}/channels/{ch_id}
  { credentials: { bot_token: "new-token-xxx" } }
    │
    ├── 1. 验证新 Token 有效性
    ├── 2. 更新 Secrets Manager
    ├── 3. 重新注册 Webhook (使用新 Token)
    ├── 4. 重置健康检查状态
    │      health_status="healthy", consecutive_failures=0,
    │      user_notified_at=null
    └── 5. 刷新 Fargate 内存缓存 (凭证缓存 TTL 到期自动刷新)
```

### 8.6 Discord Gateway 与 Leader 选举

Discord 使用 Gateway (WebSocket) 持久连接接收消息，而非 Webhook。多 Fargate Task 场景需要确保只有一个实例连接 Gateway。

```
Leader 选举机制 (DynamoDB 分布式锁)
─────────────────────────────────────
锁表:   sessions (复用, PK=__system__, SK=discord-gateway-leader)
锁 TTL: 60 秒
续约:   每 30 秒
Standby 轮询: 每 30 秒检查锁是否过期

流程:
  Task-1 启动 → tryAcquireLock() → 成功 → becomeLeader()
  Task-2 启动 → tryAcquireLock() → 失败 → startStandbyPoll()
  Task-1 崩溃 → 60s 后锁过期 → Task-2 检测到 → 接管 Leader

Leader 职责:
  ├── 扫描 channels 表发现所有 Discord channels
  ├── 从 Secrets Manager 加载 bot tokens
  ├── discord.js Client.login(token)
  ├── 监听 MessageCreate → handleMessage() → SQS 入队
  ├── 监听 InteractionCreate → handleSlashCommand()
  ├── 自动注册 guild slash commands (Ready 事件)
  └── 管理 typing 指示器 (每 9s 发送直到回复完成)
```

### 8.7 飞书 (Feishu/Lark) 渠道

飞书使用 Lark SDK 的 `WSClient` WebSocket 长连接接收消息，与 Discord Gateway 采用相同的 Leader 选举机制。用户无需配置回调 URL。

#### 8.7.1 凭证与配置

```typescript
// Secrets Manager: nanoclawbot/{stage}/{botId}/feishu
interface FeishuCredentials {
  appId: string;              // 飞书应用 App ID
  appSecret: string;          // 飞书应用 App Secret
  encryptKey: string;         // 事件加密密钥
  verificationToken: string;  // 事件验证令牌
  botOpenId?: string;         // 机器人 open_id (验证后自动填入)
  botName?: string;           // 机器人名称
  domain: 'feishu' | 'lark';  // feishu.cn (中国区) 或 larksuite.com (国际版)
}
```

#### 8.7.2 WebSocket Gateway + Leader 选举

飞书 Gateway 与 Discord Gateway 共享同一个 DynamoDB Leader 选举机制，Leader Task 同时持有两个 Gateway 连接：

```
Leader 选举机制 (DynamoDB 分布式锁)
─────────────────────────────────────
锁表:   sessions (PK=__system__, SK=feishu-gateway-leader)
锁 TTL: 30 秒
续约:   每 15 秒
Standby 轮询: 每 15 秒检查锁是否过期

Leader Task:
  ├── Discord Gateway (discord.js Client) — 已有
  ├── Feishu Gateway (Lark WSClient)      — 每个飞书 Bot 一个连接
  └── DynamoDB 锁续约 (每 15s)

Standby Tasks:
  └── 每 15s 轮询锁，Leader 崩溃 → 30s 内接管
```

**FeishuGatewayManager 生命周期：**

```
becomeLeader()
    │
    ├── 1. 扫描 channels 表发现所有 channelType='feishu' 的记录
    ├── 2. 按 botId 分组，从 Secrets Manager 加载凭证
    ├── 3. 为每个 Bot 创建 WSClient → 注册 im.message.receive_v1 事件
    └── 4. WSClient 自动保活和断线重连 (SDK 内部处理)

动态管理:
    ├── addBot(botId)    → 新 Channel 创建时热加载 WSClient
    └── removeBot(botId) → Channel 删除时移除连接
```

#### 8.7.3 消息流 — 入站

```
飞书用户发送消息
    │
    ▼
Lark WSClient (Leader Task) 收到 im.message.receive_v1
    │
    ▼
FeishuGatewayManager → handleFeishuMessage():
    │
    ├── 1. 过滤 Bot 自身消息 (sender open_id == botOpenId)
    │
    ├── 2. 解析消息内容
    │      ├── text: 提取纯文本，剥离 @bot 提及标记
    │      ├── post (富文本): 提取 title + content 数组
    │      ├── image/file: 提取 file_key，通过 REST API 下载
    │      └── audio: 记录 "[Voice message — not yet supported]"
    │
    ├── 3. 触发判断
    │      ├── 私聊 (p2p): 始终触发
    │      └── 群聊 (group): @bot 提及 OR 有附件 OR triggerPattern 匹配
    │
    ├── 4. Reaction 确认
    │      └── 给用户消息添加 "OnIt" reaction (fire-and-forget)
    │
    ├── 5. 附件处理
    │      ├── 通过 im.message.resources API 下载图片/文件
    │      └── 上传到 S3: {userId}/{botId}/attachments/{messageId}/{filename}
    │
    ├── 6. 群组管理
    │      ├── groupJid = feishu#{chat_id}
    │      ├── 配额检查 + 自动创建 Group (DynamoDB)
    │      └── 群聊上下文：注入 group_name, member_count, recent participants
    │
    ├── 7. 存储 Message (DynamoDB, TTL 90 天)
    │
    └── 8. 入队 SQS FIFO
           ├── MessageGroupId: {botId}#feishu#{chat_id}
           ├── MessageDeduplicationId: {message_id}
           └── replyContext: { feishuChatId, feishuMessageId }
```

#### 8.7.4 消息流 — 出站 (Agent 回复)

```
Agent MCP send_message() → SQS Reply Queue
    │
    ▼
Reply Consumer → AdapterRegistry.get("feishu")
    │
    ▼
FeishuAdapter.sendReply(ctx, text):
    │
    ├── 1. 加载飞书凭证 (Secrets Manager, 内存缓存)
    │
    ├── 2. 移除 "OnIt" reaction
    │      └── 列出该消息的 OnIt reactions → 逐个删除 (best-effort)
    │
    ├── 3. 文本分块 (单块上限 4000 字符)
    │      ├── Markdown 感知分割 — 不在代码块中间截断
    │      ├── 优先在换行符处分割，其次空格，最后硬截断
    │      └── 检测 ``` 计数确保代码块完整
    │
    ├── 4. 发送第一块 (回复模式)
    │      ├── 优先: im.message.reply (关联原消息)
    │      └── 回退: im.message.create (新消息)
    │
    ├── 5. 发送后续块 (新消息模式)
    │
    └── 6. 消息格式
           ├── 优先: 卡片消息 (Interactive Card, schema 2.0)
           │   └── Markdown 内容包装在 card template: header + markdown body
           └── 回退: 纯文本消息 (如卡片发送失败)
```

#### 8.7.5 飞书 MCP 工具 (Agent Runtime)

飞书 Channel 连接后，Agent 自动获得飞书文档生态的 MCP 工具能力。工具按 Bot 配置启用，凭证通过 SQS Payload → 环境变量传递到 Agent Runtime。

```
agent-runtime/src/feishu-tools/
├── index.ts          # 工具注册入口 (按 enabledTools 配置条件注册)
├── client.ts         # Lark Client 管理 (按 appId 缓存)
├── doc-tool.ts       # feishu_doc — 文档 CRUD
├── wiki-tool.ts      # feishu_wiki — 知识库导航
├── drive-tool.ts     # feishu_drive — 云盘操作
└── perm-tool.ts      # feishu_perm — 权限管理 (默认禁用)
```

| 工具 | 说明 | 主要操作 | 默认 |
|------|------|---------|------|
| `feishu_doc` | 文档 CRUD | read, write, append, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells | 启用 |
| `feishu_wiki` | 知识库导航 | spaces, nodes, get, create, move, rename | 启用 |
| `feishu_drive` | 云盘操作 | list, info, create_folder, move, delete | 禁用 |
| `feishu_perm` | 权限管理 | list, add, remove (敏感操作) | 禁用 |

**凭证传递链路：**

```
Control Plane SQS Consumer
    │
    ├── 检测 channelType == 'feishu'
    ├── 从 Secrets Manager 加载飞书凭证
    └── 注入 Agent 环境变量:
        FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_DOMAIN
        FEISHU_TOOLS_DOC=1, FEISHU_TOOLS_WIKI=1, ...
    │
    ▼
Agent Runtime 启动
    ├── 检测 FEISHU_APP_ID 环境变量存在
    ├── 创建 Lark Client
    └── 按配置注册 MCP 工具
```

**典型工作流示例：**

```
用户: "帮我看一下这个文档的内容 https://xxx.feishu.cn/docx/ABC123"
    ↓
Agent 调用 feishu_doc(action="read", document_id="ABC123")
    ↓
Agent 理解内容，生成修改建议
    ↓
Agent 调用 feishu_doc(action="append", document_id="ABC123", content="## 修改建议\n...")
    ↓
Agent 回复用户: "已将修改建议追加到文档末尾"
```

### 8.8 多媒体消息处理

Telegram/Discord/Slack/WhatsApp 消息可能包含图片、文件、语音、视频。当前核心流程只处理文本，多媒体需要额外的处理链路。

#### 处理链路

```
频道 Webhook (含附件)
    │
    ▼
Fargate HTTP Server (Webhook 处理)
    │
    ├── 1. 解析消息, 检测附件
    │      ├── Telegram: file_id → getFile API → 下载 URL
    │      ├── Discord:  attachments[].url → 直接下载
    │      ├── Slack:    files[].url_private → 需 Bot Token 下载
    │      └── WhatsApp:  media_id → media URL API → 下载 URL
    │
    ├── 2. 下载附件到临时内存
    │      大小限制: 单文件 ≤ 20MB, 单消息附件总计 ≤ 50MB
    │      超限 → 忽略附件, 仅处理文本 + 通知 "附件过大"
    │
    ├── 3. 上传到 S3
    │      路径: {userId}/{botId}/attachments/{messageId}/{filename}
    │      使用 Scoped S3 client (Control Plane 的 Task Role)
    │
    ├── 4. 写入 DynamoDB messages 表
    │      附加字段: attachments (JSON array)
    │      [{ type, s3Key, fileName, mimeType, size }]
    │
    └── 5. 入队 SQS (payload 包含 attachments 元数据)
```

#### Agent 内处理

```
Agent Runner 收到 InvocationPayload (含 attachments)
    │
    ├── 下载附件到 /workspace/group/attachments/
    │   (使用 Scoped S3 client, ABAC 限定路径)
    │
    ├── 根据类型处理:
    │
    │   图片 (image/jpeg, image/png, image/webp):
    │   ├── Claude Agent SDK 原生支持多模态
    │   └── 在 prompt 中引用: "用户发送了图片，见 /workspace/group/attachments/photo.jpg"
    │       SDK 的 Read 工具可读取图片文件，Claude 视觉能力处理
    │
    │   语音 (audio/ogg, audio/mpeg):
    │   ├── Agent 通过 Bash 调用 whisper 转文字 (如果容器内安装了 whisper)
    │   └── 或在 Webhook 层预处理: 使用 Amazon Transcribe → 文本
    │       文本追加到消息 content 中, Agent 无需感知语音
    │
    │   文档 (application/pdf, text/*, office):
    │   ├── Agent 通过 Bash 调用 pdftotext (PDF)
    │   ├── 或直接 Read 工具读取文本文件
    │   └── Claude 可直接处理 PDF (多模态)
    │
    │   视频 (video/mp4):
    │   └── 暂不处理视频内容, 仅记录元数据
    │       通知用户 "视频暂不支持分析"
    │
    └── Agent 生成回复 (可能引用附件内容)
```

#### 语音预处理 (推荐: Webhook 层处理)

避免在 Agent 容器内安装 Whisper（增加镜像大小），用 Amazon Transcribe 在 Webhook 层预处理：

```typescript
// Webhook 处理语音消息
if (attachment.type === 'voice') {
  // 上传到 S3 (Transcribe 需要 S3 输入)
  await s3.putObject({ Bucket, Key: s3Key, Body: audioBuffer });

  // 启动转录
  const job = await transcribe.startTranscriptionJob({
    TranscriptionJobName: `clawbot-${messageId}`,
    LanguageCode: 'zh-CN',  // 或 auto-detect
    Media: { MediaFileUri: `s3://${Bucket}/${s3Key}` },
    OutputBucketName: Bucket,
    OutputKey: `${s3Key}.transcript.json`,
  });

  // 等待完成 (通常 < 30s 对于短语音)
  // 或: 异步处理, 转录完成后再入队 SQS

  // 将转录文本追加到消息 content
  message.content += `\n[语音转文字]: ${transcriptText}`;
}
```

#### DynamoDB messages 表扩展

```
PK: bot_id#group_jid    SK: timestamp
─────────────────────────────────────
...(原有字段)...

# 多媒体扩展
attachments (JSON, 可选): [
  {
    "type": "image",
    "s3Key": "u-123/b-456/attachments/msg-789/photo.jpg",
    "fileName": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 245678
  },
  {
    "type": "voice",
    "s3Key": "u-123/b-456/attachments/msg-789/voice.ogg",
    "fileName": "voice.ogg",
    "mimeType": "audio/ogg",
    "size": 34567,
    "transcript": "你好，帮我查一下明天的会议安排"   # 语音转文字结果
  }
]
```

#### 容器镜像扩展 (可选)

如果需要在 Agent 容器内直接处理多媒体：

```dockerfile
# 在 Dockerfile 中添加 (按需)
RUN apt-get install -y \
    poppler-utils    # pdftotext (PDF 转文本)
    # ffmpeg         # 音视频处理 (如需本地转码)
    # 不安装 whisper, 语音转文字由 Amazon Transcribe 处理
```
