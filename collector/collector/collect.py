"""One collection pass: check every source, archive new datasheet revisions,
re-check the specs that depend on them, and record what changed."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from . import verify
from .config import Settings
from .fetch import FetchError, Fetcher, canonical_url, check_public, datasheet_links, filename_for
from .pdftext import page_texts
from .store import Catalog, current_revision, now

log = logging.getLogger("collector")


@dataclass
class RunSummary:
    sources_checked: int = 0
    files_checked: int = 0
    new_documents: int = 0
    new_revisions: int = 0
    values_confirmed: int = 0
    values_updated: int = 0
    values_need_check: int = 0
    errors: list = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.new_documents or self.new_revisions)

    def commit_message(self) -> str:
        problems = f", {len(self.errors)} source problem(s)" if self.errors else ""
        if not self.changed:
            return f"Collector: checked {self.sources_checked} sources, no datasheet changes{problems}"
        parts = []
        if self.new_documents:
            parts.append(f"{self.new_documents} new datasheet(s)")
        if self.new_revisions:
            parts.append(f"{self.new_revisions} revised datasheet(s)")
        if self.values_updated:
            parts.append(f"{self.values_updated} value(s) updated")
        if self.values_need_check:
            parts.append(f"{self.values_need_check} value(s) need checking")
        return "Collector: " + ", ".join(parts) + problems


def run(catalog: Catalog, settings: Settings, check_address=check_public, fetcher_factory=None) -> RunSummary:
    summary = RunSummary()
    started = now()
    source_results = []

    for supplier, product in catalog.products():
        for source in product.get("sources", []):
            hosts = set(source.get("allowed_hosts", [])) | {urlsplit(source["url"]).hostname}
            if fetcher_factory:
                fetcher = fetcher_factory(hosts)
            else:
                fetcher = Fetcher(hosts, settings.user_agent, settings.request_delay_seconds,
                                  settings.max_file_bytes, check_address=check_address)
            log.info("Checking %s", source.get("name", source["url"]))
            result = {"supplier": supplier["id"], "product": product["id"],
                      "name": source.get("name", source["url"]), "url": source["url"],
                      "files": 0, "ok": True, "error": None}
            summary.sources_checked += 1
            try:
                _check_source(catalog, fetcher, supplier, product, source, result, summary)
            except FetchError as exc:
                result["ok"], result["error"] = False, str(exc)
            except Exception as exc:  # keep going with the other sources
                log.exception("Source failed: %s", source["url"])
                result["ok"], result["error"] = False, f"Unexpected error: {exc}"
            if result["error"]:
                summary.errors.append(f"{result['name']}: {result['error']}")
                log.info("  problem: %s", result["error"][:300])
            else:
                log.info("  ok, %d file(s)", result["files"])
            source_results.append(result)

    catalog.status = {
        "last_run_started": started,
        "last_run_finished": now(),
        "interval_hours": settings.check_interval_hours,
        "summary": {
            "sources_checked": summary.sources_checked,
            "files_checked": summary.files_checked,
            "new_documents": summary.new_documents,
            "new_revisions": summary.new_revisions,
            "values_updated": summary.values_updated,
            "values_need_check": summary.values_need_check,
            "errors": len(summary.errors),
        },
        "sources": source_results,
    }
    return summary


def _check_source(catalog, fetcher, supplier, product, source, result, summary) -> None:
    patterns = [p.strip().lower() for p in source.get("link_pattern", "").split(",") if p.strip()]
    resp = fetcher.get(source["url"])
    if resp.status != 200:
        raise FetchError(f"HTTP {resp.status}")

    if resp.body.lstrip().startswith(b"%PDF-"):
        urls = [canonical_url(source["url"])]
        first = resp
    else:
        urls = datasheet_links(resp.body, resp.url, fetcher.allowed, patterns)
        first = None
        if not urls:
            raise FetchError("No matching PDF links on the page. The site may load its downloads "
                             "with JavaScript; add a direct PDF link as a source instead.")

    errors = []
    for url in urls:
        try:
            _check_file(catalog, fetcher, supplier, product, source, url, first if url == urls[0] else None,
                        summary, referer=None if first else resp.url)
            result["files"] += 1
            summary.files_checked += 1
        except FetchError as exc:
            errors.append(f"{url}: {exc}")
    if errors:
        result["ok"] = False
        result["error"] = "; ".join(errors)[:2000]


def _check_file(catalog: Catalog, fetcher, supplier, product, source, url, prefetched, summary,
                referer: str | None = None) -> None:
    doc = catalog.document_by_url(url)
    if prefetched is not None:
        resp = prefetched
    else:
        # Some sites refuse file downloads that don't come from their own product page.
        headers = {"Referer": referer} if referer else {}
        if doc:
            rev = current_revision(doc)
            if rev.get("etag"):
                headers["If-None-Match"] = rev["etag"]
            if rev.get("last_modified"):
                headers["If-Modified-Since"] = rev["last_modified"]
        resp = fetcher.get(url, headers)

    if resp.status == 304 and doc:
        doc["last_checked"] = now()
        return
    if resp.status != 200:
        raise FetchError(f"HTTP {resp.status}")
    if not resp.body.lstrip().startswith(b"%PDF-"):
        raise FetchError("Expected a PDF but got a web page (possibly a sign-in or download form).")

    filename = filename_for(resp.url, resp.headers)
    digest, relative = catalog.store_datasheet(resp.body, filename)

    if doc and current_revision(doc)["sha256"] == digest:
        doc["last_checked"] = now()
        return

    pages = page_texts(resp.body)
    revision = {
        "sha256": digest,
        "file": relative,
        "bytes": len(resp.body),
        "pages": len(pages),
        "captured_at": now(),
        "etag": resp.headers.get("etag"),
        "last_modified": resp.headers.get("last-modified"),
    }
    revision = {k: v for k, v in revision.items() if v is not None}

    if doc is None:
        doc = {
            "id": catalog.new_document_id(filename),
            "supplier": supplier["id"],
            "product": product["id"],
            "title": filename.rsplit(".", 1)[0].replace("-", " ").replace("_", " "),
            "url": url,
            "source_url": source["url"],
            "first_seen": revision["captured_at"],
            "last_checked": revision["captured_at"],
            "revisions": [revision],
        }
        catalog.documents.append(doc)
        summary.new_documents += 1
        log.info("  new datasheet: %s", doc["title"])
        catalog.log("new-datasheet", f"New datasheet found: {doc['title']}",
                    document=doc["id"], product=product["id"], revision=digest)
        return

    previous = current_revision(doc)
    doc["revisions"].append(revision)
    doc["last_checked"] = revision["captured_at"]
    summary.new_revisions += 1
    log.info("  revised datasheet: %s", doc["title"])
    counts = recheck_specs(catalog, doc, previous, revision, pages)
    summary.values_confirmed += counts[verify.CONFIRMED]
    summary.values_updated += counts[verify.UPDATED]
    summary.values_need_check += counts[verify.NEEDS_CHECK]
    catalog.log(
        "datasheet-revised",
        f"Datasheet changed: {doc['title']} "
        f"({counts[verify.CONFIRMED]} values confirmed, {counts[verify.UPDATED]} updated, "
        f"{counts[verify.NEEDS_CHECK]} need checking)",
        document=doc["id"], product=doc["product"], revision=digest, previous_revision=previous["sha256"],
    )


def recheck_specs(catalog: Catalog, doc: dict, previous: dict, revision: dict, pages) -> dict:
    counts = {verify.CONFIRMED: 0, verify.UPDATED: 0, verify.NEEDS_CHECK: 0}
    checked_at = revision["captured_at"]
    for spec in catalog.specs_for_document(doc["id"]):
        outcome = verify.recheck(spec, pages)
        counts[outcome["status"]] += 1

        # Keep the state being replaced, so the site can show "previously ...".
        spec.setdefault("history", []).insert(0, {
            key: spec.get(key)
            for key in ("value", "numeric", "page", "evidence", "anchor", "revision", "status", "reviewed_by", "checked_at")
            if spec.get(key) is not None
        })

        spec["status"] = outcome["status"]
        spec["checked_at"] = checked_at
        spec.pop("reviewed_by", None)
        field = catalog.field(spec["field"])
        if outcome["status"] == verify.NEEDS_CHECK:
            # The value (and its "revision") still come from the older datasheet.
            catalog.log(
                "needs-check",
                f"{field['label']} was not found in the new datasheet; showing the previous value",
                product=spec["product"], field=spec["field"], document=doc["id"],
                revision=revision["sha256"], previous_revision=previous["sha256"],
            )
            continue
        spec["revision"] = revision["sha256"]
        spec["page"] = outcome["page"]
        spec["evidence"] = outcome["evidence"]
        if outcome["status"] == verify.UPDATED:
            catalog.log(
                "value-changed",
                f"{field['label']}: {spec['value']} → {outcome['value']} {field.get('unit', '')}".strip(),
                product=spec["product"], field=spec["field"], document=doc["id"],
                previous_value=spec["value"], value=outcome["value"],
                revision=revision["sha256"], previous_revision=previous["sha256"],
            )
            spec["value"] = outcome["value"]
            spec["numeric"] = outcome["numeric"]
            spec.pop("anchor", None)  # the new evidence is the extracted text itself
    return counts
