# 舆情分析 Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude-driven public-opinion/feedback analysis skill that collects multi-channel data (web search + Feishu exports), runs hybrid statistical + LLM analysis, and publishes a self-contained interactive HTML report to S3 behind a presigned URL.

**Architecture:** A Python toolkit of small focused modules (config, models, normalize, stats, feishu_adapter, preflight, publish_s3, build_report) orchestrated by `SKILL.md`. Statistics are deterministic Python (jieba tokenization + aggregates); semantic labeling/synthesis is done by Claude via fanned-out subagents writing schema-validated JSON. The report is a single self-contained HTML file (data inlined, ECharts via CDN) that re-aggregates client-side on date/channel filter, so 8 metrics stay interactive with zero runtime LLM calls.

**Tech Stack:** Python 3.12, `boto3` (S3), `jieba` (Chinese tokenization), `jsonschema` (subagent output validation), `pytest` + `botocore.stub.Stubber` (tests); ECharts + echarts-wordcloud via CDN (frontend).

Design reference: `kiro-feedback-skill/docs/plans/2026-06-08-舆情分析skill-design.md`

---

## File Structure

```
kiro-feedback-skill/
├── SKILL.md                       # orchestrator (Task 11)
├── requirements.txt               # runtime deps (Task 0)
├── requirements-dev.txt           # pytest (Task 0)
├── pytest.ini                     # test config (Task 0)
├── rubric/
│   ├── label.schema.json          # B2 per-record label schema (Task 1)
│   └── synth.schema.json          # B3 synthesis schema (Task 1)
├── scripts/
│   ├── __init__.py
│   ├── config.py                  # load/save ~/.config/kiro-feedback-skill/config.json (Task 2)
│   ├── models.py                  # schema loading + validate helpers (Task 3)
│   ├── normalize.py               # raw collected items → unified records (Task 4)
│   ├── stats.py                   # tokenize + term-freq/trend/pareto/mau/lifespan (Task 5)
│   ├── feishu_adapter.py          # Feishu export parser (JSONL impl + stub others) (Task 6)
│   ├── preflight.py               # deps + AWS creds + S3 checks (Task 7)
│   ├── publish_s3.py              # upload report + presigned URL (Task 8)
│   └── build_report.py            # inject enriched dataset into template (Task 9)
├── templates/
│   └── report.html.tmpl           # self-contained frontend + JS aggregation (Task 10)
├── tests/
│   ├── __init__.py
│   ├── test_config.py
│   ├── test_models.py
│   ├── test_normalize.py
│   ├── test_stats.py
│   ├── test_feishu_adapter.py
│   ├── test_preflight.py
│   ├── test_publish_s3.py
│   └── test_build_report.py
└── data/                          # runtime artifacts (gitignored): raw/enriched/report
```

**Module boundaries:** `models`/`config` are dependency-free leaves. `normalize` is pure mapping. `stats` mirrors the JS frontend aggregation (the JS is a port of these functions — keep names/semantics aligned). `feishu_adapter` reuses `normalize`. `preflight`/`publish_s3` wrap boto3. `build_report` is pure templating. `SKILL.md` wires the pipeline and owns the LLM subagent fan-out (no Python LLM calls).

---

## Task 0: Project Scaffolding

**Files:**
- Create: `kiro-feedback-skill/requirements.txt`
- Create: `kiro-feedback-skill/requirements-dev.txt`
- Create: `kiro-feedback-skill/pytest.ini`
- Create: `kiro-feedback-skill/.gitignore`
- Create: `kiro-feedback-skill/scripts/__init__.py` (empty)
- Create: `kiro-feedback-skill/tests/__init__.py` (empty)

- [ ] **Step 1: Create dependency + config files**

`requirements.txt`:
```
boto3>=1.34
jieba>=0.42.1
jsonschema>=4.21
```

`requirements-dev.txt`:
```
-r requirements.txt
pytest>=8.0
```

`pytest.ini`:
```ini
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -q
```

`.gitignore`:
```
data/
__pycache__/
*.pyc
.pytest_cache/
```

- [ ] **Step 2: Create empty package markers**

Create empty `scripts/__init__.py` and `tests/__init__.py`.

- [ ] **Step 3: Install dev deps**

Run: `cd kiro-feedback-skill && pip install -r requirements-dev.txt`
Expected: installs boto3, jieba, jsonschema, pytest successfully.

- [ ] **Step 4: Verify pytest collects an empty suite**

Run: `cd kiro-feedback-skill && pytest`
Expected: `no tests ran` (exit 5) — confirms config is valid.

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/requirements*.txt kiro-feedback-skill/pytest.ini kiro-feedback-skill/.gitignore kiro-feedback-skill/scripts/__init__.py kiro-feedback-skill/tests/__init__.py
git commit -m "chore(skill): scaffold sentiment-analysis skill project"
```

---

## Task 1: JSON Schemas for Subagent Output

**Files:**
- Create: `kiro-feedback-skill/rubric/label.schema.json`
- Create: `kiro-feedback-skill/rubric/synth.schema.json`

These are validated in Task 3; no separate test here (Task 3 loads and validates against them).

- [ ] **Step 1: Write `label.schema.json`** (B2 output — a list of per-record labels)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id", "sentiment", "topic", "painpoint"],
    "additionalProperties": false,
    "properties": {
      "id": { "type": "string" },
      "sentiment": {
        "type": "object",
        "required": ["label", "score"],
        "additionalProperties": false,
        "properties": {
          "label": { "enum": ["pos", "neu", "neg"] },
          "score": { "type": "number", "minimum": -1, "maximum": 1 }
        }
      },
      "topic": { "type": "string", "minLength": 1 },
      "painpoint": {
        "type": "object",
        "required": ["flag"],
        "additionalProperties": false,
        "properties": {
          "flag": { "type": "boolean" },
          "severity": { "enum": ["high", "mid", "low", "unknown"] },
          "type": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write `synth.schema.json`** (B3 output — corpus-level synthesis)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["jtbd", "kano", "topics"],
  "additionalProperties": false,
  "properties": {
    "jtbd": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["job", "evidence"],
        "additionalProperties": false,
        "properties": {
          "job": { "type": "string" },
          "evidence": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "kano": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["feature", "category"],
        "additionalProperties": false,
        "properties": {
          "feature": { "type": "string" },
          "category": { "enum": ["must-be", "performance", "delight", "indifferent", "reverse"] },
          "rationale": { "type": "string" }
        }
      }
    },
    "topics": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "summary"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string" },
          "summary": { "type": "string" },
          "keywords": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add kiro-feedback-skill/rubric/
git commit -m "feat(skill): add label/synth JSON schemas for subagent output"
```

