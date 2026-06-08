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
