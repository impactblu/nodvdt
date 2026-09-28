import json
import unittest
from pathlib import Path

from collector import extraction
from collector.extract import Chunk, assign_to_columns, extract, extract_from_pages
from collector.store import Catalog

PE = r"\bFP\d{4}M[A-Z]{0,2}\d?\b"

MODEL_TABLE = """
REFERENCES                                   FP5020MH        FP5021MH        FP5022MH        FP5026MH
          AC Output Power (kVA/kW) @30 °C [1]                    5240
          AC Output Power (kVA/kW) @40 °C       [1]
                                                                 4800
          Operating Grid Voltage (kV)        34.5 kV ±10%    33 kV ±10%      30 kV ±10%      33 kV ±10%
          Operating Grid Frequency (Hz)         60 Hz                    50 Hz                   60 Hz
          Maximum DC Voltage                                     1500 V
          Max. DC Continuous Current (A)       2740            1370            2740            1370
          Grid Forming (VISMA) / Black Start Capable             Standard
          Operating Temperature Range [4]       From -40 °C to +60 °C, >30 °C power derating
"""

LABEL_VALUE = """
      Type designation                                                   SC5000UD-MV-US-P3
      Max. DC voltage                                                             1500 V
      Max. DC current                                 1275 A * 4                       2550 A * 2
      AC output power                                            5000 kVA @ 45 ℃ ( 113 ℉ )
      Max.Converter unit efficiency                                               99.0 %
      Max.efficiency (including transformer)                                      98.3 %
                                                         -35 ℃ ~ 60 ℃ ( > 45 ℃ derating )
      Operating ambient temperature range
                                                        -31 ℉ ~ 140 ℉ ( > 113 ℉ derating )
      Weight                                                       ≤ 17000 kg / 37478 lbs
"""

COLON_LIST = """
Maximum Apparent Power:                         875kVA (@350VAC)      DC Disconnect
                                               1200kVA (@480VAC)
                                               1500kVA (@600VAC)
                                                                      Software Protections
Maximum Efficiency:                                         98.5%
CEC Efficiency:                                               97%
Enclosure:                               NEMA 1/IP 20 (Indoor)
                                       NEMA 3R/IP 54 (Outdoor)
Weight:                                          3,080 lbs (Indoor)
"""


def by(cands, model, field):
    return next((c for c in cands if c.model == model and c.field == field), None)


class ColumnAssignmentTests(unittest.TestCase):
    def test_merged_cells_cover_the_columns_beneath_them(self):
        centers = [10, 30, 50, 70]
        cells = [Chunk(8, 12, "a"), Chunk(38, 42, "b"), Chunk(68, 72, "c")]  # b spans columns 2 and 3
        self.assertEqual(assign_to_columns(cells, centers), [[0], [1, 2], [3]])
        self.assertEqual(assign_to_columns([Chunk(38, 42, "x")], centers), [[0, 1, 2, 3]])

    def test_more_cells_than_columns_is_rejected(self):
        self.assertIsNone(assign_to_columns([Chunk(0, 1, "a")] * 3, [10, 20]))


class ModelTableTests(unittest.TestCase):
    def setUp(self):
        self.c = extract_from_pages([MODEL_TABLE], PE)

    def test_per_model_values_and_merged_cells(self):
        self.assertEqual(by(self.c, "FP5021MH", "mv_voltage_kv").value, "33 ±10%")
        self.assertEqual(by(self.c, "FP5022MH", "mv_voltage_kv").value, "30 ±10%")
        self.assertEqual(by(self.c, "FP5020MH", "frequency_hz").value, "60")
        self.assertEqual(by(self.c, "FP5021MH", "frequency_hz").value, "50")   # merged over 2 columns
        self.assertEqual(by(self.c, "FP5022MH", "frequency_hz").value, "50")
        self.assertEqual(by(self.c, "FP5026MH", "frequency_hz").value, "60")
        self.assertEqual(by(self.c, "FP5021MH", "max_dc_current_a").value, "1370")

    def test_preferred_rating_row_and_wrapped_value(self):
        power = by(self.c, "FP5026MH", "rated_kva")
        self.assertEqual(power.value, "4800")            # the 40 °C row, value on the next line
        self.assertIn("@40 °C", power.conditions)

    def test_label_note_and_ranges(self):
        self.assertEqual(by(self.c, "FP5020MH", "gfm").value, "Standard (VISMA)")
        self.assertEqual(by(self.c, "FP5020MH", "temp_min_c").value, "-40")
        self.assertEqual(by(self.c, "FP5020MH", "temp_max_c").value, "60")
        self.assertEqual(by(self.c, "FP5020MH", "derating").value, "Above 30 °C")

    def test_evidence_names_the_model_and_anchor_is_the_real_row(self):
        v = by(self.c, "FP5022MH", "mv_voltage_kv")
        self.assertIn("FP5022MH", v.evidence)
        self.assertTrue(v.anchor.startswith("Operating Grid Voltage (kV) 34.5 kV"))


