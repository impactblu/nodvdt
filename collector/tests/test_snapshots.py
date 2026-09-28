import tempfile
import unittest
from pathlib import Path

from collector import snapshots
from collector.snapshots import Line, locate
from helpers import make_pdf

W, H = 600.0, 800.0


def spec(evidence, value, model=None):
    s = {"evidence": evidence, "value": value}
    if model:
        s["extractor"] = {"version": "rules-1", "model": model}
    return s


class LocateTests(unittest.TestCase):
    def test_label_value_row(self):
        lines = (
            Line(52, 120, 110, 129, "Max. DC voltage"), Line(400, 120, 430, 129, "1500 V"),
            Line(52, 139, 115, 148, "AC output power"), Line(361, 139, 454, 148, "5000 kVA @ 45 ℃ ( 113 ℉ )"),
            Line(52, 158, 140, 167, "Max. AC output current"), Line(400, 158, 420, 167, "83 A"),
        )
        box = locate(spec("AC output power 5000 kVA @ 45 ℃ ( 113 ℉ )", "5000 kVA"), W, H, lines)
        x0, y0, x1, y1 = box["row"]
        self.assertAlmostEqual(y0 * H, 137.5, places=0)
        self.assertAlmostEqual(y1 * H, 149.5, places=0)
        self.assertGreater(x1 * W, 454)
        self.assertNotIn("cell", box)

    def test_model_column_picks_the_models_cell(self):
        lines = (
            Line(300, 40, 350, 49, "FP5020MH"), Line(380, 40, 430, 49, "FP5021MH"), Line(460, 40, 510, 49, "FP5022MH"),
            Line(170, 60, 290, 69, "Max. DC Continuous Current (A)"),
            Line(310, 60, 335, 69, "2740"), Line(390, 60, 415, 69, "1370"), Line(470, 60, 495, 69, "2740"),
        )
        box = locate(spec("Max. DC Continuous Current (A) — FP5021MH: 1370", "1370", "FP5021MH"), W, H, lines, "FP5021MH")
        self.assertAlmostEqual(box["cell"][0] * W, 388.5, places=0)
        self.assertLess(box["row"][0] * W, 170)

    def test_group_label_to_the_left_is_not_part_of_the_row(self):
        lines = (Line(50, 100, 100, 110, "CONTROL"),
                 Line(170, 98, 330, 107, "Grid Forming (VISMA) / Black Start Capable"),
                 Line(450, 98, 490, 107, "Standard"))
        box = locate(spec("Grid Forming (VISMA) / Black Start Capable — FP4999MH4: Standard", "Standard"), W, H, lines)
        self.assertGreater(box["row"][0] * W, 160)

    def test_quoted_multiline_value_ignores_the_other_column(self):
        lines = (Line(70, 300, 160, 310, "Maximum Real Power:"), Line(290, 300, 400, 310, "875kW (@350V"),
                 Line(290, 314, 400, 324, "1200kW (@480V"), Line(290, 328, 400, 338, "1500kW (@600V"),
                 Line(440, 298, 590, 312, "Software Protections"))
        box = locate(spec("Maximum Real Power: 875kW (@350VAC) / 1200kW (@480VAC) / 1500kW (@600VAC)", "1500"),
                     W, H, lines)
        self.assertLess(box["row"][2] * W, 420)
        self.assertGreater(box["row"][3] * H, 336)

    def test_unknown_label_gives_no_box(self):
        self.assertIsNone(locate(spec("Nothing like this here", "5"), W, H, (Line(0, 0, 10, 10, "abc def"),)))


class RenderTests(unittest.TestCase):
    def test_render_and_layout_of_a_real_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "a.pdf"
            pdf.write_bytes(make_pdf([["Cover"], ["AC Output Power 4800 kVA", "Degree of Protection NEMA 3R"]]))
            target = Path(tmp) / "page-2.jpg"
            self.assertTrue(snapshots.render_page(pdf, 2, target))
            self.assertEqual(target.read_bytes()[:2], b"\xff\xd8")
            width, height, lines = snapshots.page_layout(str(pdf), 2)
            self.assertEqual((width, height), (612.0, 792.0))
            box = locate(spec("Degree of Protection NEMA 3R", "NEMA 3R"), width, height, lines)
            self.assertIsNotNone(box)
            self.assertTrue(0 < box["row"][1] < box["row"][3] < 1)


if __name__ == "__main__":
    unittest.main()
