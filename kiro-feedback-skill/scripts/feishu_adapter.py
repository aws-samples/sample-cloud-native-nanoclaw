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
