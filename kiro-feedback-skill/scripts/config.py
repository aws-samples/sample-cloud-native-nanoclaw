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
