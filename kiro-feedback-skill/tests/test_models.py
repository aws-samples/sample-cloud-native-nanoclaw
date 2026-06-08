import pytest
from scripts import models

def test_validate_labels_accepts_valid():
    labels = [{
        "id": "abc",
        "sentiment": {"label": "neg", "score": -0.7},
        "topic": "性能卡顿",
        "painpoint": {"flag": True, "severity": "high", "type": "故障"}
    }]
    models.validate_labels(labels)  # should not raise

def test_validate_labels_rejects_bad_sentiment():
    bad = [{"id": "x", "sentiment": {"label": "angry", "score": 0},
            "topic": "t", "painpoint": {"flag": False}}]
    with pytest.raises(models.ValidationError):
        models.validate_labels(bad)

def test_validate_synthesis_accepts_valid():
    synth = {"jtbd": [{"job": "j", "evidence": ["e"]}],
             "kano": [{"feature": "f", "category": "must-be"}],
             "topics": [{"name": "n", "summary": "s"}]}
    models.validate_synthesis(synth)  # should not raise
