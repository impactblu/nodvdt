import json
import unittest
from pathlib import Path

from collector.validate import _company_problems

SUPPLIERS = Path(__file__).resolve().parents[2] / "data" / "suppliers.json"


class CompanyBlockTests(unittest.TestCase):
    def test_published_suppliers_are_valid(self):
        for supplier in json.loads(SUPPLIERS.read_text(encoding="utf-8")):
            self.assertEqual(_company_problems(supplier), [], supplier["id"])

    def test_company_is_optional(self):
        self.assertEqual(_company_problems({"id": "x"}), [])

    def test_bad_values_are_reported(self):
        found = _company_problems({"id": "x", "company": {
            "hq_country": "China",
            "parent": {"name": "Parent", "country": "cn"},
            "sources": [{"title": "Site", "url": "http://example.com"}],
            "reviewed_by": "someone",
        }})
        self.assertEqual(len(found), 4)


if __name__ == "__main__":
    unittest.main()
