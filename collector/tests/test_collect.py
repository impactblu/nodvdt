import tempfile
import unittest
from pathlib import Path

from collector import collect, config, validate
from collector.fetch import datasheet_links
from collector.store import Catalog

from helpers import FakeWeb, make_pdf, write_repo

PAGE = "https://maker.example/pcs"
PDF_URL = "https://files.maker.example/ds/PCS-4800.pdf"
FIELDS = [
    {"key": "rated_kva", "label": "Rated apparent power", "unit": "kVA", "kind": "number"},
    {"key": "enclosure", "label": "Enclosure rating", "unit": "", "kind": "text"},
]
SUPPLIERS = [{
    "id": "maker", "name": "Maker", "products": [{
        "id": "maker-pcs-4800", "model": "PCS 4800",
        "sources": [{"name": "Product page", "url": PAGE,
                     "allowed_hosts": ["maker.example", "files.maker.example"], "link_pattern": "datasheet, pcs"}],
    }],
}]
HTML = f'<html><a href="{PDF_URL}">Datasheet</a><a href="/about.pdf">Company</a></html>'.encode()
V1 = make_pdf([["Cover"], ["AC Output Power 4800 kVA", "Degree of Protection NEMA 3R"]])
V2 = make_pdf([["Cover"], ["AC Output Power 5000 kVA", "Degree of Protection IP55"]])
V3 = make_pdf([["Cover v3"], ["AC Output Power 5000 kVA", "Degree of Protection IP55"]])


def settings(root):
    return config.Settings(repo_dir=root, github_repo="x/y", github_token="", branch="main", push=False,
                           check_interval_hours=24, request_delay_seconds=1, max_file_mb=5,
                           user_agent="test", git_author_name="t", git_author_email="t@example.com")


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write_repo(self.root, SUPPLIERS, FIELDS)

    def tearDown(self):
        self.tmp.cleanup()

    def run_with(self, pdf_body):
        web = FakeWeb({"maker.example", "files.maker.example"}, {PAGE: HTML, PDF_URL: pdf_body})
        catalog = Catalog.load(self.root)
        summary = collect.run(catalog, settings(self.root), fetcher_factory=lambda hosts: web)
        catalog.save()
        return Catalog.load(self.root), summary, web

    def add_reviewed_specs(self):
        catalog = Catalog.load(self.root)
        doc = catalog.documents[0]
        rev = doc["revisions"][0]["sha256"]
        catalog.specs = [
            {"id": "maker-pcs-4800:rated_kva", "product": "maker-pcs-4800", "field": "rated_kva",
             "value": "4800", "numeric": 4800, "evidence": "AC Output Power 4800 kVA", "document": doc["id"],
             "revision": rev, "page": 2, "status": "reviewed", "reviewed_by": "Test", "history": []},
            {"id": "maker-pcs-4800:enclosure", "product": "maker-pcs-4800", "field": "enclosure",
             "value": "NEMA 3R", "evidence": "Degree of Protection NEMA 3R", "document": doc["id"],
             "revision": rev, "page": 2, "status": "reviewed", "reviewed_by": "Test", "history": []},
        ]
        catalog.save()

    def test_new_datasheet_is_discovered_and_archived(self):
        catalog, summary, _ = self.run_with(V1)
        self.assertEqual(summary.new_documents, 1)
        doc = catalog.documents[0]
        self.assertEqual(doc["url"], PDF_URL)
        self.assertEqual(doc["product"], "maker-pcs-4800")
        self.assertEqual(doc["revisions"][0]["pages"], 2)
        self.assertEqual((self.root / doc["revisions"][0]["file"]).read_bytes(), V1)
        self.assertEqual(catalog.changes[0]["type"], "new-datasheet")
        self.assertEqual(catalog.status["summary"]["new_documents"], 1)
        self.assertEqual(validate.problems(self.root), [])

    def test_unchanged_datasheet_changes_nothing_and_uses_conditional_request(self):
        self.run_with(V1)
        catalog, summary, web = self.run_with(V1)
        self.assertFalse(summary.changed)
        self.assertEqual(len(catalog.documents[0]["revisions"]), 1)
        pdf_requests = [h for url, h in web.requests if url == PDF_URL]
        self.assertIn("If-None-Match", pdf_requests[0])

    def test_revised_datasheet_updates_values_and_keeps_previous_revision(self):
        self.run_with(V1)
        self.add_reviewed_specs()
        catalog, summary, _ = self.run_with(V2)

        self.assertEqual(summary.new_revisions, 1)
        doc = catalog.documents[0]
        old_rev, new_rev = doc["revisions"]
        self.assertTrue((self.root / old_rev["file"]).exists(), "old datasheet must stay downloadable")
        self.assertTrue((self.root / new_rev["file"]).exists())

        power = next(s for s in catalog.specs if s["field"] == "rated_kva")
        self.assertEqual(power["status"], "updated")
        self.assertEqual(power["value"], "5000")
        self.assertEqual(power["revision"], new_rev["sha256"])
        self.assertEqual(power["history"][0]["value"], "4800")
        self.assertEqual(power["history"][0]["revision"], old_rev["sha256"])
        self.assertEqual(power["history"][0]["status"], "reviewed")
        self.assertNotIn("reviewed_by", power)

        enclosure = next(s for s in catalog.specs if s["field"] == "enclosure")
        self.assertEqual(enclosure["status"], "needs-check")
        self.assertEqual(enclosure["value"], "NEMA 3R")
        self.assertEqual(enclosure["revision"], old_rev["sha256"], "value still comes from the old datasheet")

        types = [c["type"] for c in catalog.changes]
        self.assertIn("value-changed", types)
        self.assertIn("needs-check", types)
        self.assertIn("datasheet-revised", types)
        self.assertEqual(validate.problems(self.root), [])

    def test_third_revision_confirms_and_history_grows(self):
        self.run_with(V1)
        self.add_reviewed_specs()
        self.run_with(V2)
        catalog, _, _ = self.run_with(V3)
        power = next(s for s in catalog.specs if s["field"] == "rated_kva")
        self.assertEqual(power["status"], "confirmed")
        self.assertEqual([h["value"] for h in power["history"]], ["5000", "4800"])
        self.assertEqual(len(catalog.documents[0]["revisions"]), 3)

    def test_web_page_instead_of_pdf_is_reported(self):
        catalog, summary, _ = self.run_with(b"<html>Please sign in</html>")
        self.assertEqual(catalog.documents, [])
        self.assertTrue(summary.errors)
        self.assertFalse(catalog.status["sources"][0]["ok"])

    def test_link_discovery_respects_hosts_and_patterns(self):
        html = (b'<a href="https://files.maker.example/a/PCS-datasheet.pdf">Download</a>'
                b'<a href="https://evil.example/pcs.pdf">pcs</a>'
                b'<a href="/brochure.pdf">Brochure</a>'
                b'<a href="/dl?id=4" download>PCS datasheet</a>')
        links = datasheet_links(html, "https://maker.example/p", {"maker.example", "files.maker.example"},
                                ["datasheet"])
        self.assertEqual(links, ["https://files.maker.example/a/PCS-datasheet.pdf",
                                 "https://maker.example/dl?id=4"])


class RealDataTests(unittest.TestCase):
    def test_repository_data_is_consistent(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(validate.problems(root), [])


if __name__ == "__main__":
    unittest.main()
