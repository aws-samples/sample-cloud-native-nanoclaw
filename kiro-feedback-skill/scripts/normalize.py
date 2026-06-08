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
