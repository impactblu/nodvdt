"""Re-check published specifications against a new datasheet revision.

Every published value carries the exact line of the datasheet it came from
(its "evidence"). When a datasheet changes, each value is checked like this:

1. The same evidence line is still in the new revision
   -> status "confirmed", value unchanged, now points at the new revision.
2. The label in front of the value is still there but the number after it
   changed -> status "updated": the new number goes live straight away and the
   old value stays in the spec's history, linked to the old revision.
3. Neither can be found -> status "needs-check": the old value stays visible,
   clearly marked, with links to both revisions so a person can compare.

Matching ignores whitespace, case and a few typographic variants, because PDF
text extraction does not preserve spacing reliably.
"""

from __future__ import annotations

import re
import unicodedata

CONFIRMED = "confirmed"
UPDATED = "updated"
NEEDS_CHECK = "needs-check"

_NUMBER = r"[-+≤≥<>~]?\s*\d+(?:[.,]\d+)?"
_REPLACEMENTS = {"℃": "°C", "℉": "°F", "…": "...", "–": "-", "—": "-", "−": "-", " ": " "}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    for old, new in _REPLACEMENTS.items():
        text = text.replace(old, new)
    return text


def compact(text: str) -> str:
    return re.sub(r"\s+", "", normalize(text)).lower()


def _loose_pattern(text: str) -> str:
    """Regex that matches `text` with any (or no) whitespace between characters."""
    chars = compact(text)
    return r"\s*".join(re.escape(c) for c in chars)


def find_evidence(evidence: str, pages: list[list[str]]) -> tuple[int, str] | None:
    """Find the evidence line in the pages. Returns (page_number, matched_text)."""
    pattern = re.compile(_loose_pattern(evidence), re.IGNORECASE)
    for number, versions in enumerate(pages, start=1):
        for text in versions:
            match = pattern.search(normalize(text))
            if match:
                return number, re.sub(r"\s+", " ", match.group(0)).strip()
    return None


def split_on_value(evidence: str, value: str) -> tuple[str, str, str] | None:
    """Split the evidence around a numeric value.

    Returns (text before the value, unit right after it, all text after it), or
    None if the value is not a plain number that appears in the evidence.
    """
    if not re.fullmatch(_NUMBER, normalize(value).strip()):
        return None
    ev, val = compact(evidence), compact(value)
    for match in re.finditer(re.escape(val), ev):
        start, end = match.start(), match.end()
        before_ok = start == 0 or not ev[start - 1].isdigit()
        after_ok = end == len(ev) or not (ev[end].isdigit() or ev[end] in ".,")
        if before_ok and after_ok:
            unit = re.match(r"[^\d]{0,4}", ev[end:]).group(0)
            return ev[:start], unit, ev[end:]
    return None


def plausible_change(old: float | None, new: float | None) -> bool:
    """Guard against misreads: a revised rating keeps its sign and stays within 2x."""
    if old is None or new is None:
        return False
    if old == 0 or new == 0:
        return old == new
    return (old > 0) == (new > 0) and 0.5 <= new / old <= 2


def read_new_value(evidence: str, value: str, pages: list[list[str]]):
    """Read the number that now sits where the old value was.

    Uses the label in front of the value when there is one (at least 6
    characters), otherwise the text right after it (e.g. "kVA @ 45 °C"). With a
    label, the number must still be followed by the same unit, so a Fahrenheit
    row under a Celsius label is not mistaken for a new value.
    Returns (page_number, new_value, snippet) or None.
    """
    split = split_on_value(evidence, value)
    if not split:
        return None
    prefix, unit, suffix = split
    if len(prefix) >= 6:
        pattern = _loose_pattern(prefix) + r"\s*(" + _NUMBER + r")" + (r"\s*" + _loose_pattern(unit) if unit else "")
    elif len(suffix) >= 6:
        pattern = r"(" + _NUMBER + r")\s*" + _loose_pattern(suffix)
    else:
        return None
    compiled = re.compile(pattern, re.IGNORECASE)
    for number, versions in enumerate(pages, start=1):
        for text in versions:
            flat = normalize(text)
            match = compiled.search(flat)
            if match:
                new_value = re.sub(r"\s+", "", match.group(1))
                line_end = flat.find("\n", match.end())
                tail = flat[match.end(): line_end if line_end != -1 else match.end() + 40][:40]
                snippet = re.sub(r"\s+", " ", match.group(0) + tail).strip()
                return number, new_value, snippet
    return None


def to_number(value: str):
    cleaned = normalize(value).replace(",", ".")
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned.replace(" ", ""))
    return float(match.group(0)) if match else None


def recheck(spec: dict, pages: list[list[str]]) -> dict:
    """Decide what happens to one spec given the pages of the new revision.

    Returns a dict with keys: status, value, numeric, page, evidence.
    """
    # "anchor" is optional: machine-matchable text for evidence that a person
    # assembled from several table cells. Falls back to the evidence itself.
    text = spec.get("anchor") or spec["evidence"]
    found = find_evidence(text, pages)
    if found:
        page, _ = found
        return {
            "status": CONFIRMED,
            "value": spec["value"],
            "numeric": spec.get("numeric"),
            "page": page,
            "evidence": spec["evidence"],
        }

    read = read_new_value(text, spec["value"], pages)
    if read:
        page, new_value, snippet = read
        old_number = to_number(spec["value"])
        new_number = to_number(new_value)
        if old_number is not None and new_number == old_number:
            return {"status": CONFIRMED, "value": spec["value"], "numeric": spec.get("numeric"),
                    "page": page, "evidence": snippet}
        if plausible_change(old_number, new_number):
            return {"status": UPDATED, "value": new_value.lstrip("+"), "numeric": new_number,
                    "page": page, "evidence": snippet}
        # Found something, but it doesn't look like a trustworthy new reading: fall through.

    return {"status": NEEDS_CHECK, "value": spec["value"], "numeric": spec.get("numeric"),
            "page": spec.get("page"), "evidence": spec["evidence"]}
