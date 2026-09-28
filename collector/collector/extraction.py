"""Turn extractor output into published values and discovered models.

Rules:
- A value is only added where the catalog has none for that model and field;
  reviewed and previously published values are never overwritten here.
  (When a datasheet is revised, existing values are re-checked in collect.py.)
- Values read from a model-column table go to the model named in the column
  header. A model that isn't in the catalog yet is added to data/models.json.
- A value without a model column goes to the datasheet's own product, unless
  that product is a family (a family-level value would be ambiguous).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .extract import EXTRACTOR_VERSION, Candidate, extract
from .store import Catalog, current_revision, now, slugify

log = logging.getLogger("collector")

STATUS_EXTRACTED = "extracted"


def possessive(name: str) -> str:
    return f"{name}’" if name.endswith("s") else f"{name}’s"


def model_pattern(catalog: Catalog, supplier_id: str) -> str | None:
    supplier = catalog.supplier(supplier_id) or {}
    return supplier.get("model_pattern")


def candidates_for(catalog: Catalog, doc: dict, pdf: bytes | Path) -> list[Candidate]:
    return extract(pdf, model_pattern(catalog, doc["supplier"]))


def _is_family(product: dict | None) -> bool:
    return bool(product) and "family" in (product.get("kind") or "").lower()


def _market_from_title(title: str) -> str | None:
    if re.search(r"\bUL\b", title):
        return "UL variant"
    if re.search(r"\bIEC\b", title):
        return "IEC variant"
    return None


def resolve_product(catalog: Catalog, doc: dict, token: str | None, created: list) -> dict | None:
    if token is None:
        product = catalog.product(doc["product"])
        return None if _is_family(product) else product

    word = re.compile(rf"(?<![\w-]){re.escape(token)}(?![\w-])")
    for supplier, product in catalog.products(include_discovered=True):
        if supplier["id"] == doc["supplier"] and (product["model"] == token or word.search(product["model"])):
            return product

    supplier = catalog.supplier(doc["supplier"])
    source_product = catalog.product(doc["product"]) or {}
    model = {
        "id": slugify(f"{supplier['id']} {token}"),
        "supplier": supplier["id"],
        "model": token,
        "summary": f"Listed in {possessive(supplier['name'])} “{doc['title']}”. Added automatically from the datasheet table.",
        "kind": None if _is_family(source_product) else source_product.get("kind"),
        "market": _market_from_title(doc["title"]),
        "family": source_product.get("id"),
        "auto": True,
        "found_in": doc["id"],
        "first_seen": now(),
    }
    model = {k: v for k, v in model.items() if v is not None}
    catalog.models.append(model)
    created.append(model)
    return model


def new_spec(product: dict, doc: dict, revision: dict, cand: Candidate) -> dict:
    spec = {
        "id": f"{product['id']}:{cand.field}",
        "product": product["id"],
        "field": cand.field,
        "value": cand.value,
    }
    if cand.numeric is not None:
        spec["numeric"] = cand.numeric
    spec.update({
        "conditions": cand.conditions,
        "evidence": cand.evidence,
        "anchor": cand.anchor,
        "document": doc["id"],
        "revision": revision["sha256"],
        "page": cand.page,
        "status": STATUS_EXTRACTED,
        "extracted_by": f"Rules-based extractor ({EXTRACTOR_VERSION})",
        "extractor": {"version": EXTRACTOR_VERSION, "model": cand.model},
        "checked_at": now(),
        "history": [],
    })
    return spec


def extract_document(catalog: Catalog, doc: dict, pdf: bytes | Path | None = None) -> tuple[int, list]:
    """Fill in missing values from a document's current revision. Returns (values added, models created)."""
    revision = current_revision(doc)
    pdf = pdf if pdf is not None else catalog.datasheet_path(revision["file"])
    cands = candidates_for(catalog, doc, pdf)
    existing = {(s["product"], s["field"]) for s in catalog.specs}
    created: list = []
    added = 0
    models = set(doc.get("models", []))
    for cand in cands:
        product = resolve_product(catalog, doc, cand.model, created)
        if not product:
            continue
        models.add(product["id"])
        if (product["id"], cand.field) in existing:
            continue
        catalog.specs.append(new_spec(product, doc, revision, cand))
        existing.add((product["id"], cand.field))
        added += 1

    revision["extracted"] = EXTRACTOR_VERSION
    if models:
        doc["models"] = sorted(models)
    supplier = catalog.supplier(doc["supplier"]) or {"name": doc["supplier"]}
    for model in created:
        catalog.log("new-model", f"New model found in a datasheet: {supplier['name']} {model['model']}",
                    product=model["id"], document=doc["id"])
    if added:
        catalog.log("values-extracted", f"{added} values read from {doc['title']}",
                    document=doc["id"], product=doc["product"], revision=revision["sha256"], count=added)
        log.info("  extracted %d value(s) from %s (%d new model(s))", added, doc["title"], len(created))
    return added, created


def backfill(catalog: Catalog) -> tuple[int, int]:
    """Run the extractor on every current datasheet revision it hasn't read yet."""
    total_values = total_models = 0
    for doc in catalog.documents:
        if current_revision(doc).get("extracted") == EXTRACTOR_VERSION:
            continue
        try:
            added, created = extract_document(catalog, doc)
        except Exception:  # one bad PDF must not stop the run
            log.exception("Extraction failed for %s", doc["id"])
            continue
        total_values += added
        total_models += len(created)
    return total_values, total_models


def recheck_extracted(spec: dict, cands: list[Candidate]) -> dict | None:
    """For a value the extractor produced: read the same model/field from the new revision.

    Returns a verify-style outcome dict, or None if the spec wasn't extractor-made.
    """
    info = spec.get("extractor")
    if not info:
        return None
    from . import verify
    match = next((c for c in cands if c.field == spec["field"] and c.model == info.get("model")), None)
    if not match:
        return {"status": verify.NEEDS_CHECK, "value": spec["value"], "numeric": spec.get("numeric"),
                "page": spec.get("page"), "evidence": spec["evidence"]}
    same = str(match.value) == str(spec["value"])
    if not same and match.numeric is not None and spec.get("numeric") is not None \
            and not verify.plausible_change(spec["numeric"], match.numeric):
        return {"status": verify.NEEDS_CHECK, "value": spec["value"], "numeric": spec.get("numeric"),
                "page": spec.get("page"), "evidence": spec["evidence"]}
    return {"status": verify.CONFIRMED if same else verify.UPDATED, "value": match.value, "numeric": match.numeric,
            "page": match.page, "evidence": match.evidence, "anchor": match.anchor}