---

## Task 2: Config Module

**Files:**
- Create: `kiro-feedback-skill/scripts/config.py`
- Test: `kiro-feedback-skill/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config.py
import json
from scripts import config

def test_load_returns_none_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "nope.json")
    assert config.load_config() is None

def test_save_then_load_roundtrip(tmp_path, monkeypatch):
    path = tmp_path / "cfg" / "config.json"
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    monkeypatch.setattr(config, "CONFIG_DIR", path.parent)
    cfg = {"bucket": "my-bucket", "prefix": "reports", "region": "us-west-2", "presign_expiry_seconds": 604800}
    config.save_config(cfg)
    assert path.exists()
    assert config.load_config() == cfg
    # ensure non-ascii safe + pretty
    assert json.loads(path.read_text(encoding="utf-8"))["bucket"] == "my-bucket"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.config`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/config.py
"""Persisted skill configuration (S3 target + presign settings)."""
import json
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "kiro-feedback-skill"
CONFIG_PATH = CONFIG_DIR / "config.json"

REQUIRED_KEYS = ("bucket", "prefix", "region", "presign_expiry_seconds")


def load_config():
    """Return the saved config dict, or None if not yet configured."""
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return None


def save_config(cfg: dict) -> None:
    """Persist config; creates the config directory if needed."""
    missing = [k for k in REQUIRED_KEYS if k not in cfg]
    if missing:
        raise ValueError(f"config missing keys: {missing}")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_config.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/config.py kiro-feedback-skill/tests/test_config.py
git commit -m "feat(skill): add config load/save"
```

---

## Task 3: Models / Schema Validation

**Files:**
- Create: `kiro-feedback-skill/scripts/models.py`
- Test: `kiro-feedback-skill/tests/test_models.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_models.py
import pytest
from scripts import models

def test_validate_labels_accepts_valid():
    labels = [{
        "id": "abc",
        "sentiment": {"label": "neg", "score": -0.7},
        "topic": "性能卡顿",
        "painpoint": {"flag": True, "severity": "high", "type": "故障"}
    }]
    models.validate_labels(labels)  # should not raise

def test_validate_labels_rejects_bad_sentiment():
    bad = [{"id": "x", "sentiment": {"label": "angry", "score": 0},
            "topic": "t", "painpoint": {"flag": False}}]
    with pytest.raises(models.ValidationError):
        models.validate_labels(bad)

def test_validate_synthesis_accepts_valid():
    synth = {"jtbd": [{"job": "j", "evidence": ["e"]}],
             "kano": [{"feature": "f", "category": "must-be"}],
             "topics": [{"name": "n", "summary": "s"}]}
    models.validate_synthesis(synth)  # should not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.models`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/models.py
"""Schema loading + validation for subagent outputs."""
import json
from pathlib import Path
from jsonschema import validate, ValidationError  # re-exported

RUBRIC_DIR = Path(__file__).resolve().parent.parent / "rubric"

_LABEL_SCHEMA = json.loads((RUBRIC_DIR / "label.schema.json").read_text(encoding="utf-8"))
_SYNTH_SCHEMA = json.loads((RUBRIC_DIR / "synth.schema.json").read_text(encoding="utf-8"))


def validate_labels(labels) -> None:
    """Raise jsonschema.ValidationError if B2 label output is malformed."""
    validate(instance=labels, schema=_LABEL_SCHEMA)


def validate_synthesis(synth) -> None:
    """Raise jsonschema.ValidationError if B3 synthesis output is malformed."""
    validate(instance=synth, schema=_SYNTH_SCHEMA)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_models.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/models.py kiro-feedback-skill/tests/test_models.py
git commit -m "feat(skill): add schema validation helpers"
```

---

## Task 4: Normalize Module

**Files:**
- Create: `kiro-feedback-skill/scripts/normalize.py`
- Test: `kiro-feedback-skill/tests/test_normalize.py`

Produces the unified record schema from heterogeneous collected items.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_normalize.py
from scripts import normalize

def test_normalize_web_item_maps_fields():
    raw = {"title": "T", "content": "卡顿严重", "url": "https://weibo.com/x",
           "site": "weibo", "author": "userA", "date": "2026-06-01T10:00:00+08:00"}
    rec = normalize.normalize_item(raw, "web")
    assert rec["source"] == "web"
    assert rec["channel"] == "weibo"
    assert rec["author"] == "userA"
    assert rec["text"] == "卡顿严重"
    assert rec["url"] == "https://weibo.com/x"
    assert rec["timestamp"] == "2026-06-01T10:00:00+08:00"
    assert rec["meta"]["ts_source"] == "published"
    assert isinstance(rec["id"], str) and len(rec["id"]) > 0
    assert rec["tokens"] == []

def test_missing_timestamp_flagged():
    rec = normalize.normalize_item({"content": "x"}, "web")
    assert rec["timestamp"] is None
    assert rec["meta"]["ts_missing"] is True
    assert rec["author"] == "unknown"

def test_channel_falls_back_to_url_domain():
    rec = normalize.normalize_item({"content": "x", "url": "https://www.zhihu.com/q/1"}, "web")
    assert rec["channel"] == "zhihu.com"

def test_normalize_list():
    recs = normalize.normalize([{"content": "a"}, {"content": "b"}], "web")
    assert len(recs) == 2
    assert recs[0]["id"] != recs[1]["id"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_normalize.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.normalize`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/normalize.py
"""Normalize heterogeneous collected items into the unified record schema."""
import uuid
from datetime import datetime
from urllib.parse import urlparse

_TS_FORMATS = ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M", "%Y/%m/%d")


def _parse_timestamp(value):
    """Return ISO8601 string or None. None signals a missing/unparseable timestamp."""
    if not value:
        return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value).isoformat()
        except ValueError:
            pass
        for fmt in _TS_FORMATS:
            try:
                return datetime.strptime(value, fmt).isoformat()
            except ValueError:
                continue
    return None


