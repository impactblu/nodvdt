import unittest

from collector import verify


def spec(value, evidence, **extra):
    return {"value": value, "numeric": verify.to_number(value), "evidence": evidence, "page": 1, **extra}


def pages(*texts):
    return [[text] for text in texts]


class RecheckTests(unittest.TestCase):
    def test_same_line_is_confirmed_despite_spacing(self):
        result = verify.recheck(spec("1500", "Max. DC voltage 1500 V"),
                                pages("intro", "Max.  DC\nvoltage   1500V"))
        self.assertEqual(result["status"], verify.CONFIRMED)
        self.assertEqual(result["page"], 2)

    def test_celsius_symbol_variants_match(self):
        result = verify.recheck(spec("60", "range -35 ℃ ~ 60 ℃"), pages("range -35 °C ~ 60 °C"))
        self.assertEqual(result["status"], verify.CONFIRMED)

    def test_changed_number_is_published(self):
        result = verify.recheck(spec("4800", "AC Output Power (kVA/kW) @40 °C 4800 kVA"),
                                pages("AC Output Power (kVA/kW) @40 °C 5000 kVA"))
        self.assertEqual(result["status"], verify.UPDATED)
        self.assertEqual(result["value"], "5000")
        self.assertEqual(result["numeric"], 5000)
        self.assertIn("5000", result["evidence"])

    def test_number_with_different_unit_is_not_taken(self):
        # A Fahrenheit row right after a Celsius label must not become the new value.
        result = verify.recheck(spec("-35", "Operating ambient temperature range -35 °C ~ 60 °C"),
                                pages("Operating ambient temperature range\n-31 °F ~ 140 °F"))
        self.assertEqual(result["status"], verify.NEEDS_CHECK)
        self.assertEqual(result["value"], "-35")

    def test_implausible_jump_needs_check(self):
        result = verify.recheck(spec("1500", "Maximum DC Voltage 1500 V"),
                                pages("Maximum DC Voltage 15 V"))
        self.assertEqual(result["status"], verify.NEEDS_CHECK)

    def test_missing_line_needs_check(self):
        result = verify.recheck(spec("NEMA 3R", "Degree of Protection NEMA 3R"),
                                pages("Degree of Protection IP55"))
        self.assertEqual(result["status"], verify.NEEDS_CHECK)
        self.assertEqual(result["value"], "NEMA 3R")

    def test_anchor_is_used_for_matching(self):
        s = spec("5000", "AC output power 5000 kVA @ 45 ℃", anchor="5000 kVA @ 45 ℃")
        result = verify.recheck(s, pages("AC output power\nMax current\n5000 kVA @ 45 °C"))
        self.assertEqual(result["status"], verify.CONFIRMED)
        self.assertEqual(result["evidence"], s["evidence"])

    def test_value_inside_a_larger_number_is_not_used_as_split_point(self):
        self.assertIsNone(verify.split_on_value("Weight 14000 kg", "400"))
        self.assertEqual(verify.split_on_value("Weight (kg) 14000", "14000"), ("weight(kg)", "", ""))

    def test_value_at_start_of_anchor_is_read_from_the_text_after_it(self):
        s = spec("5000", "AC output power 5000 kVA @ 45 °C (113 °F)", anchor="5000 kVA @ 45 °C (113 °F)")
        result = verify.recheck(s, pages("AC output power\n5250 kVA @ 45 °C ( 113 °F )"))
        self.assertEqual(result["status"], verify.UPDATED)
        self.assertEqual(result["value"], "5250")


if __name__ == "__main__":
    unittest.main()
