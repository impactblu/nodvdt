"""Rules-based extraction of specification values from datasheet PDFs.

No AI is involved. The extractor reads the PDF as laid-out text (pdftotext
-layout keeps the table columns lined up) and understands three common
datasheet layouts:

1. Model-column tables (e.g. Power Electronics): a header row names several
   models, and each specification row has one cell per model. Merged cells that
   span several columns are assigned to all of the models underneath them.
2. Label / value rows (e.g. Sungrow): one model, the label on the left and the
   value on the right. Values that wrap onto the line above or below are found.
3. "Label: value" lists (e.g. Dynapower), including extra lines that give the
   same rating under other conditions ("1500kVA (@600VAC)").

Every extracted value keeps the exact datasheet text it came from. A value is
only produced when its unit and format match what the field expects; anything
ambiguous is skipped rather than guessed.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .verify import normalize

EXTRACTOR_VERSION = "rules-2"  # rules-2: number of DC inputs

# ------------------------------------------------------------------ layout text


def layout_pages(pdf: bytes | Path) -> list[str]:
    def run(path: Path) -> list[str]:
        result = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
                                capture_output=True, timeout=120)
        if result.returncode != 0:
            return []
        pages = result.stdout.decode("utf-8", errors="replace").split("\f")
        return pages[:-1] if pages and not pages[-1].strip() else pages

    if isinstance(pdf, Path):
        return run(pdf)
    with tempfile.NamedTemporaryFile(suffix=".pdf") as handle:
        handle.write(pdf)
        handle.flush()
        return run(Path(handle.name))


@dataclass
class Chunk:
    start: int
    end: int
    text: str

    @property
    def center(self) -> float:
        return (self.start + self.end) / 2


def chunks(line: str) -> list[Chunk]:
    """Split a layout line into cells: runs of text separated by 2+ spaces."""
    line = normalize(line).replace("\t", "    ")
    return [Chunk(m.start(), m.end(), m.group(0)) for m in re.finditer(r"\S+(?: \S+)*", line)]


# ------------------------------------------------------------------ value parsers

NUM = r"[-+]?\d[\d,]*(?:\.\d+)?"


def _num(text: str) -> float:
    return float(text.replace(",", ""))


def _clean_number(text: str) -> str:
    value = text.replace(",", "")
    return value[1:] if value.startswith("+") else value


def number_with_unit(units: str):
    """Parser for a number followed by one of the units (regex alternation)."""
    pattern = re.compile(rf"(≤|<|>|≥)?\s*({NUM})\s*(?:{units})(?![A-Za-z])", re.IGNORECASE)

    def parse(text: str):
        found = [(m.group(1) or "", m.group(2)) for m in pattern.finditer(text)]
        if not found:
            return None
        return [(prefix + _clean_number(n), _num(n)) for prefix, n in found]
    return parse


def plain_number(text: str):
    m = re.fullmatch(rf"\s*({NUM})\s*", text)
    return [(_clean_number(m.group(1)), _num(m.group(1)))] if m else None


def text_value(text: str):
    value = re.sub(r"\s*\[\d+\]\s*$", "", text).strip()  # drop footnote markers
    return [(value, None)] if 1 < len(value) <= 80 else None


def range_value(units: str):
    pattern = re.compile(rf"({NUM})\s*(?:{units})?\s*(?:–|-|~|to)\s*({NUM})\s*(?:{units})(?![A-Za-z])", re.IGNORECASE)

    def parse(text: str):
        found = [(f"{_clean_number(a)}–{_clean_number(b)}", None) for a, b in pattern.findall(normalize(text).replace("—", "-"))]
        return found or None
    return parse


TEMP_RANGE = re.compile(rf"(?:from\s*)?({NUM})\s*°?\s*C?\s*(?:~|to|–|-)\s*\+?({NUM})\s*°\s*C", re.IGNORECASE)
DERATING = re.compile(r"(?:>\s*|above\s*\+?)(\d+)\s*°\s*C[^.;]*?derat|de-?rat\w*\s+above\s*\+?(\d+)\s*°\s*C", re.IGNORECASE)


def temp_min(text):
    m = TEMP_RANGE.search(normalize(text))
    return [(_clean_number(m.group(1)), _num(m.group(1)))] if m else None


def temp_max(text):
    m = TEMP_RANGE.search(normalize(text))
    return [(_clean_number(m.group(2)), _num(m.group(2)))] if m else None


def derating(text):
    m = DERATING.search(normalize(text))
    if not m:
        return None
    return [(f"Above {m.group(1) or m.group(2)} °C", None)]


def mv_voltage(text):
    t = normalize(text)
    m = re.search(rf"/\s*({NUM})\s*kV", t)            # "0.69 kV / 34.5 kV" → MV part
    if m:
        return [(_clean_number(m.group(1)), _num(m.group(1)))]
    m = re.search(rf"({NUM})\s*kV(\s*±\s*\d+\s*%)?", t)
    if not m:
        return None
    value = _clean_number(m.group(1)) + (" " + m.group(2).strip().replace(" ", "") if m.group(2) else "")
    return [(value, _num(m.group(1)))]


def lv_voltage(text):
    m = re.search(rf"({NUM})\s*kV\s*/\s*{NUM}\s*kV", normalize(text))
    if not m:
        return None
    volts = _num(m.group(1)) * 1000
    return [(str(int(round(volts))), volts)]


def power_factor(text):
    t = normalize(text)
    if not re.search(r"lead|lag", t, re.IGNORECASE):
        return None
    t = t.replace("...", " to ").replace("…", " to ")
    t = re.sub(r"\s+", " ", t).strip()
    return [(t[:60], None)]


def yes_like(text):
    t = text.strip()
    return [(t, None)] if re.fullmatch(r"(standard|yes|optional|available|included|no)(\s*\(.*\))?", t, re.IGNORECASE) else None


# ------------------------------------------------------------------ field rules


@dataclass
class Rule:
    field: str
    label: str                         # regex matched against the label cell
    parse: object                      # value parser
    exclude: str | None = None         # label/value text that disqualifies the row
    require: str | None = None         # text that must appear in label or value
    pick: str = "first"                # when a cell holds several numbers: first | max | min
    prefer: str | None = None          # among several matching rows, prefer one matching this
    value_from_label: bool = False     # unit is in the label, e.g. "Weight (kg)"
    label_note: str | None = None      # regex; its group(1) in the label is appended to the value


RULES = [
    Rule("rated_kva", r"(ac\s+output|apparent|rated)\s+power|max(imum)?\s+apparent\s+power",
         number_with_unit("kVA|MVA"), exclude=r"\bkW\b(?!.*kVA)", pick="max", prefer=r"@\s*40\s*°"),
    Rule("rated_kva", r"ac\s+output\s+power\s*\(kva", plain_number, pick="max", prefer=r"@\s*40\s*°", value_from_label=True),
    Rule("rated_kw", r"ac\s+output\s+power\s*\(kva/kw\)", plain_number, prefer=r"@\s*40\s*°", value_from_label=True),
    Rule("rated_kw", r"(max(imum)?\s+)?(real|active)\s+power", number_with_unit("kW|MW"), pick="max"),
    Rule("dc_max_v", r"max(imum)?\.?\s+dc\s+voltage", number_with_unit("V|VDC")),
    Rule("dc_min_v", r"min(imum)?\.?\s+dc\s+voltage", number_with_unit("V|VDC")),
    Rule("full_power_dc_range", r"dc\s+voltage\s+range\s+full\s+power", range_value("V|VDC")),
    Rule("dc_voltage_range", r"^dc\s+voltage\s+range(?!\s+full)", range_value("V|VDC")),
    Rule("max_dc_current_a", r"max(imum)?\.?\s+dc\s+(continuous\s+)?current\s*\(a\)", plain_number, value_from_label=True),
    Rule("max_dc_current_a", r"max(imum)?\.?\s+dc\s+(continuous\s+)?current(?!\s*\(a\))", number_with_unit("A|ADC")),
    Rule("dc_inputs", r"^(no\.?|number)\s+of\s+dc\s+inputs?\b|^dc\s+inputs?$", plain_number, exclude=r"current|voltage"),
    Rule("mv_voltage_kv", r"operating\s+grid\s+voltage|(nominal\s+)?lv\s*/\s*mv\s+voltage", mv_voltage),
    Rule("ac_voltage_v", r"(nominal\s+)?lv\s*/\s*mv\s+voltage", lv_voltage),
    Rule("frequency_hz", r"(nominal\s+|operating\s+)?grid\s+f\s?requency|^frequency", number_with_unit("Hz")),
    Rule("efficiency_max_pct", r"max(imum)?\.?\s*(converter\s+unit\s+)?efficiency|efficiency\s*\(max\)",
         number_with_unit("%"), exclude=r"transformer|mvt"),
    Rule("efficiency_with_mvt_pct", r"max(imum)?\.?\s*efficiency|efficiency\s*\(max\)",
         number_with_unit("%"), require=r"transformer|mvt"),
    Rule("efficiency_weighted_pct", r"\b(cec|euro)\b.*efficiency|\b(cec|euro)\b\s*\(", number_with_unit("%"),
         exclude=r"transformer|mvt"),
    Rule("power_factor", r"power\s+factor", power_factor),
    Rule("gfm", r"grid\s+forming", yes_like, label_note=r"grid\s+forming\s*\(([^)]+)\)"),
    Rule("black_start", r"black\s+start", yes_like),
    Rule("overload", r"overload", text_value),
    Rule("temp_min_c", r"operating\s+(ambient\s+)?temp", temp_min),
    Rule("temp_max_c", r"operating\s+(ambient\s+)?temp", temp_max),
    Rule("derating", r"operating\s+(ambient\s+)?temp", derating),
    Rule("cooling", r"cooling|ventilation", text_value, exclude=r"intelligent"),
    Rule("enclosure", r"degree\s+of\s+protection|^enclosure|protection\s+(degree|rating)", text_value),
    Rule("weight_kg", r"^weight\s*\(kg\)", plain_number, value_from_label=True),
    Rule("weight_kg", r"^weight(?!\s*\(lbs)", number_with_unit("kg")),
    Rule("communications", r"^communication(s|\s+protocol)?\b", text_value, exclude=r"interface card"),
]


# ------------------------------------------------------------------ table reading


@dataclass
class Candidate:
    field: str
    value: str
    numeric: float | None
    page: int
    evidence: str          # human-readable: the datasheet row (for multi-model tables, with the model named)
    anchor: str            # machine-matchable: text that appears contiguously in the PDF
    conditions: str = ""
    model: str | None = None   # model token from the table header, if any


@dataclass
class Header:
    models: list[str]
    centers: list[float]
    start: int


def find_header(line: str, pattern: re.Pattern | None) -> Header | None:
    if not pattern:
        return None
    found = [(m.group(0), (m.start() + m.end()) / 2, m.start()) for m in pattern.finditer(normalize(line))]
    if not found:
        return None
    left_text = normalize(line)[: found[0][2]].strip().lower()
    if len(found) == 1 and not re.search(r"reference|type\s+designation|model", left_text):
        return None
    return Header([f[0] for f in found], [f[1] for f in found], found[0][2])


def assign_to_columns(cells: list[Chunk], centers: list[float]) -> list[list[int]] | None:
    """Assign k cells to n model columns (k ≤ n), allowing merged cells.

    Columns are split into k contiguous groups so that each cell sits as close as
    possible to the middle of its group. Returns, per cell, the column indexes it covers.
    """
    k, n = len(cells), len(centers)
    if k == 0 or k > n:
        return None
    inf = float("inf")
    # cost[i][a][b]: cell i covering columns a..b
    best = [[inf] * (n + 1) for _ in range(k + 1)]
    back = [[0] * (n + 1) for _ in range(k + 1)]
    best[0][0] = 0.0
    for i in range(1, k + 1):
        x = cells[i - 1].center
        for j in range(i, n + 1):
            for a in range(i - 1, j):
                mean = sum(centers[a:j]) / (j - a)
                cost = best[i - 1][a] + (x - mean) ** 2
                if cost < best[i][j]:
                    best[i][j], back[i][j] = cost, a
    groups, j = [], n
    for i in range(k, 0, -1):
        a = back[i][j]
        groups.append(list(range(a, j)))
        j = a
    groups.reverse()
    # Reject assignments where a cell is far outside the columns it was given.
    spacing = (centers[-1] - centers[0]) / max(n - 1, 1) if n > 1 else 40
    for cell, cols in zip(cells, groups):
        lo, hi = centers[cols[0]] - spacing, centers[cols[-1]] + spacing
        if not lo <= cell.center <= hi:
            return None
    return groups


def _rule_label_match(rule: Rule, text: str) -> bool:
    return bool(re.search(rule.label, text.strip().rstrip(":"), re.IGNORECASE))


def _pick(values, how):
    if not values:
        return None
    if how == "first" or values[0][1] is None:
        return values[0]
    numeric = [v for v in values if v[1] is not None]
    return (max if how == "max" else min)(numeric, key=lambda v: v[1])


def _conditions(text: str) -> str:
    found = re.findall(r"\(\s*@[^)]*\)|@\s*[-\d.]+\s*°\s*C|@\s*\d+\s*V\w*", normalize(text))
    return ", ".join(dict.fromkeys(f.strip("() ") for f in found))


def extract(pdf: bytes | Path, model_pattern: str | None = None) -> list[Candidate]:
    """Extract candidate values from one datasheet."""
    return extract_from_pages(layout_pages(pdf), model_pattern)


def extract_from_pages(pages: list[str], model_pattern: str | None = None) -> list[Candidate]:
    """Extract candidate values from laid-out page text (one string per page)."""
    pattern = re.compile(model_pattern) if model_pattern else None
    results: list[Candidate] = []
    header: Header | None = None
    seen_multi = False

    for page_no, page in enumerate(pages, start=1):
        lines = page.splitlines()
        for idx, line in enumerate(lines):
            new_header = find_header(line, pattern)
            if new_header:
                header = new_header
                seen_multi = seen_multi or len(new_header.models) > 1
                continue
            parts = chunks(line)
            for li, label in enumerate(parts):
                for rule in RULES:
                    if not _rule_label_match(rule, label.text):
                        continue
                    for cand in _read_row(rule, lines, idx, parts, li, header, page_no):
                        results.append(cand)
    if seen_multi:
        # In a multi-model datasheet, a value we couldn't tie to a model column is unusable.
        results = [r for r in results if r.model]
    return _dedupe(results)


def _value_options(lines, idx, parts, li):
    """Where the value for the label at parts[li] may be: the same line, else a wrapped line."""
    label = parts[li]
    same = [c for c in parts[li + 1:] if not re.fullmatch(r"\[\d+\]", c.text)]
    if same:
        return [(same, idx)]
    options = []
    for j in (idx + 1, idx - 1, idx + 2):
        if 0 <= j < len(lines):
            line_chunks = chunks(lines[j])
            cells = [c for c in line_chunks if c.start > label.end]
            if cells and len(cells) == len(line_chunks):
                options.append((cells, j))
    return options


def _continuations(lines, idx, first: Chunk):
    """Extra lines aligned under a value (e.g. the same rating at other voltages)."""
    extra = []
    for j in range(idx + 1, min(idx + 4, len(lines))):
        cells = chunks(lines[j])
        if not cells:
            break
        cell = cells[0]
        aligned = abs(cell.start - first.start) <= 8 or abs(cell.end - first.end) <= 8
        if not aligned:
            break
        extra.append((cell, lines[j]))
    return extra


def _read_row(rule, lines, idx, parts, li, header, page_no):
    for cells, line_no in _value_options(lines, idx, parts, li):
        found = _read_cells(rule, lines, idx, parts[li], cells, line_no, header, page_no)
        if found:
            return found
    return []


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", normalize(text)).strip()


def _with_note(rule, label_text, parsed):
    if not parsed or not rule.label_note:
        return parsed
    m = re.search(rule.label_note, label_text, re.IGNORECASE)
    return [(f"{v} ({m.group(1)})", n) for v, n in parsed] if m else parsed


def _read_cells(rule, lines, idx, label, cells, line_no, header, page_no):
    row_text = " ".join(c.text for c in [label, *cells])
    if rule.exclude and re.search(rule.exclude, row_text, re.IGNORECASE):
        return []
    if rule.require and not re.search(rule.require, row_text, re.IGNORECASE):
        return []
    label_text = _flat(label.text)
    anchor = _flat(lines[line_no])

    # Multi-model table: one value per model column (merged cells cover several models).
    if header and len(header.models) > 1 and cells[0].start >= header.start - 12:
        table_cells = [c for c in cells if c.start >= header.start - 12]
        groups = assign_to_columns(table_cells, header.centers)
        if not groups:
            return []
        out = []
        for cell, cols in zip(table_cells, groups):
            chosen = _pick(_with_note(rule, label_text, rule.parse(cell.text)), rule.pick)
            if not chosen:
                continue
            for col in cols:
                out.append(Candidate(
                    rule.field, chosen[0], chosen[1], page_no,
                    evidence=f"{label_text} — {header.models[col]}: {_flat(cell.text)}",
                    anchor=anchor, conditions=_conditions(label_text), model=header.models[col]))
        return out

    # Single model: the first value cell, plus continuation lines for "Label:" lists.
    first = cells[0]
    parsed_first = rule.parse(first.text) or []
    if parsed_first and parsed_first[0][1] is not None and line_no == idx:
        # Two different numbers in separate cells of one row (e.g. two configurations) are ambiguous.
        others = [p for c in cells[1:] for p in (rule.parse(c.text) or []) if p[1] is not None]
        if others and any(o[1] != parsed_first[0][1] for o in others):
            return []
    texts = [first.text]
    if line_no == idx and label.text.rstrip().endswith(":"):
        texts += [cell.text for cell, _ in _continuations(lines, idx, first)]
    values = [(v, n, t) for t in texts for v, n in (_with_note(rule, label_text, rule.parse(t)) or [])]
    if not values:
        return []
    if values[0][1] is None:                       # text field: join the lines
        value = "; ".join(dict.fromkeys(v for v, _, _ in values)) if len(texts) > 1 else values[0][0]
        number, cell_text = None, " ".join(texts)
    elif rule.pick == "first" or len(values) == 1:
        value, number, cell_text = values[0]
    else:
        value, number, cell_text = (max if rule.pick == "max" else min)(values, key=lambda v: v[1])
    model = header.models[0] if header and len(header.models) == 1 else None
    if len(texts) > 1:
        evidence = f"{label_text} " + " / ".join(_flat(t) for t in texts)
        anchor = _flat(first.text)
    else:
        evidence = f"{label_text} {_flat(first.text)}"
    return [Candidate(rule.field, value, number, page_no, evidence=evidence, anchor=anchor,
                      conditions=_conditions(f"{label_text} {cell_text}"), model=model)]


def _dedupe(results: list[Candidate]) -> list[Candidate]:
    """Keep one value per (model, field): the preferred row if a rule says so, else the first."""
    rules_by_field = {}
    for r in RULES:
        rules_by_field.setdefault(r.field, r)
    chosen: dict[tuple, Candidate] = {}
    for cand in results:
        key = (cand.model, cand.field)
        prefer = next((r.prefer for r in RULES if r.field == cand.field and r.prefer), None)
        current = chosen.get(key)
        if current is None:
            chosen[key] = cand
        elif prefer and re.search(prefer, cand.evidence) and not re.search(prefer, current.evidence):
            chosen[key] = cand
    return list(chosen.values())
