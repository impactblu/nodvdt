"""Consistency checks for the data folder. Run by GitHub Actions before every
deploy, so a broken edit to the JSON files never reaches the website."""

from __future__ import annotations

from pathlib import Path

from .store import Catalog, sha256

VALID_STATUSES = {"reviewed", "confirmed", "updated", "needs-check"}


def problems(root: Path, check_hashes: bool = True) -> list[str]:
    catalog = Catalog.load(root)
    found: list[str] = []

    field_keys = {f["key"] for f in catalog.fields}
    supplier_ids = [s.get("id") for s in catalog.suppliers]
    product_ids = [p.get("id") for _, p in catalog.products()]
    doc_ids = [d["id"] for d in catalog.documents]
    for label, ids in (("supplier", supplier_ids), ("product", product_ids), ("document", doc_ids)):
        if None in ids:
            found.append(f"A {label} is missing its id")
        duplicates = {i for i in ids if ids.count(i) > 1}
        if duplicates:
            found.append(f"Duplicate {label} ids: {sorted(duplicates)}")

    revisions = {}
    for doc in catalog.documents:
        if doc["supplier"] not in supplier_ids:
            found.append(f"Document {doc['id']}: unknown supplier {doc['supplier']}")
        if doc.get("product") and doc["product"] not in product_ids:
            found.append(f"Document {doc['id']}: unknown product {doc['product']}")
        if not doc.get("revisions"):
            found.append(f"Document {doc['id']} has no revisions")
        for rev in doc.get("revisions", []):
            revisions[rev["sha256"]] = doc["id"]
            path = root / rev["file"]
            if not path.exists():
                found.append(f"Document {doc['id']}: missing file {rev['file']}")
            elif check_hashes and sha256(path.read_bytes()) != rev["sha256"]:
                found.append(f"Document {doc['id']}: {rev['file']} does not match its sha256")

    spec_ids = [s["id"] for s in catalog.specs]
    duplicates = {i for i in spec_ids if spec_ids.count(i) > 1}
    if duplicates:
        found.append(f"Duplicate spec ids: {sorted(duplicates)}")
    for spec in catalog.specs:
        where = f"Spec {spec['id']}"
        if spec["product"] not in product_ids:
            found.append(f"{where}: unknown product {spec['product']}")
        if spec["field"] not in field_keys:
            found.append(f"{where}: unknown field {spec['field']}")
        if spec.get("status") not in VALID_STATUSES:
            found.append(f"{where}: status must be one of {sorted(VALID_STATUSES)}")
        if revisions.get(spec.get("revision")) != spec.get("document"):
            found.append(f"{where}: revision is not a revision of document {spec.get('document')}")
        if not spec.get("evidence"):
            found.append(f"{where}: evidence is required")
        for old in spec.get("history", []):
            if old.get("revision") and old["revision"] not in revisions:
                found.append(f"{where}: history refers to an unknown revision")
    return found
