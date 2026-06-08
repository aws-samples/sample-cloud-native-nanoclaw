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

# Common English function words, lower-cased. Mixed CN/EN corpora (e.g. web
# 舆情 of an English-named product) otherwise let these dominate term frequency.
EN_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "as", "of",
    "to", "in", "on", "at", "by", "for", "with", "from", "into", "over",
    "under", "out", "up", "down", "off", "about", "after", "before",
    "between", "per", "via", "vs", "is", "are", "was", "were", "be", "been",
    "being", "am", "do", "does", "did", "has", "have", "had", "will", "would",
    "can", "could", "should", "may", "might", "must", "shall", "not", "no",
    "yes", "so", "also", "just", "more", "most", "some", "all", "any", "each",
    "how", "why", "what", "when", "which", "who", "whom", "whose", "where",
    "this", "that", "these", "those", "it", "its", "i", "me", "my", "we",
    "our", "us", "you", "your", "they", "them", "their", "he", "him", "his",
    "she", "her", "get", "got", "new", "now",
}
_NON_WORD = re.compile(r"^[\W\d_]+$", re.UNICODE)


def tokenize(text: str):
    """Jieba tokenization, dropping stopwords, punctuation, and single chars.

    Stopword removal covers both the Chinese set (exact match) and common
    English function words (case-insensitive), so mixed CN/EN corpora work.
    """
    out = []
    for tok in jieba.cut(text or ""):
        tok = tok.strip()
        if (len(tok) < 2 or tok in STOPWORDS or tok.lower() in EN_STOPWORDS
                or _NON_WORD.match(tok)):
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
