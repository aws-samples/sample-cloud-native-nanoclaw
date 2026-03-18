# TODO

## 索引

| # | 项目 | 状态 | 优先级 |
|---|------|------|--------|
| [1](#1-清理诊断代码) | 清理诊断代码 | 待清理 | 高 |
| [2](#2-agentcore-runtime-镜像更新流程优化) | AgentCore runtime 镜像更新流程优化 | 待优化 | 中 |
| [3](#3-s3-abac-prefix-condition-不生效) | S3 ABAC prefix condition 不生效 | 待研究 | 低 |
| [4](#4-agentcore-runtime-cloudwatch-logs-不写入) | ~~AgentCore runtime CloudWatch Logs 不写入~~ | 已解决 | — |
| [5](#5-system-prompt-builder-单元测试) | System Prompt Builder 单元测试 | 待编写 | 中 |
| [6](#6-清理-agent-runtime-debug-代码) | 清理 agent-runtime debug 代码 | 待清理 | 高 |
| [7](#7-旧-discord-gateway-manager-死代码清理) | 旧 Discord gateway-manager 死代码清理 | 待清理 | 低 |
| [8](#8-model-selection-后续优化) | Model selection 后续优化 | 待实现 | 低 |
| [9](#9-dispatcher-getgroup-热路径优化) | Dispatcher getGroup 热路径优化 | 待优化 | 中 |
| [10](#10-discord-message-handler-重复代码合并) | ~~Discord message handler 重复代码合并~~ | 已完成 | — |
| [11](#11-discord-gateway-leader-election-滚动更新问题) | ~~Discord Gateway leader election 滚动更新问题~~ | 已完成 | — |
| [12](#12-file-attachments-后续优化) | File attachments 后续优化 | 待实现 | 中 |

---

## 1. 清理诊断代码

**状态**: 待清理
**日期**: 2026-03-16
**优先级**: 高

### 待清理

- [ ] `agent-runtime/src/server.ts` — 移除 error response 中的 `[ENV: ...]` 诊断信息
- [ ] `agent-runtime/src/scoped-credentials.ts` — 移除 `[ABAC-DEBUG]` console.log 和诊断 S3/STS 调用
- [ ] `agent-runtime/src/agent.ts` — 移除 `_debugFiles` 附加到 result 的代码

---

## 2. AgentCore runtime 镜像更新流程优化

**状态**: 待优化
**日期**: 2026-03-16
**优先级**: 中

### 问题描述

AgentCore runtime 使用 `latest` tag 时，`update-agent-runtime` 不会重新拉取镜像。需要用 explicit digest 或删除重建 runtime 才能更新。

### 待改进

- [ ] `deploy.sh` 和 `post-deploy.sh` 中改用 explicit image digest（`@sha256:...`）而非 `latest` tag
- [ ] `post-deploy.sh` 中 update runtime 时必须携带 `--environment-variables`（否则会被清空）
- [ ] 更新后使用 `stop-runtime-session` 停掉热容器，避免删除 runtime

---

## 3. S3 ABAC prefix condition 不生效

**状态**: 待研究
**日期**: 2026-03-16
**优先级**: 低（当前 workaround 可用）

### 问题描述

ScopedRole 的 S3 ListBucket ABAC 条件不生效。Session tags (`userId`, `botId`) 通过 STS AssumeRole 传递成功（GetObject/PutObject 的 resource-level ABAC 正常），但 `s3:prefix` 条件始终拒绝：

```json
{
  "Condition": {
    "StringLike": {
      "s3:prefix": ["${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*"]
    }
  }
}
```

错误信息：`no identity-based policy allows the s3:ListBucket action`

### 已验证

- Session tags 正确设置（`userId=48d1e3a0-...`, `botId=01KKRNGA47...`）
- STS AssumeRole + TagSession 权限正确（trust policy 已有 `sts:TagSession`）
- GetObject/PutObject 使用 `${aws:PrincipalTag/...}` 在 resource ARN 中正常工作
- 仅 `s3:prefix` condition key 与 `${aws:PrincipalTag}` 组合不生效

### 可能原因

1. `s3:prefix` 条件键与 `${aws:PrincipalTag}` 变量的组合可能不被支持或有特殊行为
2. `ListObjectsV2` 的 prefix 参数在 IAM 评估时可能有编码/格式差异
3. `StringLike` 对 `s3:prefix` 的匹配逻辑可能与 resource ARN 中的通配符不同

### 待研究

- [ ] 查阅 AWS 官方文档关于 `s3:prefix` 与 IAM policy variables 的兼容性
- [ ] 用 CloudTrail 记录实际的 S3 API 调用，对比 IAM 评估日志
- [ ] 启用 IAM Access Analyzer 或 CloudTrail IAM policy evaluation 来查看条件评估细节
- [ ] 测试不同的条件写法（如 `StringEquals` + 精确 prefix，或去掉尾部 `/*`）

### 当前 workaround

S3 ListBucket 不加 prefix 条件，安全性由 GetObject/PutObject 的 resource-level ABAC 保证（只能列出 key 名，不能读取其他租户的内容）。

---

## 4. ~~AgentCore runtime CloudWatch Logs 不写入~~

**状态**: 已解决
**日期**: 2026-03-16

### 根因

AgentBaseRole 缺少 CloudWatch Logs 权限。AWS 文档明确要求 execution role 需要：
- `logs:CreateLogGroup` + `logs:DescribeLogStreams` on `/aws/bedrock-agentcore/runtimes/*`
- `logs:DescribeLogGroups` on `*`
- `logs:CreateLogStream` + `logs:PutLogEvents` on `/aws/bedrock-agentcore/runtimes/*:log-stream:*`
- `cloudwatch:PutMetricData` with `cloudwatch:namespace = bedrock-agentcore`

### 修复

已在 `agent-stack.ts` 的 AgentBaseRole 中添加上述权限。部署后需 `stop-runtime-session` 让热容器冷启动才能生效。

### 参考

https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html

---

## 5. System Prompt Builder 单元测试

**状态**: 待编写
**日期**: 2026-03-16
**优先级**: 中

### 待编写

- [ ] `agent-runtime/src/system-prompt.ts` — 测试 8 个 section 的组装逻辑、null section 跳过、section 排序
- [ ] `agent-runtime/src/memory.ts` — 测试 `truncateContent` 边界条件（空字符串、恰好等于 cap、超出 cap、极小 budget）
- [ ] `agent-runtime/src/memory.ts` — 测试 `loadMemoryLayers` 总量上限强制截断
- [ ] Bootstrap 注入的 `isNewSession` 门控测试

### 备注

这些都是纯函数，输入输出明确，非常适合单元测试。agent-runtime 目前没有测试框架，需要先配置 vitest。

---

## 6. 清理 agent-runtime debug 代码

**状态**: 待清理
**日期**: 2026-03-16
**优先级**: 高（部署生产环境前必须清理）

### 待清理

- [ ] `agent-runtime/src/agent.ts` — 移除 `debugFiles` 文件系统遍历和 `_debugFiles` 附加到 result
- [ ] `agent-runtime/src/server.ts` — 移除 error response 中的 `[ENV: ...]` 诊断信息
- [ ] `agent-runtime/src/scoped-credentials.ts` — 移除 `[ABAC-DEBUG]` console.log

### 备注

这些代码在每次 invocation 时读取文件系统并修改返回类型，不应出现在生产环境。

---

## 7. 旧 Discord gateway-manager 死代码清理

**状态**: 待清理
**日期**: 2026-03-16
**优先级**: 低

### 待清理

- [ ] `control-plane/src/discord/gateway-manager.ts` — 已被 `adapters/discord/index.ts` 替代
- [ ] `control-plane/src/discord/message-handler.ts` — 逻辑已整合入 DiscordAdapter
- [ ] `control-plane/src/channels/discord.ts` — 部分仍被 `channels/index.ts` 和 `reply-consumer.ts` 引用，待 reply-consumer 完全迁移后可删

### 备注

`channels/discord.ts` 中的 `verifyCredentials` 和 `getGatewayBot` 仍被 `channels/index.ts` 使用（channel 创建时验证凭证），不能直接删除。需要将验证逻辑迁移到 DiscordAdapter 后才能完全清理。

---

## 8. Model selection 后续优化

**状态**: 待实现
**日期**: 2026-03-17
**优先级**: 低

### 待改进

- [ ] Dispatcher 测试补充 model 字段传递验证（`dispatcher.test.ts` 中无 model 相关测试）
- [ ] 支持重置 model 为"使用默认值"（当前选择默认 Sonnet 仍会存储显式字符串，无法跟随 DEFAULT_MODEL 常量变化）
- [ ] 考虑将 MODEL_PRESETS 和 DEFAULT_MODEL 提取到 `@clawbot/shared` 统一管理

---

## 9. Dispatcher getGroup 热路径优化

**状态**: 待优化
**日期**: 2026-03-17
**优先级**: 中

### 问题描述

`dispatchMessage()` 中为获取 `isGroupChat` 标志新增了 `getGroup()` DynamoDB 读取，每条入站消息额外一次读操作。

### 待改进

- [ ] 将 `isGroup` 信息提前到 webhook 层（SqsInboundPayload 中已有 group 信息时直接传递）
- [ ] 或在 dispatcher 中缓存 group 记录（同一 group 短时间内多次查询）

---

## 10. ~~Discord message handler 重复代码合并~~

**状态**: 已完成（2026-03-18）
**日期**: 2026-03-18
**优先级**: 高

### 问题描述

Discord 消息处理逻辑有两份独立的副本：
- `control-plane/src/adapters/discord/index.ts`（Gateway 模式，实际使用的代码）
- `control-plane/src/discord/message-handler.ts`（早期版本 / webhook fallback）

两份代码各自维护附件处理、trigger 检查、SQS dispatch 逻辑。修改一处时容易遗漏另一处（已经发生多次）。

### 待改进

- [ ] 将消息处理逻辑抽成共享函数（如 `processDiscordMessage()`），两处调用同一函数
- [ ] 或删除 `message-handler.ts`，统一由 Gateway adapter 处理（参考 TODO #7）

---

## 11. ~~Discord Gateway leader election 滚动更新问题~~

**状态**: 已完成（2026-03-18）
**日期**: 2026-03-18
**优先级**: 高

### 问题描述

ECS 滚动更新时，新 task 启动后看到旧 leader 的 DynamoDB lock 未过期，进入 standby。旧 task 被 drain 时可能来不及调 `releaseLock()`（ECS SIGTERM → 强制 kill），导致 lock 残留直到 TTL（60s）过期。期间 Discord Gateway 无 leader，bot 无法接收消息。

### 现象

每次 ECS force-new-deployment 后，Discord bot 有约 60-90 秒无响应窗口。

### 待改进

- [ ] 增大 ECS stop timeout（`stopTimeout`），给旧 task 足够时间优雅 shutdown 和 releaseLock
- [ ] 或缩短 lock TTL（如 30s），减少无 leader 窗口
- [ ] 或在 standby poll 中增加首次 poll 的 jitter，使其更快检测到 lock 过期
- [ ] 考虑 ECS deployment circuit breaker 配置

---

## 12. File attachments 后续优化

**状态**: 待实现
**日期**: 2026-03-18
**优先级**: 中

### 来自 code review 的建议

- [ ] MCP send_file: messageId 用 `Date.now()-${random}` 替代纯 `Date.now()` 防碰撞
- [ ] Reply consumer: S3 key 验证是否属于预期 `{userId}/{botId}/attachments/` 前缀
- [ ] Agent runtime: 下载附件改用 `Promise.allSettled` 并发（当前顺序下载）
- [ ] Agent runtime: 清理旧 invocation 残留的 `/workspace/group/attachments/` 文件
- [ ] S3 lifecycle rule: `attachments/` 前缀下的对象设置自动过期（避免无限累积）
- [ ] File reply flow 单元测试（reply consumer 的 text vs file 分支）
