"""Inject the enriched dataset into the HTML template to produce a self-contained report."""
import json
from pathlib import Path

MARKER = "/*__DATA__*/"


def build(enriched_path: str, template_path: str, out_path: str) -> str:
    template = Path(template_path).read_text(encoding="utf-8")
    if MARKER not in template:
        raise ValueError(f"template missing data marker {MARKER!r}")
    data = Path(enriched_path).read_text(encoding="utf-8").strip()
    # Guard against closing the inline <script> if any text contains it.
    data = json.dumps(json.loads(data), ensure_ascii=False).replace("</", "<\\/")
    # Replace marker (and the following ' null'/'{}' placeholder up to ';').
    head, _, tail = template.partition(MARKER)
    after = tail.split(";", 1)
    rest = after[1] if len(after) > 1 else ""
    html = f"{head}{data};{rest}"
    Path(out_path).write_text(html, encoding="utf-8")
    return out_path
