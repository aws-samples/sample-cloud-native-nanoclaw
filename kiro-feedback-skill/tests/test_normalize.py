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
