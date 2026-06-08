"""Schema loading + validation for subagent outputs."""
import json
from pathlib import Path
from jsonschema import validate, ValidationError  # re-exported

RUBRIC_DIR = Path(__file__).resolve().parent.parent / "rubric"

_LABEL_SCHEMA = json.loads((RUBRIC_DIR / "label.schema.json").read_text(encoding="utf-8"))
_SYNTH_SCHEMA = json.loads((RUBRIC_DIR / "synth.schema.json").read_text(encoding="utf-8"))


def validate_labels(labels) -> None:
    """Raise jsonschema.ValidationError if B2 label output is malformed."""
    validate(instance=labels, schema=_LABEL_SCHEMA)


def validate_synthesis(synth) -> None:
    """Raise jsonschema.ValidationError if B3 synthesis output is malformed."""
    validate(instance=synth, schema=_SYNTH_SCHEMA)
