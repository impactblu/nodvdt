"""Page text from PDFs, using poppler's pdftotext.

Datasheets are mostly tables, and different text layouts suit different
tables, so each page is extracted twice (reading order and raw stream order).
Callers search both versions.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path


def _run(path: Path, mode: list[str]) -> list[str]:
    result = subprocess.run(
        ["pdftotext", *mode, "-enc", "UTF-8", str(path), "-"],
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0:
        return []
    text = result.stdout.decode("utf-8", errors="replace")
    pages = text.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def page_texts(pdf: bytes | Path) -> list[list[str]]:
    """Return, for each page, the list of alternative text versions of that page."""
    if isinstance(pdf, Path):
        return _extract(pdf)
    with tempfile.NamedTemporaryFile(suffix=".pdf") as handle:
        handle.write(pdf)
        handle.flush()
        return _extract(Path(handle.name))


def _extract(path: Path) -> list[list[str]]:
    layouts = [_run(path, []), _run(path, ["-raw"])]
    count = max((len(pages) for pages in layouts), default=0)
    return [[pages[i] for pages in layouts if i < len(pages)] for i in range(count)]


def page_count(pdf: bytes | Path) -> int:
    return len(page_texts(pdf))
