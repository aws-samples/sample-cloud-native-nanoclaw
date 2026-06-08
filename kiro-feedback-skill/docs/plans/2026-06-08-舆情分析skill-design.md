# 舆情分析 Skill 设计文档

- 日期：2026-06-08
- 状态：设计已验证，待实现
- 工作目录：`kiro-feedback-skill/`

## 1. 目标

一个 Claude 驱动的舆情/反馈分析 skill：采集多渠道信息（网络搜索为主、飞书群聊导出为辅），跑统计 + LLM 语义分析，产出**精美的自包含 HTML 报告**，上传 S3 并回传**预签名 URL**。为产品开发与市场提供洞察。

报告支持**按日期区间筛选**，点击各分析方法查看对应视图。

## 2. 核心决策快照

| # | 决策 | 选择 |
|---|------|------|
| 1 | 数据来源 | 网络搜索为主（`kiro-web-search` MCP）+ 飞书导出为辅 |
| 2 | 分析引擎 | 混合：确定性统计用 Python 脚本，语义类用 LLM |
| 3 | 报告形态 | 静态预生成 HTML + 前端筛选（LLM 一次性逐条打标，JS 客户端按日期聚合） |
| 4 | 阶段 B 实现 | subagent 扇出（`dispatching-parallel-agents` 轻量手动模式） |
| 5 | 用户类方法口径 | 统一按「作者/账号」近似用户，报告标注口径 |
| 6 | 托管方式 | 上传 S3 对象 + 预签名 GET URL（默认 7 天），不起本地 server |
| 7 | 飞书解析 | 预留适配器接口，v1 主攻网搜，拿到样本再适配 |

## 3. 分析方法落位

| 方法 | 实现层 | 是否随日期筛选联动 |
|------|--------|--------------------|
| 高频词（Term Frequency） | Python 预分词 + 前端计数 | ✅ |
| 主题聚类（关键词规则） | B0 固定 taxonomy + 前端占比 | ✅ |
| 痛点/故障信号挖掘 | LLM 逐条打标 + 前端聚合 | ✅ |
| 活跃趋势（MAU / 消息量时间序列） | 前端按天/月聚合 | ✅ |
| 用户分层与二八（帕累托） | 前端按 author 累计 | ✅ |
| 留存 / 生命周期近似（Lifespan） | 前端 author 首末出现跨度 | ✅ |
| 情感 | LLM 逐条打标 + 前端分布 | ✅ |
| 主题建模 | B3 综述（簇命名/解读） | ❌ 全量洞察区 |
| JTBD-Kano | B3 综述 | ❌ 全量洞察区 |

> **取舍说明**：JTBD-Kano、主题建模解读是语料级 LLM 综述，无法在前端按日期重算，故作为「**全量洞察区**」展示并标注口径，不随日期滑块变化；其余 8 类均客户端实时联动。
>
> **用户口径说明**：MAU / 留存 / 帕累托用户分层依赖「用户群体 + 重复活跃」。飞书群聊天然具备；网络搜索按「作者/账号」近似，报告需标注「口径：按账号近似」。

## 4. 架构与数据流

```
Step 0  自检查（前置闸门，全绿才继续）
        ├─ 0a 配置: 加载 ~/.config/kiro-feedback-skill/config.json
        │        缺失(首次) → 询问 bucket / key prefix / region / URL有效期 → 持久化
        ├─ 0b AWS 凭证: sts:GetCallerIdentity 探测
        ├─ 0c S3: HeadBucket + 写探针(Put .preflight 再 Delete) 验证写权限
        │        失败区分「不存在 / 无权限 / region 不符」给修复建议
        ├─ 0d Python 依赖: import boto3, jieba; 缺失则 pip install
        └─ 0e MCP: 确认 kiro-web-search 可用; 不可用且含 web 源 → 警告/降级

阶段 A  采集（Claude 驱动）
        kiro-web-search MCP 多查询 → WebFetch 抽正文 ─┐
                                                       ├─→ normalize.py → raw_records.json
        飞书导出文件 → feishu_adapter.py ──────────────┘   (统一 schema)

阶段 B  富化/分析（混合引擎，subagent 扇出）
        B0 stats.py: jieba 分词 / 时间桶 / 作者聚合 / 帕累托 / 趋势 → stats.json
        B0 口径引导子代理 ×1: 读样本 → 固定 taxonomy + Kano 候选 + JTBD 候选 (rubric)
        B2 打标子代理 ×N (并行, 每个吃一 batch + 固定 rubric):
              输出严格 JSON {id → 情感, 主题tag, 痛点信号}; 只回传标签不回传原文
        B3 综述子代理 ×1~3: 在汇总标签 + 抽样引文上跑 → JTBD jobs / Kano 分类 / 主题簇命名
        合并 stats.json + 标签 + 综述 → enriched_dataset.json

阶段 C  报告生成 + 托管
        build_report.py: 模板注入 enriched_dataset（内联）→ 自包含 report.html
        上传 S3 (ContentType: text/html) → 生成 presigned GET URL → 回传
```

**核心机制**：LLM 只在阶段 B 跑一次（逐条标签 + 聚合综述），结果连同原始带标签记录**内联**进 HTML。日期筛选时前端 JS 在带标签记录上重新聚合 → 8 类指标随日期实时变化，**无需任何实时 LLM 调用**。

## 5. 数据模型（统一 schema）

