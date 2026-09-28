"""Reading and writing the catalog data kept in the repository.

Layout (paths relative to the repository root):

    data/suppliers.json   hand-edited: suppliers, products and the sources to watch
    data/fields.json      hand-edited: specification field definitions
    data/documents.json   collector-managed: every datasheet and all its revisions
    data/models.json      collector-managed: models discovered in datasheet tables
    data/specs.json       collector-managed: published values with evidence and history
    data/changes.json     collector-managed: change log, newest first
    data/status.json      collector-managed: result of the last collection run
    datasheets/<sha12>/<file>.pdf   archived copy of every datasheet revision

Datasheet files are content-addressed, so an unchanged file is stored once and
older revisions stay downloadable forever.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MAX_CHANGES = 2000


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "item"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_filename(name: str) -> str:
    name = PurePosixPath(name).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.") or "datasheet"
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:150]


def _read(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


@dataclass
class Catalog:
    root: Path
    suppliers: list = field(default_factory=list)
    fields: list = field(default_factory=list)
    documents: list = field(default_factory=list)
    models: list = field(default_factory=list)
    specs: list = field(default_factory=list)
    changes: list = field(default_factory=list)
    status: dict = field(default_factory=dict)

    # ---- loading and saving -------------------------------------------------

    @classmethod
    def load(cls, root: Path) -> "Catalog":
        data = root / "data"
        return cls(
            root=root,
            suppliers=_read(data / "suppliers.json", []),
            fields=_read(data / "fields.json", []),
            documents=_read(data / "documents.json", []),
            models=_read(data / "models.json", []),
            specs=_read(data / "specs.json", []),
            changes=_read(data / "changes.json", []),
            status=_read(data / "status.json", {}),
        )

    def save(self, include_status: bool = True) -> None:
        data = self.root / "data"
        _write(data / "documents.json", self.documents)
        _write(data / "models.json", self.models)
        _write(data / "specs.json", self.specs)
        _write(data / "changes.json", self.changes[:MAX_CHANGES])
        if include_status:
            _write(data / "status.json", self.status)

    # ---- lookups ------------------------------------------------------------

    def products(self, include_discovered: bool = False):
        """Yield (supplier, product) pairs: the configured ones, optionally plus discovered models."""
        for supplier in self.suppliers:
            for product in supplier.get("products", []):
                yield supplier, product
        if include_discovered:
            by_id = {s["id"]: s for s in self.suppliers}
            for model in self.models:
                if model["supplier"] in by_id:
                    yield by_id[model["supplier"]], model

    def supplier(self, supplier_id: str) -> dict | None:
        return next((s for s in self.suppliers if s["id"] == supplier_id), None)

    def product(self, product_id: str) -> dict | None:
        return next((p for _, p in self.products(include_discovered=True) if p["id"] == product_id), None)

    def document_by_url(self, url: str) -> dict | None:
        return next((d for d in self.documents if d["url"] == url), None)

    def document_by_id(self, doc_id: str) -> dict | None:
        return next((d for d in self.documents if d["id"] == doc_id), None)

    def specs_for_document(self, doc_id: str) -> list[dict]:
        return [s for s in self.specs if s["document"] == doc_id]

    def field(self, key: str) -> dict:
        return next((f for f in self.fields if f["key"] == key), {"key": key, "label": key, "unit": ""})

    # ---- datasheet files ----------------------------------------------------

    def datasheet_path(self, relative: str) -> Path:
        return self.root / relative

    def store_datasheet(self, data: bytes, filename: str) -> tuple[str, str]:
        """Save a datasheet file. Returns (sha256, path relative to the repo root)."""
        digest = sha256(data)
        relative = f"datasheets/{digest[:12]}/{safe_filename(filename)}"
        target = self.root / relative
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return digest, relative

    # ---- documents ----------------------------------------------------------

    def new_document_id(self, filename: str) -> str:
        base = slugify(PurePosixPath(filename).stem)[:80]
        existing = {d["id"] for d in self.documents}
        candidate, n = base, 2
        while candidate in existing:
            candidate, n = f"{base}-{n}", n + 1
        return candidate

    def log(self, kind: str, summary: str, **details) -> None:
        entry = {"at": now(), "type": kind, "summary": summary}
        entry.update({k: v for k, v in details.items() if v is not None})
        self.changes.insert(0, entry)


def current_revision(document: dict) -> dict:
    return document["revisions"][-1]
