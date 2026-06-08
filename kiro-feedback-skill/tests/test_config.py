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
    assert json.loads(path.read_text(encoding="utf-8"))["bucket"] == "my-bucket"
