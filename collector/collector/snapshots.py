"""Page images and highlight boxes, so the website can show each value's source.

For every published value the collector renders the datasheet page it came
from (once per page and revision) and works out where the value's row sits on
that page, using the word positions poppler reports (pdftotext -bbox-layout).
The site draws a highlight box over the image at those coordinates.

Coordinates are stored as fractions of the page size, so the image can be
shown at any size. If a row can't be located, the page image is still shown,
just without a box: a missing highlight is better than a wrong one.
"""

from __future__ import annotations

import html
import logging
import re
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .store import Catalog
from .verify import compact

log = logging.getLogger("collector")

RENDER_DPI = 100
JPEG_QUALITY = 80


@dataclass
class Line:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str

    @property
    def yc(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def xc(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def height(self) -> float:
        return self.y1 - self.y0


_LINE = re.compile(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>', re.S)
_WORD = re.compile(r"<word[^>]*>(.*?)</word>", re.S)
_PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)"')


@lru_cache(maxsize=64)
def page_layout(pdf: str, page: int) -> tuple[float, float, tuple[Line, ...]]:
    """(width, height, lines) of one page, in PDF points."""
    result = subprocess.run(["pdftotext", "-f", str(page), "-l", str(page), "-bbox-layout", pdf, "-"],
                            capture_output=True, timeout=60)
    text = result.stdout.decode("utf-8", errors="replace")
    size = _PAGE.search(text)
    if not size:
        return 0.0, 0.0, ()
    lines = []
    for x0, y0, x1, y1, body in _LINE.findall(text):
        words = " ".join(html.unescape(w) for w in _WORD.findall(body))
        lines.append(Line(float(x0), float(y0), float(x1), float(y1), words))
    return float(size.group(1)), float(size.group(2)), tuple(lines)


def _label_of(spec: dict) -> str:
    evidence = spec.get("evidence", "")
    if " — " in evidence:                       # extractor evidence: "Label — MODEL: cell"
        return evidence.split(" — ", 1)[0]
    value = str(spec.get("value", ""))
    number = re.search(r"\d[\d.,]*", value)
    if number:
        idx = evidence.find(number.group(0))
        if idx > 3:
            return evidence[:idx]
    return " ".join(evidence.split()[:4])


def _value_key(spec: dict) -> str:
    value = str(spec.get("value", ""))
    number = re.search(r"\d[\d.]*", value.replace(",", ""))
    return compact(number.group(0) if number else value)[:12]


def locate(spec: dict, width: float, height: float, lines: tuple[Line, ...], model: str | None = None) -> dict | None:
    """Find the value's row (and, in model-column tables, its cell). Returns fractional boxes."""
    label = compact(_label_of(spec))[:28]
    label = re.sub(r"\[\d+\]$", "", label)
    if len(label) < 4 or not width:
        return None
    label_lines = [ln for ln in lines if label in compact(ln.text) or (len(compact(ln.text)) >= 6 and compact(ln.text) in label)]
    if not label_lines:
        return None
    key = _value_key(spec)
    evidence = compact(spec.get("evidence", ""))
    from_table = " — " in spec.get("evidence", "")
    best = None
    for lab in label_lines:
        h = max(lab.height, 6)
        tol = h * 0.6
        # Lines on the label's row, ignoring group labels to its left (e.g. "CONTROL").
        same_row = [ln for ln in lines if abs(ln.yc - lab.yc) <= tol and ln.x1 > lab.x0 - 2 and ln.x0 >= lab.x0 - 2]
        if not from_table:
            # Hand-reviewed values quote the datasheet: keep only lines that are part of the quote.
            quoted = [ln for ln in lines if ln is not lab and len(compact(ln.text)) >= 2 and compact(ln.text) in evidence
                      and lab.y0 - 1.2 * h <= ln.yc <= lab.y1 + 3.2 * h and ln.x0 >= lab.x0 - 2]
            same_row = [lab] + quoted
            has_value = [ln for ln in quoted if key and key in compact(ln.text)] or \
                        ([lab] if key and key in compact(lab.text) else [])
        else:
            has_value = [ln for ln in same_row if key and key in compact(ln.text)]
            if not has_value:
                # Value wrapped onto the line above or below the label.
                near = [ln for ln in lines if key and key in compact(ln.text) and 0 < abs(ln.yc - lab.yc) <= 2.6 * h
                        and ln.x0 >= lab.x0 - 2]
                if near:
                    nearest = min(near, key=lambda ln: abs(ln.yc - lab.yc))
                    same_row = same_row + [ln for ln in lines if abs(ln.yc - nearest.yc) <= tol and ln.x0 >= lab.x0 - 2]
                    has_value = [nearest]
        score = (1 if has_value else 0, len(same_row) if not from_table else 0, -abs(lab.x0))
        if best is None or score > best[0]:
            best = (score, lab, same_row, has_value)
    if best is None:
        return None
    _, lab, row, values = best
    x0 = min(ln.x0 for ln in row); x1 = max(ln.x1 for ln in row)
    y0 = min(ln.y0 for ln in row); y1 = max(ln.y1 for ln in row)
    pad = 1.5
    box = {"row": [round((x0 - pad) / width, 4), round((y0 - pad) / height, 4),
                   round((x1 + pad) / width, 4), round((y1 + pad) / height, 4)]}

    if model and values:
        header = [ln for ln in lines if re.search(rf"(?<![\w-]){re.escape(model)}(?![\w-])", ln.text)]
        if header:
            mx = _word_center(header[0], model)
            cell = min(values, key=lambda ln: abs(ln.xc - mx))
            box["cell"] = [round((cell.x0 - pad) / width, 4), round((cell.y0 - pad) / height, 4),
                           round((cell.x1 + pad) / width, 4), round((cell.y1 + pad) / height, 4)]
    return box


def _word_center(line: Line, word: str) -> float:
    """Approximate x-centre of a word within a line (lines hold several words)."""
    idx = line.text.find(word)
    if idx < 0 or not line.text:
        return line.xc
    frac = (idx + len(word) / 2) / len(line.text)
    return line.x0 + frac * (line.x1 - line.x0)


def render_page(pdf: Path, page: int, target: Path) -> bool:
    if target.exists():
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    stem = target.with_suffix("")
    result = subprocess.run(
        ["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(RENDER_DPI), "-jpeg",
         "-jpegopt", f"quality={JPEG_QUALITY},optimize=y", "-singlefile", str(pdf), str(stem)],
        capture_output=True, timeout=120)
    return result.returncode == 0 and target.exists()


def backfill(catalog: Catalog) -> int:
    """Add or refresh the page image and highlight for every value that needs one."""
    revisions = {rev["sha256"]: rev for doc in catalog.documents for rev in doc["revisions"]}
    done = 0
    for spec in catalog.specs:
        rev = revisions.get(spec.get("revision"))
        page = spec.get("page")
        if not rev or not page:
            continue
        current = spec.get("highlight") or {}
        if current.get("revision") == rev["sha256"] and current.get("page") == page:
            continue
        pdf = catalog.datasheet_path(rev["file"])
        if not pdf.exists():
            continue
        relative = f"{str(Path(rev['file']).parent)}/page-{page}.jpg"
        try:
            if not render_page(pdf, page, catalog.root / relative):
                continue
            width, height, lines = page_layout(str(pdf), page)
            box = locate(spec, width, height, lines, (spec.get("extractor") or {}).get("model"))
        except Exception:  # a highlight is a nice-to-have; never fail the run over one
            log.exception("Could not locate %s on its page", spec.get("id"))
            box = None
        spec["highlight"] = {"revision": rev["sha256"], "page": page, "image": relative, **(box or {})}
        done += 1
    if done:
        log.info("Page images and highlights updated for %d value(s)", done)
    return done