class LabelValueTests(unittest.TestCase):
    def setUp(self):
        self.c = extract_from_pages([LABEL_VALUE], r"\bSC\d{4}UD[-A-Z0-9]*\b")

    def test_values(self):
        m = "SC5000UD-MV-US-P3"
        self.assertEqual(by(self.c, m, "dc_max_v").value, "1500")
        self.assertEqual(by(self.c, m, "rated_kva").value, "5000")
        self.assertEqual(by(self.c, m, "efficiency_max_pct").value, "99.0")
        self.assertEqual(by(self.c, m, "efficiency_with_mvt_pct").value, "98.3")
        self.assertEqual(by(self.c, m, "weight_kg").value, "≤17000")

    def test_value_wrapped_above_the_label_is_found_and_fahrenheit_ignored(self):
        m = "SC5000UD-MV-US-P3"
        self.assertEqual(by(self.c, m, "temp_min_c").value, "-35")
        self.assertEqual(by(self.c, m, "derating").value, "Above 45 °C")

    def test_two_configurations_in_one_row_are_skipped(self):
        self.assertIsNone(by(self.c, "SC5000UD-MV-US-P3", "max_dc_current_a"))


class ColonListTests(unittest.TestCase):
    def setUp(self):
        self.c = extract_from_pages([COLON_LIST])

    def test_highest_rating_with_its_condition(self):
        power = by(self.c, None, "rated_kva")
        self.assertEqual(power.value, "1500")
        self.assertEqual(power.conditions, "@600VAC")
        self.assertNotIn("Software", power.evidence)

    def test_percent_values_and_text_continuations(self):
        self.assertEqual(by(self.c, None, "efficiency_max_pct").value, "98.5")
        self.assertEqual(by(self.c, None, "efficiency_weighted_pct").value, "97")
        self.assertEqual(by(self.c, None, "enclosure").value, "NEMA 1/IP 20 (Indoor); NEMA 3R/IP 54 (Outdoor)")

    def test_pounds_are_not_reported_as_kilograms(self):
        self.assertIsNone(by(self.c, None, "weight_kg"))


class RealDatasheetTests(unittest.TestCase):
    """The extractor must agree with the values that were reviewed by hand."""

    root = Path(__file__).resolve().parents[2]

    def test_reviewed_values_are_reproduced(self):
        catalog = Catalog.load(self.root)
        reviewed = [s for s in catalog.specs if s.get("reviewed_by") or s.get("history")]
        if not reviewed:
            self.skipTest("no reviewed values in this data folder")
        tokens = {"power-electronics-fp5020mu-pcsm-690-v-ul": "FP5020MU", "sungrow-sc5000ud-mv-us-p3": "SC5000UD-MV-US-P3"}
        checked = mismatched = 0
        for spec in reviewed:
            if spec["product"] not in tokens or spec["status"] == "needs-check":
                continue
            doc = catalog.document_by_id(spec["document"])
            path = self.root / doc["revisions"][-1]["file"]
            if not path.exists():
                continue
            cands = extraction.candidates_for(catalog, doc, path)
            got = by(cands, tokens[spec["product"]], spec["field"])
            if got is None:
                continue
            checked += 1
            same = got.value == spec["value"] or (got.numeric is not None and got.numeric == spec.get("numeric"))
            if not same:
                mismatched += 1
                print("mismatch", spec["id"], spec["value"], got.value)
        self.assertGreaterEqual(checked, 20)
        self.assertEqual(mismatched, 0)


if __name__ == "__main__":
    unittest.main()


class RecheckExtractedTests(unittest.TestCase):
    def spec(self):
        return {"field": "mv_voltage_kv", "value": "33 ±10%", "numeric": 33.0, "page": 1,
                "evidence": "old", "extractor": {"version": "rules-1", "model": "FP5021MH"}}

    def test_same_value_confirms_changed_value_updates_missing_needs_check(self):
        cands = extract_from_pages([MODEL_TABLE], PE)
        self.assertEqual(extraction.recheck_extracted(self.spec(), cands)["status"], "confirmed")
        changed = extract_from_pages([MODEL_TABLE.replace("33 kV ±10%      30 kV", "34 kV ±10%      30 kV")], PE)
        out = extraction.recheck_extracted(self.spec(), changed)
        self.assertEqual((out["status"], out["value"]), ("updated", "34 ±10%"))
        gone = extract_from_pages([MODEL_TABLE.replace("Operating Grid Voltage (kV)", "Something else")], PE)
        self.assertEqual(extraction.recheck_extracted(self.spec(), gone)["status"], "needs-check")


class DcInputsTests(unittest.TestCase):
    def test_number_of_dc_inputs(self):
        page = LABEL_VALUE.replace(
            "      Max. DC current",
            "      No. of DC inputs                                                                4\n      Max. DC current")
        cands = extract_from_pages([page], r"\bSC\d{4}UD[-A-Z0-9]*\b")
        self.assertEqual(next(c for c in cands if c.field == "dc_inputs").value, "4")
