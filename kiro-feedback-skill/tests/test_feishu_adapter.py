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
