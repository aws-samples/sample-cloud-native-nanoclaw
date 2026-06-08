---
name: sentiment-analysis
description: Collect multi-channel public-opinion/feedback data (web search + Feishu exports), run hybrid statistical + LLM analysis, and publish an interactive HTML report to S3 behind a presigned URL. Use when the user asks to analyze 舆情/feedback/reviews for a product or topic, or mentions "舆情分析", "feedback report", or analyzing collected chat/social data.
---

# 舆情分析 Skill

Hybrid pipeline: deterministic stats in Python, semantic labeling/synthesis via fanned-out subagents, output a self-contained interactive HTML report published to S3.

All scripts run from the skill directory and import as `python3 -m scripts.<module>` (this environment's binary is `python3`). Runtime artifacts go under `data/`.

## Step 0 — Preflight (gate; do not proceed unless all pass)

1. **Config:** Run `python3 -c "from scripts.config import load_config; print(load_config())"`.
   - If `None` (first use): ask the user for **bucket name**, **key prefix**, **region**, and **presign expiry** (default 604800s = 7 days). Save via `scripts.config.save_config`.
2. **Python deps:** `python3 -c "from scripts.preflight import ensure_python_deps; print(ensure_python_deps(['boto3','jieba','jsonschema']))"` — must print `True`.
3. **AWS creds:** `python3 -c "from scripts.preflight import check_aws_credentials; print(check_aws_credentials())"` — must print `True`, else tell the user to configure AWS credentials and stop.
4. **S3 bucket + write:** check `check_s3_bucket(bucket, region)` returns `ok` and `s3_write_probe(bucket, prefix, region)` returns `True`. On `missing`/`forbidden`/`region_mismatch`, report the specific cause and stop.
5. **MCP:** confirm `kiro-web-search` is available if the data source includes web. If unavailable and web was requested, warn and fall back to Feishu-only.

## Step 1 — Parse intent

Determine: monitoring subject, time range, data sources (web/feishu), Feishu file path if any.

## Step 2 — Collect → `data/raw_records.json`

- **Web:** derive several query variants from the subject; call `kiro-web-search`; for promising hits, fetch full text with `WebFetch`. Collect items as dicts (title/content/url/site/author/date) and run them through `scripts.normalize.normalize(items, "web")`.
- **Feishu:** `scripts.feishu_adapter.parse_feishu(path)`.
- Merge both lists; write to `data/raw_records.json`. Record dropped/failed items for the coverage note.

## Step 3 — Deterministic stats

Run `scripts.stats.add_tokens(records)` then compute full-range `term_frequency / daily_volume / pareto_by_author / mau / lifespan`. Persist tokens back into the records. (Frontend recomputes these per filter; full-range values feed the synthesis context.)

## Step 4 — B0: fixed rubric (one subagent)

Dispatch one subagent over a representative sample (~50–100 records) to produce a **fixed taxonomy**: topic categories, Kano candidate features, JTBD candidate jobs. This rubric is passed verbatim to all B2 subagents to keep labels consistent.

## Step 5 — B2: per-record labeling (parallel fan-out)

Use the `dispatching-parallel-agents` pattern. Split records into batches (~50–100 each). Each subagent receives its batch + the fixed rubric and returns **strict JSON** matching `rubric/label.schema.json`: `[{id, sentiment{label,score}, topic, painpoint{flag,severity,type}}]`. Validate each batch with `scripts.models.validate_labels`; on failure, retry once, then degrade that batch's labels to `topic:"其他"`, `painpoint.flag:false`, `sentiment:{label:"neu",score:0}`. Subagents return only labels (not original text). Merge labels into records by `id`.

## Step 6 — B3: synthesis (1–3 subagents)

Dispatch subagent(s) over the aggregated label stats + sampled quotes to produce corpus-level **JTBD jobs / Kano categorization / topic-cluster naming**, returning JSON matching `rubric/synth.schema.json`. Validate with `scripts.models.validate_synthesis`.

## Step 7 — Assemble + build report

Write `data/enriched_dataset.json` = `{meta, records (with tokens+labels), stats, synthesis}`. `meta` includes subject, range, source mix, coverage, and any sampling caveats (including the "MAU/retention — 按账号近似" note). Then:
`python3 -c "from scripts.build_report import build; build('data/enriched_dataset.json','templates/report.html.tmpl','data/report.html')"`

## Step 8 — Publish

`python3 -c "from scripts.publish_s3 import publish; from scripts.config import load_config; import datetime; print(publish('data/report.html', load_config(), '<subject>', datetime.datetime.now().strftime('%Y%m%d-%H%M%S')))"`
Return the printed presigned URL to the user.

## Edge cases

- Web zero-results / fetch failures → skip + count; note coverage in `meta`.
- Missing timestamps → trend/MAU bucket them as "未知".
- Oversized corpus → cap/sample batches; note sampling口径 in `meta`.
- Topic not in fixed taxonomy → "其他".