def _domain(url):
    if not url:
        return None
    netloc = urlparse(url).netloc
    return netloc[4:] if netloc.startswith("www.") else netloc or None


def normalize_item(raw: dict, source: str) -> dict:
    """Map one collected item (web result or feishu message) to a unified record."""
    ts = _parse_timestamp(raw.get("date") or raw.get("time") or raw.get("timestamp"))
    channel = raw.get("channel") or raw.get("site") or _domain(raw.get("url")) or source
    meta = dict(raw.get("meta") or {})
    if ts is None:
        meta["ts_missing"] = True
    else:
        meta["ts_source"] = "published"
    return {
        "id": uuid.uuid4().hex,
        "source": source,
        "channel": channel,
        "author": raw.get("author") or "unknown",
        "timestamp": ts,
        "text": (raw.get("text") or raw.get("content") or raw.get("snippet") or "").strip(),
        "url": raw.get("url"),
        "tokens": [],
        "meta": meta,
    }


def normalize(raw_items, source: str) -> list:
    return [normalize_item(item, source) for item in raw_items]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_normalize.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/normalize.py kiro-feedback-skill/tests/test_normalize.py
git commit -m "feat(skill): add record normalization"
```

---

## Task 5: Stats Module

**Files:**
- Create: `kiro-feedback-skill/scripts/stats.py`
- Test: `kiro-feedback-skill/tests/test_stats.py`

These pure functions are the canonical aggregation logic; the frontend JS (Task 10) is a port of them. Keep names/semantics aligned.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_stats.py
from scripts import stats

RECS = [
    {"author": "a", "timestamp": "2026-06-01T10:00:00", "text": "卡顿 卡顿 崩溃", "tokens": []},
    {"author": "a", "timestamp": "2026-06-02T10:00:00", "text": "卡顿 很好", "tokens": []},
    {"author": "b", "timestamp": "2026-06-02T11:00:00", "text": "崩溃 闪退", "tokens": []},
    {"author": "c", "timestamp": "2026-07-01T11:00:00", "text": "很好 点赞", "tokens": []},
]

def test_tokenize_filters_single_chars_and_stopwords():
    toks = stats.tokenize("这个 卡顿 的 问题")
    assert "卡顿" in toks
    assert "的" not in toks  # stopword
    assert all(len(t) >= 2 for t in toks)

def test_add_tokens_populates_in_place():
    recs = [{"text": "卡顿 崩溃", "tokens": []}]
    stats.add_tokens(recs)
    assert recs[0]["tokens"]

def test_term_frequency_top_n():
    recs = [dict(r) for r in RECS]
    stats.add_tokens(recs)
    tf = stats.term_frequency(recs, top_n=2)
    assert tf[0][0] == "卡顿" and tf[0][1] == 3
    assert len(tf) == 2

def test_daily_volume():
    assert stats.daily_volume(RECS) == {"2026-06-01": 1, "2026-06-02": 2, "2026-07-01": 1}

def test_pareto_by_author_sorted_with_cumulative():
    p = stats.pareto_by_author(RECS)
    assert p[0]["author"] == "a" and p[0]["count"] == 2
    assert p[-1]["cum_pct"] == 100.0

def test_mau_distinct_authors_per_month():
    assert stats.mau(RECS) == {"2026-06": 2, "2026-07": 1}

def test_lifespan_first_last_span():
    ls = stats.lifespan(RECS)
    assert ls["a"]["msg_count"] == 2
    assert ls["a"]["span_days"] == 1
    assert ls["c"]["span_days"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_stats.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.stats`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/stats.py
"""Deterministic statistics. Frontend JS mirrors these functions."""
from collections import Counter, defaultdict
from datetime import datetime
import re
import jieba

# Minimal Chinese stopword set; extend as needed.
STOPWORDS = {
    "的", "了", "和", "是", "我", "你", "他", "她", "它", "们", "在", "也",
    "就", "都", "这", "那", "有", "个", "啊", "吧", "吗", "呢", "与", "及",
    "对", "为", "等", "把", "被", "让", "向", "从", "到", "我们", "你们",
}
_NON_WORD = re.compile(r"^[\W\d_]+$", re.UNICODE)


def tokenize(text: str):
    """Jieba tokenization, dropping stopwords, punctuation, and single chars."""
    out = []
    for tok in jieba.cut(text or ""):
        tok = tok.strip()
        if len(tok) < 2 or tok in STOPWORDS or _NON_WORD.match(tok):
            continue
        out.append(tok)
    return out


def add_tokens(records) -> None:
    """Populate record['tokens'] in place."""
    for r in records:
        r["tokens"] = tokenize(r.get("text", ""))


def term_frequency(records, top_n: int = 50):
    counter = Counter()
    for r in records:
        counter.update(r.get("tokens") or [])
    return counter.most_common(top_n)


def _day(ts):
    return ts[:10] if ts else None


def _month(ts):
    return ts[:7] if ts else None


def daily_volume(records):
    counter = Counter(_day(r.get("timestamp")) for r in records if r.get("timestamp"))
    return dict(sorted(counter.items()))


def pareto_by_author(records):
    counter = Counter(r.get("author", "unknown") for r in records)
    ranked = counter.most_common()
    total = sum(counter.values()) or 1
    out, cum = [], 0
    for author, count in ranked:
        cum += count
        out.append({"author": author, "count": count, "cum_pct": round(cum / total * 100, 1)})
    return out


def mau(records):
    buckets = defaultdict(set)
    for r in records:
        m = _month(r.get("timestamp"))
        if m:
            buckets[m].add(r.get("author", "unknown"))
    return {m: len(authors) for m, authors in sorted(buckets.items())}


def lifespan(records):
    by_author = defaultdict(list)
    for r in records:
        ts = r.get("timestamp")
        if ts:
            by_author[r.get("author", "unknown")].append(ts)
    out = {}
    for author, times in by_author.items():
        ds = sorted(datetime.fromisoformat(t) for t in times)
        out[author] = {
            "first": ds[0].isoformat(),
            "last": ds[-1].isoformat(),
            "span_days": (ds[-1] - ds[0]).days,
            "msg_count": len(times),
        }
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_stats.py -v`
Expected: PASS (7 tests). (First jieba call builds its dict cache — allow a few seconds.)

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/stats.py kiro-feedback-skill/tests/test_stats.py
git commit -m "feat(skill): add deterministic stats (tokenize/tf/trend/pareto/mau/lifespan)"
```

