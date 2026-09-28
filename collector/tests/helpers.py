"""Test helpers: tiny real PDFs and a fake website."""

from __future__ import annotations

import json
from pathlib import Path

from collector.fetch import Response, canonical_url


def make_pdf(pages: list[list[str]]) -> bytes:
    """Build a minimal valid PDF with one text line per list item."""
    objects: list[bytes] = []
    kids = []
    font_id = 3
    page_ids = []
    next_id = 4
    for lines in pages:
        content = "BT /F1 11 Tf 50 750 Td 14 TL\n" + "".join(
            "(" + line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj T*\n"
            for line in lines
        ) + "ET"
        page_id, content_id = next_id, next_id + 1
        next_id += 2
        page_ids.append((page_id, content_id, content.encode("latin-1")))
        kids.append(f"{page_id} 0 R")

    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    for page_id, content_id, stream in page_ids:
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>".encode()
        )
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class FakeWeb:
    """Stands in for Fetcher: serves canned responses by URL."""

    def __init__(self, allowed, pages: dict):
        self.allowed = set(allowed)
        self.pages = pages  # url -> bytes | int (status)
        self.requests: list[tuple[str, dict]] = []

    def get(self, url, headers=None):
        url = canonical_url(url)
        self.requests.append((url, headers or {}))
        body = self.pages.get(url, 404)
        if isinstance(body, int):
            return Response(url, body, {}, b"")
        return Response(url, 200, {"etag": f'"{hash(body)}"'}, body)


def write_repo(root: Path, suppliers, fields, documents=(), specs=()) -> None:
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "suppliers.json").write_text(json.dumps(suppliers))
    (data / "fields.json").write_text(json.dumps(fields))
    (data / "documents.json").write_text(json.dumps(list(documents)))
    (data / "specs.json").write_text(json.dumps(list(specs)))
    (data / "changes.json").write_text("[]")
