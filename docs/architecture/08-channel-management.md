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

| | Telegram | Discord | Slack | WhatsApp |
|---|---|---|---|---|
| 认证方式 | Bot Token | Bot Token + Public Key | Bot Token + Signing Secret | Access Token + App Secret |
| Webhook 注册 | setWebhook API | Application Portal 或 API | Events API URL | Meta Business API |
| 消息格式 | Update JSON | Interaction JSON | Event JSON | Webhook JSON |
| 签名验证 | secret_token header | Ed25519 签名 | HMAC-SHA256 | HMAC-SHA256 |
| 群组支持 | 是 | 是 (Guild) | 是 (Channel) | 是 |
| 回复方式 | sendMessage API | 直接响应 / REST API | chat.postMessage | messages API |
| 用户侧配置 | 只需 Bot Token | Token + 回调 URL 配置 | App 安装 + 权限 | Meta 开发者账号 |
| 接入难度 | 低 | 中 | 中 | 高 |

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
    │      └── WhatsApp:  /{phone_number_id} (验证 Access Token)
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
  whatsapp: async (creds) => {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${creds.phone_number_id}`,
      { headers: { Authorization: `Bearer ${creds.access_token}` } },
    );
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

### 8.6 多媒体消息处理

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