```jsonc
// 采集后 raw_records.json —— 每条记录
{
  "id": "ulid",
  "source": "web" | "feishu",
  "channel": "weibo|zhihu|appstore|news|... | feishu:群名",
  "author": "账号/昵称",          // 用户近似口径
  "timestamp": "2026-06-01T12:30:00+08:00",  // 缺失则退化为检索时间并打标记
  "text": "正文内容",
  "url": "原帖链接(web有)",
  "tokens": ["预", "分词", "结果"],            // stats.py 产出, 供前端高频词
  "meta": { "likes": 12, "replies": 3 }       // 有则带, 可作权重
}

// 富化后 enriched_dataset.json —— 阶段 B 追加
"labels": {
  "sentiment": { "label": "pos|neu|neg", "score": -1.0~1.0 },
  "topic": "性能卡顿",            // 来自 B0 固定 taxonomy, 不在表内归「其他」
  "painpoint": { "flag": true, "severity": "high|mid|low", "type": "故障|易用性|功能缺失|..." }
}
```

顶层另含：`meta`（监测主题、时间范围、数据源构成、覆盖率、采样口径）、`stats`（预算好的趋势/帕累托/MAU/留存）、`synthesis`（B3 全量综述：JTBD/Kano/主题命名）。

## 6. 报告与前端交互

单文件自包含 `report.html`，富化数据**内联**（不可旁挂，否则预签名 URL fetch 旁挂文件会 403）。ECharts / echarts-wordcloud 走 **CDN `<script>`**（cdnjs）。

```
┌ 顶部: 监测主题 · 时间范围 · 数据源构成(web/飞书占比) · 覆盖率/采样口径 ┐
├ 控制条: [日期区间滑块] [来源/渠道筛选] ──────────────────────────────┤
├ 分析方法卡片网格 (点击切换视图):                                       │
│  高频词☁ · 主题占比◔ · 情感分布◔ · 发文量趋势📈                       │
│  痛点信号🚨 · 帕累托二八📊 · MAU📈 · 留存生命周期📈                    │
│  ── JTBD-Kano / 主题建模 全量洞察区 (标注口径, 不随筛选) ──            │
└────────────────────────────────────────────────────────────────────────┘
```

**前端聚合引擎（纯 JS）**：对「当前日期区间 + 渠道」过滤后的带标签记录，客户端实时计算：高频词（token 计数）、情感/主题分布、发文量趋势（按天）、帕累托（按 author 累计）、MAU（author×月）、留存近似（author 首末跨度）、痛点聚合（按 severity/type）。

**视觉**：遵循 `frontend-design` 原则，干净 dashboard 风、响应式、中文友好。

## 7. Skill 封装结构

```
kiro-feedback-skill/
├── SKILL.md              # 入口: 触发条件 + 工作流编排说明
├── scripts/
│   ├── normalize.py      # 采集结果归一化 → raw_records.json
│   ├── feishu_adapter.py # 飞书解析适配器（预留接口, 输出统一 schema）
│   ├── stats.py          # B0 统计: jieba/趋势/帕累托/MAU/留存 + 预分词
│   ├── build_report.py   # 模板注入 → 自包含 report.html
│   └── publish_s3.py     # 上传 S3 + 生成 presigned URL
├── templates/
│   └── report.html.tmpl  # ECharts 前端 + JS 聚合引擎
├── rubric/
│   ├── label.schema.json # B2 打标输出 schema（校验用）
│   └── synth.schema.json # B3 综述输出 schema
└── data/                 # 运行产物 raw/enriched/report
```

## 8. SKILL.md 工作流（Claude 编排顺序）

0. **自检查**（见 Step 0），全绿才继续
1. 解析意图：监测主题、时间范围、数据源
2. 采集：MCP 多查询搜索 → WebFetch 抽正文 → `normalize.py`；飞书文件 → `feishu_adapter.py`
3. `stats.py` 跑确定性统计 + 预分词
4. B0：引导子代理产出固定 taxonomy / Kano 候选 / JTBD 候选
5. B2：扇出打标子代理（按 batch），`label.schema.json` 校验
6. B3：综述子代理产出 JTBD-Kano / 主题命名（`synth.schema.json` 校验）
7. `build_report.py` 合并 → `report.html`
8. `publish_s3.py` 上传（`ContentType: text/html`）+ 生成 presigned URL，回传用户

## 9. 异常与边界处理

| 场景 | 处理 |
|------|------|
| 网搜零结果 / 抽正文失败 | 跳过并计数，报告标「覆盖率」 |
| 时间戳缺失 | 打标记，趋势类归「未知」桶 |
| 子代理 JSON 不合规 | 重试 1 次，仍失败该 batch 降级标 `unknown` |
| 语料过大 | 分片 + 可选采样上限，报告标「采样口径」 |
| topic 不在固定表 | 归「其他」 |
| 各 batch 标签不一致 | B0 固定 taxonomy 下发缓解 |
| S3 bucket 不存在/无权限/region 不符 | Step 0 即停，区分原因给修复建议 |
| Python 依赖缺失 | Step 0 自动 `pip install`，失败则停并提示 |
| `kiro-web-search` 不可用 | 含 web 源时警告/降级到仅飞书 |

## 10. 依赖

- **Python**：`boto3`（S3 上传/预签名）、`jieba`（中文分词）。飞书表格格式确定后按需加 `pandas/openpyxl`。
- **前端**：ECharts + echarts-wordcloud（CDN，无需本地安装）。
- **MCP**：`kiro-web-search`（网搜管线）。

## 11. 后续（v2 候选）

- 飞书导出格式确定后实现具体解析（Excel/CSV/JSON/TXT 适配）。
- 大语料下用 `Workflow` 工具把 B0→B2→B3 升级为确定性 pipeline（断点续跑、并发受控）。
- web app 内触发新采集（需独立接入搜索 API）。
- 真实用户群体指标（非近似）若接入产品自有数据。
