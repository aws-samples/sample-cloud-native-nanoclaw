# 舆情分析 Skill (sentiment-analysis)

Collect multi-channel feedback (web search + Feishu exports), run hybrid stats + LLM analysis, publish an interactive HTML report to S3 (presigned URL).

## Setup

    pip install -r requirements.txt

First run asks for S3 bucket / prefix / region / presign expiry (saved to `~/.config/kiro-feedback-skill/config.json`).

## Usage

Invoke via Claude: "分析 <产品> 的舆情". The workflow is defined in `SKILL.md`.

## Layout

- `scripts/` — deterministic Python (config, normalize, stats, feishu_adapter, preflight, publish_s3, build_report)
- `rubric/` — JSON schemas for subagent output
- `templates/report.html.tmpl` — self-contained frontend (ECharts via CDN)
- `tests/` — pytest suite

## Design

See `docs/plans/2026-06-08-舆情分析skill-design.md`.
