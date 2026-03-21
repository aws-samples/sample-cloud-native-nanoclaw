# NanoClaw on Cloud 架构设计文档

> 基于 NanoClaw 架构，面向多用户的 AWS 云原生 AI 助手平台

---

## 目录

1. [产品定位](#1-产品定位)
2. [核心架构决策](#2-核心架构决策)
3. [系统全景图](#3-系统全景图)
4. [分层架构详解](./architecture/04-layered-architecture.md) — Web 控制台、Fargate Service、Webhook、SQS Consumer
5. [数据模型](./architecture/05-data-model.md) — DynamoDB 表设计、S3 存储结构、Secrets Manager
6. [消息生命周期](./architecture/06-07-lifecycles.md) — 从 Webhook 到 Agent 回复的完整流程
7. [Bot 生命周期](./architecture/06-07-lifecycles.md#7-bot-生命周期) — 创建、激活、暂停、删除
8. [Channel 管理](./architecture/08-channel-management.md) — 添加/删除 Channel、签名验证、健康检查、多媒体处理
9. [Agent 执行层](./architecture/09-10-agent-runtime.md) — AgentCore Runtime、容器架构、MCP 工具、S3 同步、ABAC 隔离
10. [任务调度](./architecture/09-10-agent-runtime.md#10-任务调度) — EventBridge Scheduler 集成
11. [安全架构](./architecture/11-12-security-observability.md) — 6 层安全模型、租户隔离、凭证安全、Credential Proxy、配额限流
12. [可观测性](./architecture/11-12-security-observability.md#12-可观测性) — 监控指标、日志结构
13. [成本模型](#13-成本模型)
14. [NanoClaw → ClawBot Cloud 映射](#14-nanoclaw--clawbot-cloud-映射)
15. [CDK 部署架构](./architecture/15-cdk-deployment.md) — 6 个 Stack、DynamoDB/Cognito/ECS/ALB/CloudFront 定义、部署流程
16. [System Prompt & Native Memory](./architecture/16-system-prompt-builder.md) — Claude Code 原生 CLAUDE.md、Preset Append 模式、三层记忆架构

---

## 1. 产品定位

NanoClaw on Cloud 是使用Claude Agent SDK开发的基于AWS Serverless 云原生的多用户"小龙虾"平台（参考了NanoClaw 和 OpenClaw项目的设计）。用户通过 Web 控制台创建自己的NanoBot，配置消息频道（Telegram、Discord、Slack 等），NanoBot 在云端mircoVM沙盒隔离环境中运行 Claude Agent，提供支持SKILL扩展，浏览器等扩展能力，通过mircoVM沙盒赋予"小龙虾", 虚拟机级别安全隔离的，秒级冷启，Serverless的企业级云原生解决方案。并通过控制平面，实现小龙虾们**在企业层面，可控管，可观测，数据可见**，是企业级“小龙虾应用”推荐方案。

**核心用户场景：**

```
1. 用户注册 → 登录 Web 控制台
2. 创建一个 NanoBot（如 "工作助手"）
3. 配置 Slack 频道（填入自己的 Bot Token）
4. 平台自动注册 Webhook，Bot 上线
5. 用户在 Slack 群里 @Bot，Bot 通过 Claude Agent 回复
6. 用户可创建多个 Bot（如 "生活助手"、"代码审查 Bot"）
7. 每个 Bot 有独立记忆、独立频道、独立对话历史
```

---

## 2. 核心架构决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 租户模型 | 一用户多 Bot | 用户可按场景创建不同助手 |
| Channel 凭证 | 用户自带 (BYOK) | 灵活、无平台单点、用户完全控制 |
| Control Plane | ECS Fargate Service (常驻) | 无超时限制、内存缓存、HTTP + SQS Consumer + Reply Consumer 合一 |
| Webhook 路由 | 统一入口 + ALB 路径路由 | 一个 ALB 搞定，Fargate 直接处理 |
| 频道适配 | Channel Adapter 抽象层 | 统一接口、Adapter Registry、Discord Gateway + 选举 |
| Agent 运行时 | AgentCore Runtime | 自动扩缩、按 CPU 计费、microVM 隔离 |
| Agent SDK | Claude Agent SDK + `CLAUDE_CODE_USE_BEDROCK=1` | 保留全套 claude-code 工具，Bedrock 原生调用 |
| 消息队列 | SQS FIFO + MessageGroupId | 保证 per-group 有序，跨 group 并行 |
| 数据库 | DynamoDB | 无服务器、按需扩缩、毫秒级延迟 |
| 文件存储 | S3 | Session 文件、群组记忆、对话归档 |
| 用户认证 | Cognito User Pool | 托管认证、支持 OAuth/OIDC |
| 定时任务 | EventBridge Scheduler | 原生 cron、精确到秒、无需自建调度器 |

---

## 3. 系统全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户终端                                 │
│  Telegram / Discord / Slack / WhatsApp ←──── 频道消息收发         │
│  Web 浏览器 ←──── 控制台管理                                     │
└───────┬─────────────────────────────────────────┬───────────────┘
        │                                         │
        │ HTTPS                                   │ Webhook
        ▼                                         ▼
┌──────────────┐                        ┌─────────────────────┐
│  CloudFront  │                        │  ALB               │
│  + S3 (SPA)  │                        │  (Application      │
│  Web 控制台   │                        │   Load Balancer)   │
└──────┬───────┘                        │  /api/*   → 控制面  │
       │                                │  /webhook/* → 消息  │
       │ API 调用                        └────────┬────────────┘
       │                                         │
       ▼                                         │
┌──────────────────────────────────────────────────────────────┐
│         ECS Fargate Service (常驻, Control Plane)             │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │  HTTP Server (Fastify)                            │       │
│  │  ├── /api/*       → REST API (Bot/Channel/Memory) │       │
│  │  ├── /api/admin/* → 管理员 API (用户/配额管理)      │       │
│  │  ├── /webhook/*   → Webhook 接收 + 签名验证        │       │
│  │  └── /health      → ALB 健康检查                   │       │
│  ├──────────────────────────────────────────────────┤       │
│  │  SQS Inbound Consumer (后台线程, 长轮询)            │       │
│  │  ├── 消费消息 → 配额检查 → 并发控制                  │       │
│  │  ├── InvokeAgentRuntime (无超时限制)                │       │
│  │  └── 回复 → Channel Adapter → 频道 API             │       │
│  ├──────────────────────────────────────────────────┤       │
│  │  SQS Reply Consumer (后台线程)                      │       │
│  │  ├── 消费 Agent 中间回复 (send_message 工具)        │       │
│  │  └── 路由 → Channel Adapter → 频道 API             │       │
│  ├──────────────────────────────────────────────────┤       │
│  │  Channel Adapter Registry (频道适配层)              │       │
│  │  ├── DiscordAdapter (Gateway + 选举 + Slash Cmd)  │       │
│  │  ├── TelegramAdapter (Webhook + REST 回复)        │       │
│  │  └── SlackAdapter (Webhook + REST 回复)           │       │
│  ├──────────────────────────────────────────────────┤       │
│  │  后台服务                                          │       │
│  │  ├── Health Checker (每小时凭证验证)                │       │
│  │  ├── Cognito JWT 验证 (中间件)                     │       │
│  │  └── 内存缓存 (Bot/凭证, TTL 5min)                 │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
│  SQS FIFO Queue (入站) ← Webhook/Gateway 入队               │
│  SQS Standard Queue (回复) ← Agent send_message 工具         │
│  MessageGroupId = {bot_id}#{group_jid}                       │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           │ InvokeAgentRuntime
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     Agent Execution Layer                     │
│                                                              │
│  AgentCore Runtime                                           │
│  ┌──────────────────────────────────────────────────┐       │
│  │  microVM (per session)                            │       │
│  │  ├── Claude Agent SDK                             │       │
│  │  │   └── CLAUDE_CODE_USE_BEDROCK=1                │       │
│  │  │       └── Bedrock Claude (IAM Role)            │       │
│  │  ├── 工具: Read/Write/Edit/Bash/Glob/Grep...       │       │
│  │  ├── MCP 工具: send_message, schedule_task...     │       │
│  │  ├── S3 session + 记忆 + IDENTITY/SOUL 恢复/回写   │       │
│  │  ├── 结构化 System Prompt (9 Section Builder)     │       │
│  │  └── 结果 → DynamoDB + Channel Adapter (回复)      │       │
│  └──────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────┐       │
│  │  microVM (另一个 session)                          │       │
│  │  └── ...                                          │       │
│  └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     Data Layer                                │
│                                                              │
│  ┌──────────┐  ┌────┐  ┌─────────────┐  ┌────────────────┐ │
│  │ DynamoDB  │  │ S3 │  │ Secrets Mgr │  │ EventBridge    │ │
│  │ (状态)    │  │    │  │ (Channel    │  │ Scheduler      │ │
│  │          │  │    │  │  凭证)       │  │ (定时任务)      │ │
│  └──────────┘  └────┘  └─────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 13. 成本模型

### 13.1 单用户月成本估算

假设: 1 个 Bot, 1 个 Telegram Channel, 每天 30 次对话, 每次平均 60 秒 (其中 70% I/O 等待)

| 组件 | 计算 | 月成本 |
|------|------|--------|
| AgentCore CPU | 30 × 30 × 18s × 1vCPU × $0.0895/3600 | ~$0.40 |
| AgentCore Memory | 30 × 30 × 60s × 2GB × $0.00945/3600 | ~$0.28 |
| Bedrock Claude | 30 × 30 × ~2K tokens × $0.003/1K | ~$5.40 |
| DynamoDB | 按需模式，低流量 | ~$0.50 |
| S3 | < 1GB 存储 + 少量请求 | ~$0.10 |
| Secrets Manager | 极少调用 (Fargate 内存缓存) | ~$0.05 |
| EventBridge | 少量定时任务 | ~$0.01 |
| CloudFront + S3 | 静态站点 | ~$0.50 |
| **单用户边际合计** | | **~$7.24/月** |

**注:** Bedrock Claude 模型调用费是最大头。Fargate 内存缓存大幅减少 Secrets Manager 调用量。

### 13.2 平台固定成本

| 组件 | 月成本 |
|------|--------|
| Fargate Service (2 Task, 0.5vCPU/1GB) | ~$30 |
| ALB | ~$18 |
| CloudFront 分发 | ~$1 |
| Cognito (< 50K MAU 免费) | $0 |
| Route 53 域名 | ~$0.50 |
| ACM 证书 | $0 |
| CloudWatch 日志 | ~$5 (视量) |
| **平台固定合计** | **~$55/月** |

**注:** 相比纯 Lambda 方案，Fargate + ALB 增加了约 $48/月的固定成本。这是用常驻进程换取无超时限制和内存缓存优势的代价。用户数超过 ~7 人后，缓存省下的 Secrets Manager 和 DynamoDB 调用费开始回本。

### 13.3 规模经济

| 用户数 | 月成本 (估算) | 人均成本 |
|--------|-------------|---------|
| 1 | $62 | $62 |
| 10 | $127 | $12.70 |
| 100 | $779 | $7.79 |
| 1000 | $7,295 | $7.30 |

固定成本 ($55) 在用户增长后被摊薄。100+ 用户后人均成本趋近纯边际成本。

**Auto Scaling 可优化固定成本：** 低峰时段缩至 2 Task (高可用最低配)，高峰扩至 N Task。Fargate Spot 可再降 ~70% 计算成本（代价是偶尔中断，SQS 重试兜底）。

---

## 14. NanoClaw → ClawBot Cloud 映射

| NanoClaw 组件 | ClawBot Cloud 对应 | 变更说明 |
|--------------|-------------------|---------|
| `src/index.ts` (主循环) | Fargate SQS Consumer | 从轮询 SQLite 变长轮询 SQS |
| `src/channels/registry.ts` | DynamoDB channels 表 | 从代码注册变数据驱动 |
| Channel SDK 连接 | Webhook + Fargate HTTP | 从长连接变 Webhook |
| `src/router.ts` (消息路由) | Fargate HTTP + SQS Consumer | HTTP 接收 + 后台消费 |
| `src/container-runner.ts` | AgentCore Runtime | 从 Docker 变托管 microVM |
| `container/agent-runner` | AgentCore 容器 `/invocations` | 从 stdin/stdout 变 HTTP |
| `src/ipc.ts` (文件 IPC) | AWS SDK 直接调用 | 无需文件中转 |
| `src/db.ts` (SQLite) | DynamoDB | 从单文件变分布式 |
| `src/group-queue.ts` | SQS FIFO + MessageGroupId | 从内存队列变托管队列 |
| `src/task-scheduler.ts` | EventBridge Scheduler → SQS | 从自建循环变托管调度 |
| `src/credential-proxy.ts` | IAM Role | 完全消除 |
| `src/mount-security.ts` | AgentCore microVM 隔离 | 完全消除 |
| `src/sender-allowlist.ts` | DynamoDB + Webhook Lambda | 从文件配置变数据驱动 |
| `groups/*/CLAUDE.md` | S3 + Agent 启动时加载 | 从本地文件变对象存储 |
| `data/sessions/` | S3 + AgentCore Session | 跨 session 需 S3 持久化 |
| launchd / systemd | Serverless (无进程管理) | 完全消除 |
| Web 控制台 | 新增 | NanoClaw 无此组件 |
| 用户认证 | 新增 (Cognito) | NanoClaw 无此需求 |
| 多 Bot 管理 | 新增 | NanoClaw 单 Bot |