---

## Task 6: Feishu Adapter (pluggable interface + JSONL impl)

**Files:**
- Create: `kiro-feedback-skill/scripts/feishu_adapter.py`
- Test: `kiro-feedback-skill/tests/test_feishu_adapter.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_feishu_adapter.py
import json
import pytest
from scripts import feishu_adapter

def test_parse_jsonl(tmp_path):
    p = tmp_path / "chat.jsonl"
    p.write_text(
        json.dumps({"sender": "张三", "time": "2026-06-01 10:00:00", "content": "卡顿", "group": "反馈群"}) + "\n"
        + json.dumps({"sender": "李四", "time": "2026-06-01 10:05:00", "content": "崩溃", "group": "反馈群"}) + "\n",
        encoding="utf-8",
    )
    recs = feishu_adapter.parse_feishu(str(p))
    assert len(recs) == 2
    assert recs[0]["source"] == "feishu"
    assert recs[0]["author"] == "张三"
    assert recs[0]["channel"] == "feishu:反馈群"
    assert recs[0]["text"] == "卡顿"
    assert recs[0]["timestamp"] is not None

def test_unsupported_format_raises(tmp_path):
    p = tmp_path / "chat.docx"
    p.write_text("x", encoding="utf-8")
    with pytest.raises(NotImplementedError):
        feishu_adapter.parse_feishu(str(p))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_feishu_adapter.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.feishu_adapter`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/feishu_adapter.py
"""Feishu chat-export parser.

JSONL/JSON is implemented as the reference format. Other formats (xlsx/csv/txt)
are stubbed with NotImplementedError until a real export sample is provided;
each maps messages to scripts.normalize.normalize_item(raw, "feishu").
"""
import json
from pathlib import Path
from scripts.normalize import normalize_item


def _to_raw(msg: dict) -> dict:
    """Map a Feishu message dict to the normalize_item input shape."""
    group = msg.get("group") or msg.get("chat") or "未知群"
    return {
        "author": msg.get("sender") or msg.get("from") or msg.get("author"),
        "time": msg.get("time") or msg.get("timestamp") or msg.get("date"),
        "content": msg.get("content") or msg.get("text") or "",
        "channel": f"feishu:{group}",
    }


def _parse_jsonl(path: str):
    records = []
    text = Path(path).read_text(encoding="utf-8").strip()
    if text.startswith("["):
        messages = json.loads(text)
    else:
        messages = [json.loads(line) for line in text.splitlines() if line.strip()]
    for msg in messages:
        records.append(normalize_item(_to_raw(msg), "feishu"))
    return records


def parse_feishu(path: str):
    ext = Path(path).suffix.lower()
    if ext in (".jsonl", ".json"):
        return _parse_jsonl(path)
    raise NotImplementedError(
        f"Feishu export format '{ext}' not yet supported. "
        "Provide a sample to implement xlsx/csv/txt parsing."
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_feishu_adapter.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/feishu_adapter.py kiro-feedback-skill/tests/test_feishu_adapter.py
git commit -m "feat(skill): add feishu adapter (jsonl impl + stub others)"
```

---

## Task 7: Preflight Module

**Files:**
- Create: `kiro-feedback-skill/scripts/preflight.py`
- Test: `kiro-feedback-skill/tests/test_preflight.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_preflight.py
from scripts import preflight

def test_missing_deps_detected():
    missing = preflight.check_python_deps(["boto3", "jieba", "definitely_not_installed_xyz"])
    assert missing == ["definitely_not_installed_xyz"]

def test_no_missing_deps():
    assert preflight.check_python_deps(["boto3", "jieba"]) == []

def test_classify_s3_head_error():
    assert preflight.classify_head_error(404) == "missing"
    assert preflight.classify_head_error(403) == "forbidden"
    assert preflight.classify_head_error(301) == "region_mismatch"
    assert preflight.classify_head_error(500) == "error"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_preflight.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.preflight`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/preflight.py
"""Step 0 preflight: python deps, AWS credentials, S3 bucket reachability/write."""
import importlib
import subprocess
import sys
import boto3
from botocore.exceptions import ClientError, NoCredentialsError


def check_python_deps(modules):
    """Return the list of module names that are not importable."""
    missing = []
    for name in modules:
        try:
            importlib.import_module(name)
        except ImportError:
            missing.append(name)
    return missing


def ensure_python_deps(modules) -> bool:
    """pip install any missing modules. Returns True if all present afterward."""
    missing = check_python_deps(modules)
    if not missing:
        return True
    subprocess.run([sys.executable, "-m", "pip", "install", *missing], check=False)
    return check_python_deps(modules) == []


def check_aws_credentials() -> bool:
    try:
        boto3.client("sts").get_caller_identity()
        return True
    except (ClientError, NoCredentialsError):
        return False


def classify_head_error(status_code: int) -> str:
    return {404: "missing", 403: "forbidden", 301: "region_mismatch"}.get(status_code, "error")


def check_s3_bucket(bucket: str, region: str) -> str:
    """Return 'ok' | 'missing' | 'forbidden' | 'region_mismatch' | 'error'."""
    s3 = boto3.client("s3", region_name=region)
    try:
        s3.head_bucket(Bucket=bucket)
        return "ok"
    except ClientError as e:
        code = int(e.response["ResponseMetadata"].get("HTTPStatusCode", 0))
        return classify_head_error(code)


def s3_write_probe(bucket: str, prefix: str, region: str) -> bool:
    """Put a tiny object then delete it to confirm write permission."""
    s3 = boto3.client("s3", region_name=region)
    key = f"{prefix.rstrip('/')}/.preflight"
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=b"ok")
        s3.delete_object(Bucket=bucket, Key=key)
        return True
    except ClientError:
        return False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_preflight.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/preflight.py kiro-feedback-skill/tests/test_preflight.py
git commit -m "feat(skill): add preflight checks (deps/creds/s3)"
```

---

## Task 8: Publish to S3

**Files:**
- Create: `kiro-feedback-skill/scripts/publish_s3.py`
- Test: `kiro-feedback-skill/tests/test_publish_s3.py`

- [ ] **Step 1: Write the failing test** (uses botocore Stubber — no network)

```python
# tests/test_publish_s3.py
import boto3
from botocore.stub import Stubber
from scripts import publish_s3

def test_build_key_slugifies_and_dates():
    key = publish_s3.build_key("reports", "舆情 报告/v1", "20260608-120000")
    assert key.startswith("reports/")
    assert key.endswith("-20260608-120000.html")
    assert " " not in key and "/" not in key.split("reports/")[1]

def test_upload_sets_html_content_type():
    client = boto3.client("s3", region_name="us-west-2")
    stub = Stubber(client)
    stub.add_response("put_object", {}, {
        "Bucket": "b", "Key": "k.html", "Body": b"<html></html>",
        "ContentType": "text/html; charset=utf-8",
    })
    with stub:
        publish_s3.upload_bytes(client, "b", "k.html", b"<html></html>")
    stub.assert_no_pending_responses()

def test_presign_returns_url():
    client = boto3.client("s3", region_name="us-west-2",
                          aws_access_key_id="x", aws_secret_access_key="y")
    url = publish_s3.presign(client, "b", "k.html", 3600)
    assert url.startswith("https://")
    assert "X-Amz-Expires=3600" in url
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_publish_s3.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.publish_s3`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/publish_s3.py
"""Upload the report to S3 and return a presigned GET URL."""
import re
from pathlib import Path
import boto3

_SLUG = re.compile(r"[^\w一-鿿-]+")


def build_key(prefix: str, subject: str, stamp: str) -> str:
    slug = _SLUG.sub("-", subject).strip("-") or "report"
    return f"{prefix.rstrip('/')}/{slug}-{stamp}.html"


def upload_bytes(client, bucket: str, key: str, body: bytes) -> None:
    client.put_object(Bucket=bucket, Key=key, Body=body,
                      ContentType="text/html; charset=utf-8")


def presign(client, bucket: str, key: str, expiry: int) -> str:
    return client.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expiry)


