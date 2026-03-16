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
