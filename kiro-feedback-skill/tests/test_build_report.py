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