def publish(report_path: str, config: dict, subject: str, stamp: str) -> str:
    """Upload report file and return a presigned URL (orchestration entrypoint)."""
    client = boto3.client("s3", region_name=config["region"])
    key = build_key(config["prefix"], subject, stamp)
    upload_bytes(client, config["bucket"], key, Path(report_path).read_bytes())
    return presign(client, config["bucket"], key, config["presign_expiry_seconds"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_publish_s3.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/publish_s3.py kiro-feedback-skill/tests/test_publish_s3.py
git commit -m "feat(skill): add S3 upload + presigned URL"
```

---

## Task 9: Build Report (template injection)

**Files:**
- Create: `kiro-feedback-skill/scripts/build_report.py`
- Test: `kiro-feedback-skill/tests/test_build_report.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_build_report.py
import json
from scripts import build_report

TEMPLATE = '<html><script>const DATA = /*__DATA__*/ null;</script></html>'

def test_inject_replaces_marker(tmp_path):
    tmpl = tmp_path / "t.tmpl"; tmpl.write_text(TEMPLATE, encoding="utf-8")
    enriched = tmp_path / "e.json"
    payload = {"meta": {"subject": "测试"}, "records": [{"id": "1"}]}
    enriched.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "report.html"
    build_report.build(str(enriched), str(tmpl), str(out))
    html = out.read_text(encoding="utf-8")
    assert "/*__DATA__*/" not in html
    assert '"subject": "测试"' in html or '"subject":"测试"' in html
    # data must be valid JS object literal embedded
    assert "const DATA =" in html

def test_marker_missing_raises(tmp_path):
    tmpl = tmp_path / "t.tmpl"; tmpl.write_text("<html>no marker</html>", encoding="utf-8")
    enriched = tmp_path / "e.json"; enriched.write_text("{}", encoding="utf-8")
    out = tmp_path / "r.html"
    try:
        build_report.build(str(enriched), str(tmpl), str(out))
        assert False, "expected ValueError"
    except ValueError:
        pass
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiro-feedback-skill && pytest tests/test_build_report.py -v`
Expected: FAIL — `ModuleNotFoundError: scripts.build_report`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/build_report.py
"""Inject the enriched dataset into the HTML template to produce a self-contained report."""
import json
from pathlib import Path

MARKER = "/*__DATA__*/"


def build(enriched_path: str, template_path: str, out_path: str) -> str:
    template = Path(template_path).read_text(encoding="utf-8")
    if MARKER not in template:
        raise ValueError(f"template missing data marker {MARKER!r}")
    data = Path(enriched_path).read_text(encoding="utf-8").strip()
    # Guard against closing the inline <script> if any text contains it.
    data = json.dumps(json.loads(data), ensure_ascii=False).replace("</", "<\\/")
    # Replace marker (and the following ' null'/'{}' placeholder up to ';').
    head, _, tail = template.partition(MARKER)
    after = tail.split(";", 1)
    rest = after[1] if len(after) > 1 else ""
    html = f"{head}{data};{rest}"
    Path(out_path).write_text(html, encoding="utf-8")
    return out_path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiro-feedback-skill && pytest tests/test_build_report.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add kiro-feedback-skill/scripts/build_report.py kiro-feedback-skill/tests/test_build_report.py
git commit -m "feat(skill): add report template injection"
```

---

## Task 10: Report HTML Template

**Files:**
- Create: `kiro-feedback-skill/templates/report.html.tmpl`

This is the self-contained frontend. JS aggregation mirrors `scripts/stats.py`. Not unit-tested in Python; verified by building a report from fixture data and loading it (Step 3 below uses the `webapp-testing` skill / a browser).

- [ ] **Step 1: Write the template**

Create `kiro-feedback-skill/templates/report.html.tmpl` with this exact content:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>舆情分析报告</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.0/echarts.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts-wordcloud/2.1.0/echarts-wordcloud.min.js"></script>
<style>
  :root { --bg:#0f1117; --card:#1a1d27; --fg:#e6e8ee; --muted:#8b90a0; --accent:#4f8cff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:20px 28px; border-bottom:1px solid #262a36; }
  header h1 { margin:0 0 6px; font-size:20px; }
  header .meta { color:var(--muted); font-size:13px; }
  .controls { display:flex; gap:16px; flex-wrap:wrap; align-items:center; padding:16px 28px; background:var(--card); border-bottom:1px solid #262a36; position:sticky; top:0; z-index:10; }
  .controls label { color:var(--muted); margin-right:6px; }
  .controls input, .controls select { background:#0f1117; color:var(--fg); border:1px solid #2c3142; border-radius:6px; padding:6px 8px; }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:16px; padding:20px 28px; }
  .card { background:var(--card); border:1px solid #262a36; border-radius:10px; padding:16px; }
  .card h3 { margin:0 0 10px; font-size:15px; }
  .chart { width:100%; height:300px; }
  .synth { padding:0 28px 28px; }
  .synth .card { margin-bottom:16px; }
  .pill { display:inline-block; background:#222838; color:#9fb4e0; border-radius:12px; padding:2px 10px; margin:2px; font-size:12px; }
  .note { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1 id="subject">舆情分析报告</h1>
  <div class="meta" id="meta"></div>
</header>
<div class="controls">
  <span><label>起</label><input type="date" id="from"/></span>
  <span><label>止</label><input type="date" id="to"/></span>
  <span><label>渠道</label><select id="channel"><option value="">全部</option></select></span>
  <span class="note" id="count"></span>
</div>
<div class="grid">
  <div class="card"><h3>高频词</h3><div class="chart" id="c-wordcloud"></div></div>
  <div class="card"><h3>主题占比</h3><div class="chart" id="c-topic"></div></div>
  <div class="card"><h3>情感分布</h3><div class="chart" id="c-sentiment"></div></div>
  <div class="card"><h3>发文量趋势</h3><div class="chart" id="c-trend"></div></div>
  <div class="card"><h3>痛点信号（按严重度/类型）</h3><div class="chart" id="c-painpoint"></div></div>
  <div class="card"><h3>帕累托二八（按作者/账号）</h3><div class="chart" id="c-pareto"></div></div>
  <div class="card"><h3>MAU（活跃账号/月，口径：按账号近似）</h3><div class="chart" id="c-mau"></div></div>
  <div class="card"><h3>留存 / 生命周期（账号活跃跨度分布）</h3><div class="chart" id="c-lifespan"></div></div>
</div>
<div class="synth">
  <div class="card"><h3>JTBD（用户任务）<span class="note">— 全量洞察区，不随筛选变化</span></h3><div id="s-jtbd"></div></div>
  <div class="card"><h3>Kano 分类<span class="note">— 全量</span></h3><div id="s-kano"></div></div>
  <div class="card"><h3>主题建模解读<span class="note">— 全量</span></h3><div id="s-topics"></div></div>
</div>

<script>const DATA = /*__DATA__*/ {"meta":{},"records":[],"synthesis":{"jtbd":[],"kano":[],"topics":[]}};</script>
<script>
// ---- aggregation engine (mirror of scripts/stats.py) ----
const recs = DATA.records || [];
const day = ts => ts ? ts.slice(0,10) : null;
const month = ts => ts ? ts.slice(0,7) : null;

function filtered() {
  const f = document.getElementById('from').value;
  const t = document.getElementById('to').value;
  const ch = document.getElementById('channel').value;
  return recs.filter(r => {
    if (ch && r.channel !== ch) return false;
    const d = day(r.timestamp);
    if (f && (!d || d < f)) return false;
    if (t && (!d || d > t)) return false;
    return true;
  });
}
function termFreq(rs, n=80){ const m=new Map(); rs.forEach(r=>(r.tokens||[]).forEach(t=>m.set(t,(m.get(t)||0)+1))); return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n); }
function countBy(rs, fn){ const m=new Map(); rs.forEach(r=>{const k=fn(r); if(k!=null) m.set(k,(m.get(k)||0)+1);}); return m; }
function dailyVolume(rs){ const m=countBy(rs,r=>day(r.timestamp)); return [...m.entries()].sort(); }
function sentimentDist(rs){ return countBy(rs, r=>r.labels&&r.labels.sentiment?r.labels.sentiment.label:null); }
function topicDist(rs){ return countBy(rs, r=>r.labels?r.labels.topic:null); }
function painpointDist(rs){ const m=new Map(); rs.forEach(r=>{const p=r.labels&&r.labels.painpoint; if(p&&p.flag){const k=(p.severity||'unknown')+'·'+(p.type||'其他'); m.set(k,(m.get(k)||0)+1);}}); return m; }
function pareto(rs){ const m=countBy(rs,r=>r.author||'unknown'); const ranked=[...m.entries()].sort((a,b)=>b[1]-a[1]); const total=ranked.reduce((s,x)=>s+x[1],0)||1; let cum=0; return ranked.map(([a,c])=>{cum+=c; return {author:a,count:c,cum:Math.round(cum/total*1000)/10};}); }
function mau(rs){ const b=new Map(); rs.forEach(r=>{const mo=month(r.timestamp); if(mo){if(!b.has(mo))b.set(mo,new Set()); b.get(mo).add(r.author||'unknown');}}); return [...b.entries()].sort().map(([m,s])=>[m,s.size]); }
function lifespanBuckets(rs){ const by=new Map(); rs.forEach(r=>{if(r.timestamp){if(!by.has(r.author))by.set(r.author,[]); by.get(r.author).push(r.timestamp);}}); const buckets={'1天':0,'2-7天':0,'8-30天':0,'30天+':0}; by.forEach(times=>{const ds=times.map(t=>new Date(t)).sort((a,b)=>a-b); const span=(ds[ds.length-1]-ds[0])/86400000; if(span<1)buckets['1天']++; else if(span<=7)buckets['2-7天']++; else if(span<=30)buckets['8-30天']++; else buckets['30天+']++;}); return buckets; }

// ---- chart helpers ----
const charts = {};
function chart(id){ if(!charts[id]) charts[id]=echarts.init(document.getElementById(id)); return charts[id]; }
const DARK = {textStyle:{color:'#e6e8ee'}, backgroundColor:'transparent'};
const SENT_COLOR = {pos:'#3fb950', neu:'#8b90a0', neg:'#f85149'};

function render(){
  const rs = filtered();
  document.getElementById('count').textContent = `当前 ${rs.length} 条 / 共 ${recs.length} 条`;

  chart('c-wordcloud').setOption({...DARK, tooltip:{}, series:[{type:'wordCloud', gridSize:8, sizeRange:[12,52], rotationRange:[0,0], data: termFreq(rs).map(([name,value])=>({name,value}))}]});

  const td=[...topicDist(rs).entries()].map(([name,value])=>({name,value}));
  chart('c-topic').setOption({...DARK, tooltip:{trigger:'item'}, series:[{type:'pie', radius:['40%','70%'], data:td}]});

  const sd=sentimentDist(rs);
  chart('c-sentiment').setOption({...DARK, tooltip:{trigger:'item'}, series:[{type:'pie', radius:'65%', data:[...sd.entries()].map(([k,v])=>({name:k,value:v,itemStyle:{color:SENT_COLOR[k]}}))}]});

  const dv=dailyVolume(rs);
  chart('c-trend').setOption({...DARK, tooltip:{trigger:'axis'}, xAxis:{type:'category', data:dv.map(x=>x[0])}, yAxis:{type:'value'}, series:[{type:'line', smooth:true, areaStyle:{}, data:dv.map(x=>x[1])}]});

  const pp=[...painpointDist(rs).entries()].sort((a,b)=>b[1]-a[1]);
  chart('c-painpoint').setOption({...DARK, tooltip:{trigger:'axis'}, grid:{left:120}, xAxis:{type:'value'}, yAxis:{type:'category', data:pp.map(x=>x[0])}, series:[{type:'bar', data:pp.map(x=>x[1]), itemStyle:{color:'#f0883e'}}]});

  const pa=pareto(rs);
  chart('c-pareto').setOption({...DARK, tooltip:{trigger:'axis'}, xAxis:{type:'category', data:pa.map(x=>x.author)}, yAxis:[{type:'value',name:'条数'},{type:'value',name:'累计%',max:100}], series:[{type:'bar', data:pa.map(x=>x.count)},{type:'line', yAxisIndex:1, data:pa.map(x=>x.cum), itemStyle:{color:'#f85149'}}]});

  const ma=mau(rs);
  chart('c-mau').setOption({...DARK, tooltip:{trigger:'axis'}, xAxis:{type:'category', data:ma.map(x=>x[0])}, yAxis:{type:'value'}, series:[{type:'bar', data:ma.map(x=>x[1]), itemStyle:{color:'#4f8cff'}}]});

  const lb=lifespanBuckets(rs);
  chart('c-lifespan').setOption({...DARK, tooltip:{trigger:'item'}, series:[{type:'pie', radius:'65%', data:Object.entries(lb).map(([name,value])=>({name,value}))}]});
}

// ---- synthesis (static) ----
function renderSynth(){
  const s = DATA.synthesis || {};
  document.getElementById('s-jtbd').innerHTML = (s.jtbd||[]).map(j=>`<p><b>${j.job}</b><br><span class="note">${(j.evidence||[]).join(' / ')}</span></p>`).join('') || '<span class="note">无</span>';
  document.getElementById('s-kano').innerHTML = (s.kano||[]).map(k=>`<span class="pill">${k.feature} · ${k.category}</span>`).join('') || '<span class="note">无</span>';
  document.getElementById('s-topics').innerHTML = (s.topics||[]).map(t=>`<p><b>${t.name}</b> — ${t.summary}<br>${(t.keywords||[]).map(w=>`<span class="pill">${w}</span>`).join('')}</p>`).join('') || '<span class="note">无</span>';
}

// ---- init ----
function init(){
  const m = DATA.meta || {};
  document.getElementById('subject').textContent = (m.subject||'舆情分析报告');
  document.getElementById('meta').textContent = [m.range, m.sources, m.coverage].filter(Boolean).join(' · ');
  const channels = [...new Set(recs.map(r=>r.channel))].sort();
  const sel = document.getElementById('channel');
  channels.forEach(c=>{const o=document.createElement('option'); o.value=c; o.textContent=c; sel.appendChild(o);});
  const dates = recs.map(r=>day(r.timestamp)).filter(Boolean).sort();
  if(dates.length){ document.getElementById('from').value=dates[0]; document.getElementById('to').value=dates[dates.length-1]; }
  ['from','to','channel'].forEach(id=>document.getElementById(id).addEventListener('change', render));
  window.addEventListener('resize', ()=>Object.values(charts).forEach(c=>c.resize()));
  renderSynth(); render();
}
init();
</script>
</body>
</html>
```

- [ ] **Step 2: Build a report from fixture data**

Create a throwaway fixture and build (run from `kiro-feedback-skill/`):

```bash
cd kiro-feedback-skill
mkdir -p data
python - <<'PY'
import json, os
os.makedirs('data', exist_ok=True)
recs = [
  {'id':'1','source':'web','channel':'weibo','author':'a','timestamp':'2026-06-01T10:00:00',
   'text':'卡顿 崩溃','tokens':['卡顿','崩溃'],
   'labels':{'sentiment':{'label':'neg','score':-0.7},'topic':'性能','painpoint':{'flag':True,'severity':'high','type':'故障'}}},
  {'id':'2','source':'web','channel':'zhihu','author':'b','timestamp':'2026-06-02T10:00:00',
   'text':'很好 点赞','tokens':['很好','点赞'],
   'labels':{'sentiment':{'label':'pos','score':0.8},'topic':'体验','painpoint':{'flag':False}}},
]
data = {'meta':{'subject':'演示产品','range':'2026-06','sources':'web','coverage':'覆盖率 100%'},
        'records':recs,
        'synthesis':{'jtbd':[{'job':'快速反馈问题','evidence':['卡顿','崩溃']}],
                     'kano':[{'feature':'稳定性','category':'must-be'}],
                     'topics':[{'name':'性能','summary':'卡顿与崩溃集中','keywords':['卡顿','崩溃']}]}}
open('data/enriched_demo.json','w',encoding='utf-8').write(json.dumps(data, ensure_ascii=False))
print('fixture written')
PY
python -c "from scripts.build_report import build; build('data/enriched_demo.json','templates/report.html.tmpl','data/report_demo.html'); print('built')"
```
Expected: prints `fixture written` then `built`; `data/report_demo.html` exists, contains `演示产品`, and has no `/*__DATA__*/`.

- [ ] **Step 3: Verify in a browser** (use the `webapp-testing` skill)

Open `data/report_demo.html` and confirm: title shows "演示产品", 8 charts render, changing the date range updates charts, the JTBD/Kano/topics synthesis section shows content. Capture a screenshot.

Expected: all 8 charts draw; date filter re-aggregates; synthesis section is populated and does not change with the filter.

- [ ] **Step 4: Commit**

```bash
git add kiro-feedback-skill/templates/report.html.tmpl
git commit -m "feat(skill): add self-contained report template with ECharts + JS aggregation"
```

---

## Task 11: SKILL.md Orchestrator

**Files:**
- Create: `kiro-feedback-skill/SKILL.md`

This is the entrypoint Claude follows. It owns the LLM subagent fan-out (B0/B2/B3); Python does only deterministic work.

- [ ] **Step 1: Write `SKILL.md`** with this content:

````markdown
---
name: sentiment-analysis
description: Collect multi-channel public-opinion/feedback data (web search + Feishu exports), run hybrid statistical + LLM analysis, and publish an interactive HTML report to S3 behind a presigned URL. Use when the user asks to analyze 舆情/feedback/reviews for a product or topic, or mentions "舆情分析", "feedback report", or analyzing collected chat/social data.
---

# 舆情分析 Skill

Hybrid pipeline: deterministic stats in Python, semantic labeling/synthesis via fanned-out subagents, output a self-contained interactive HTML report published to S3.

All scripts are run from the skill directory and import as `python -m scripts.<module>`. Runtime artifacts go under `data/`.

## Step 0 — Preflight (gate; do not proceed unless all pass)

1. **Config:** Run `python -c "from scripts.config import load_config; print(load_config())"`.
   - If `None` (first use): ask the user for **bucket name**, **key prefix**, **region**, and **presign expiry** (default 604800s = 7 days). Save via `scripts.config.save_config`.
2. **Python deps:** `python -c "from scripts.preflight import ensure_python_deps; print(ensure_python_deps(['boto3','jieba','jsonschema']))"` — must print `True`.
3. **AWS creds:** `python -c "from scripts.preflight import check_aws_credentials; print(check_aws_credentials())"` — must print `True`, else tell the user to configure AWS credentials and stop.
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
`python -c "from scripts.build_report import build; build('data/enriched_dataset.json','templates/report.html.tmpl','data/report.html')"`

## Step 8 — Publish

`python -c "from scripts.publish_s3 import publish; from scripts.config import load_config; import datetime; print(publish('data/report.html', load_config(), '<subject>', datetime.datetime.now().strftime('%Y%m%d-%H%M%S')))"`
Return the printed presigned URL to the user.

## Edge cases

- Web zero-results / fetch failures → skip + count; note coverage in `meta`.
- Missing timestamps → trend/MAU bucket them as "未知".
- Oversized corpus → cap/sample batches; note sampling口径 in `meta`.
- Topic not in fixed taxonomy → "其他".
````

- [ ] **Step 2: Sanity-check the orchestration commands**

Run each Step 0 python one-liner from `kiro-feedback-skill/` to confirm imports resolve (config may print `None`, that's fine):

```bash
cd kiro-feedback-skill
python -c "from scripts.config import load_config; print('config ok', load_config())"
python -c "from scripts.preflight import check_python_deps; print('preflight ok', check_python_deps(['boto3','jieba','jsonschema']))"
python -c "from scripts import normalize, stats, feishu_adapter, models, build_report, publish_s3; print('all imports ok')"
```
Expected: all three print without error; last prints `all imports ok`.

- [ ] **Step 3: Commit**

```bash
git add kiro-feedback-skill/SKILL.md
git commit -m "feat(skill): add SKILL.md orchestrator"
```

---

## Task 12: Full Suite + README Sanity

**Files:**
- Create: `kiro-feedback-skill/README.md`

- [ ] **Step 1: Run the entire test suite**

Run: `cd kiro-feedback-skill && pytest -v`
Expected: all tests pass (config 2, models 3, normalize 4, stats 7, feishu 2, preflight 3, publish_s3 3, build_report 2 = 26 tests).

- [ ] **Step 2: Write `README.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add kiro-feedback-skill/README.md
git commit -m "docs(skill): add README"
```

---

## Self-Review

**Spec coverage (vs design doc §3 methods):**
- 高频词 → `stats.term_frequency` + wordcloud (Task 5, 10) ✓
- 主题聚类 → B0 taxonomy + topic labels + topic pie (Task 4-rubric, 5-B2, 10) ✓
- 痛点挖掘 → B2 painpoint + painpoint bar (Task 5-B2, 10) ✓
- 活跃趋势 MAU/消息量 → `daily_volume`, `mau` (Task 5, 10) ✓
- 帕累托二八 → `pareto_by_author` (Task 5, 10) ✓
- 留存/生命周期 → `lifespan` + lifespan buckets (Task 5, 10) ✓
- 情感 → B2 sentiment + sentiment pie (Task 5-B2, 10) ✓
- 主题建模 → B3 synthesis topics (static区) (Task 6-B3, 10) ✓
- JTBD-Kano → B3 synthesis (static区) (Task 6-B3, 10) ✓
- Step 0 preflight (deps/creds/S3) → Task 7, SKILL.md ✓
- S3 + presigned URL → Task 8, SKILL.md ✓
- Feishu pluggable adapter → Task 6 ✓
- Date/channel filtering → Task 10 JS ✓
- Self-contained single-file (presign constraint) → Task 9 inline + Task 10 CDN ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete. Frontend JS is full; SKILL.md commands are concrete one-liners.

**Type consistency:** Record dict shape (`id/source/channel/author/timestamp/text/url/tokens/meta/labels`) is consistent across `normalize`, `stats`, `feishu_adapter`, schemas, and the template JS. Stats function names (`term_frequency/daily_volume/pareto_by_author/mau/lifespan`) match their JS ports (`termFreq/dailyVolume/pareto/mau/lifespanBuckets` — JS intentionally renamed but semantically aligned; documented in Task 10). `build_report.build`, `publish_s3.publish`, `config.load_config/save_config`, `models.validate_labels/validate_synthesis`, `preflight.*` signatures are consistent between definition and caller (SKILL.md).
