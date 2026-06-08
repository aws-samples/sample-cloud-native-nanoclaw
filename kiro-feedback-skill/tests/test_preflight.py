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
