"""Independent semantic tests for the Meridian Kiln schedule oracle.

Schedules are built from the English requirements and reference dataset.
This file does not read a plan, solver output, or candidate delivery.
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
ORACLE = ROOT / "oracle.py"
LIMIT = 16384
NAME = "schedule.json"


def primary():
    """Feasible schedule. Import count is 1, recycled count is 2, spend is 30180.

    Inclusive bounds used on purpose: north temper capacity 10, harbor temper
    thickness minimum 25, dune temper thickness maximum 40, and gate kiln
    thickness minimum 30.
    """
    return {
        "charges": [
            {"release_id": "R-NORTH", "lot_id": "L-IR-12", "kiln_id": "K-04", "panels": "10", "clay_kg": "120"},
            {"release_id": "R-HARBOR", "lot_id": "L-KA-03", "kiln_id": "K-01", "panels": "12", "clay_kg": "96"},
            {"release_id": "R-DUNE", "lot_id": "L-SP-04", "kiln_id": "K-05", "panels": "8", "clay_kg": "80"},
            {"release_id": "R-GATE", "lot_id": "L-KA-11", "kiln_id": "K-02", "panels": "9", "clay_kg": "81"},
        ],
        "finishes": [
            {"release_id": "R-NORTH", "bench_id": "B-01", "temper_id": "T-02", "panels": "10"},
            {"release_id": "R-HARBOR", "bench_id": "B-03", "temper_id": "T-04", "panels": "12"},
            {"release_id": "R-DUNE", "bench_id": "B-02", "temper_id": "T-03", "panels": "8"},
            {"release_id": "R-GATE", "bench_id": "B-05", "temper_id": "T-01", "panels": "9"},
        ],
    }


def alternative():
    """A second feasible schedule with different lots, kilns, and benches. Spend is 31840."""
    return {
        "charges": [
            {"release_id": "R-GATE", "lot_id": "L-KA-03", "kiln_id": "K-01", "panels": "9", "clay_kg": "81"},
            {"release_id": "R-DUNE", "lot_id": "L-SP-15", "kiln_id": "K-05", "panels": "8", "clay_kg": "80"},
            {"release_id": "R-HARBOR", "lot_id": "L-KA-24", "kiln_id": "K-03", "panels": "12", "clay_kg": "96"},
            {"release_id": "R-NORTH", "lot_id": "L-IR-07", "kiln_id": "K-02", "panels": "10", "clay_kg": "120"},
        ],
        "finishes": [
            {"release_id": "R-GATE", "bench_id": "B-06", "temper_id": "T-03", "panels": "9"},
            {"release_id": "R-DUNE", "bench_id": "B-01", "temper_id": "T-02", "panels": "8"},
            {"release_id": "R-HARBOR", "bench_id": "B-04", "temper_id": "T-04", "panels": "12"},
            {"release_id": "R-NORTH", "bench_id": "B-02", "temper_id": "T-01", "panels": "10"},
        ],
    }


class OracleTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="kiln-oracle-")
        self.addCleanup(self.scratch.cleanup)
        self.recovered = Path(self.scratch.name) / "recovered"
        self.recovered.mkdir()
        self.write(primary())

    def write(self, document):
        (self.recovered / NAME).write_text(json.dumps(document), encoding="utf-8")

    def raw(self, payload):
        (self.recovered / NAME).write_bytes(payload)

    def encoded_bytes(self):
        payload = (self.recovered / NAME).read_bytes()
        return 3 + 2 + len(NAME.encode("ascii")) + 4 + len(payload)

    def run_oracle(self, *args):
        self.assertTrue(ORACLE.is_file(), "oracle CLI is not implemented")
        run = subprocess.run(
            [sys.executable, "-B", str(ORACLE), *args],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(run.stderr, "")
        return run

    def report(self, accepted, errors):
        run = self.run_oracle(str(self.recovered))
        self.assertEqual(run.returncode, 0 if accepted else 1, run.stdout)
        report = json.loads(run.stdout)
        self.assertIs(report["accepted"], accepted)
        self.assertEqual(report["errors"], errors)
        if accepted or errors and errors[0] not in {
            "JSON", "JSON_LIMIT", "SCHEMA", "RECORD_LIMIT", "FILE_SET", "FILE_TYPE",
            "BUNDLE_LIMIT", "REFERENCE", "INPUT", "LOOKUP", "ARITHMETIC", "USAGE",
        }:
            self.assertEqual(report["encoded_bytes"], self.encoded_bytes())
        else:
            self.assertNotIn("encoded_bytes", report)
        return report

    def row(self, collection, release):
        document = json.loads((self.recovered / NAME).read_text(encoding="utf-8"))
        for row in document[collection]:
            if row["release_id"] == release:
                return document, row
        self.fail(f"missing {collection} row {release}")

    def update(self, collection, release, **fields):
        document, row = self.row(collection, release)
        row.update(fields)
        self.write(document)
        return document

    def test_usage(self):
        run = self.run_oracle()
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(run.stdout), {"accepted": False, "errors": ["USAGE"]})
        run = self.run_oracle(str(self.recovered), "extra")
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(run.stdout), {"accepted": False, "errors": ["USAGE"]})

    def test_primary_meets_every_requirement(self):
        self.report(True, [])

    def test_alternative_assignment_is_also_accepted(self):
        self.write(alternative())
        self.report(True, [])

    def test_row_order_and_unprojected_fields_do_not_matter(self):
        document = primary()
        document["charges"].reverse()
        document["finishes"] = list(reversed(document["finishes"]))
        document["charges"][0]["note"] = "unprojected"
        document["ignored"] = {"also": "unprojected"}
        self.write(document)
        self.report(True, [])

    def test_padding_below_bundle_ceiling_stays_accepted(self):
        payload = json.dumps(primary()).encode("utf-8")
        room = LIMIT - (3 + 2 + len(NAME) + 4)
        self.raw(payload + b" " * (room - len(payload)))
        self.report(True, [])

    def test_bundle_one_byte_over_ceiling_is_invalid(self):
        payload = json.dumps(primary()).encode("utf-8")
        room = LIMIT - (3 + 2 + len(NAME) + 4)
        self.raw(payload + b" " * (room - len(payload) + 1))
        self.report(False, ["BUNDLE_LIMIT"])

    def test_missing_schedule_is_invalid(self):
        (self.recovered / NAME).unlink()
        self.report(False, ["FILE_SET"])

    def test_extra_file_is_invalid(self):
        (self.recovered / "note.json").write_text("{}", encoding="utf-8")
        self.report(False, ["FILE_SET"])

    def test_symlink_schedule_is_invalid(self):
        target = self.recovered / NAME
        held = Path(self.scratch.name) / "held.json"
        held.write_bytes(target.read_bytes())
        target.unlink()
        target.symlink_to(held)
        self.report(False, ["FILE_TYPE"])

    def test_symlink_directory_is_invalid(self):
        real = self.recovered
        link = Path(self.scratch.name) / "linked"
        link.symlink_to(real, target_is_directory=True)
        run = self.run_oracle(str(link))
        self.assertEqual(run.returncode, 1)
        self.assertEqual(json.loads(run.stdout)["errors"], ["FILE_TYPE"])

    def test_malformed_json_duplicate_key_and_depth(self):
        self.raw(b"{")
        self.report(False, ["JSON"])
        self.raw(b'{"charges": [], "charges": []}')
        self.report(False, ["JSON"])
        nested = "0"
        for _ in range(33):
            nested = "[" + nested + "]"
        self.raw(nested.encode("ascii"))
        self.report(False, ["JSON_LIMIT"])

    def test_noncanonical_and_nonstring_integers(self):
        self.update("charges", "R-NORTH", panels="01")
        self.report(False, ["SCHEMA"])
        self.write(primary())
        self.update("charges", "R-NORTH", panels="+10")
        self.report(False, ["SCHEMA"])
        self.write(primary())
        self.update("charges", "R-NORTH", panels="-0")
        self.report(False, ["SCHEMA"])
        self.write(primary())
        self.update("charges", "R-NORTH", clay_kg="9223372036854775808")
        self.report(False, ["SCHEMA"])
        self.write(primary())
        self.update("charges", "R-NORTH", panels="-9223372036854775809")
        self.report(False, ["SCHEMA"])
        self.write(primary())
        document = primary()
        document["charges"][0]["panels"] = 10
        self.write(document)
        self.report(False, ["SCHEMA"])
        document = primary()
        del document["finishes"]
        self.write(document)
        self.report(False, ["SCHEMA"])

    def test_too_many_rows_is_invalid(self):
        document = primary()
        document["wide"] = list(range(257))
        self.write(document)
        self.report(False, ["JSON_LIMIT"])
        document = primary()
        document["charges"] = [
            {"release_id": f"R-{index}", "lot_id": "L", "kiln_id": "K", "panels": "1", "clay_kg": "1"}
            for index in range(257)
        ]
        self.write(document)
        self.report(False, ["BUNDLE_LIMIT"])

    def test_unknown_ids_are_lookup_aborts(self):
        for collection, fields in (
            ("charges", {"release_id": "R-OTHER"}),
            ("charges", {"lot_id": "L-OTHER"}),
            ("charges", {"kiln_id": "K-OTHER"}),
            ("finishes", {"release_id": "R-OTHER"}),
            ("finishes", {"bench_id": "B-OTHER"}),
            ("finishes", {"temper_id": "T-OTHER"}),
        ):
            self.write(primary())
            release = "R-NORTH"
            self.update(collection, release, **fields)
            self.report(False, ["LOOKUP"])

    def test_finish_without_its_charge_is_lookup_abort(self):
        document = primary()
        document["charges"] = [row for row in document["charges"] if row["release_id"] != "R-GATE"]
        self.write(document)
        self.report(False, ["LOOKUP"])

    def test_duplicate_charge_release_is_lookup_abort(self):
        self.update("charges", "R-DUNE", release_id="R-NORTH")
        self.report(False, ["LOOKUP"])

    def test_duplicate_charge_release_without_finishes_is_a_verdict(self):
        # No finish runs the charge lookup, so duplicate release ids are a verdict.
        # The renamed dune row still carries speckle mass, so quantity, mass, and lot fail too.
        document = primary()
        document["finishes"] = []
        document["charges"][2]["release_id"] = "R-NORTH"
        self.write(document)
        self.report(False, [
            "CHARGE_CARDINALITY", "CHARGE_QUANTITY", "CLAY_MASS",
            "COVERAGE", "FINISH_CARDINALITY", "LOT",
        ])

    def test_dropped_release_is_cardinality_and_coverage(self):
        document = primary()
        document["charges"] = [row for row in document["charges"] if row["release_id"] != "R-GATE"]
        document["finishes"] = [row for row in document["finishes"] if row["release_id"] != "R-GATE"]
        self.write(document)
        self.report(False, ["CHARGE_CARDINALITY", "COVERAGE", "FINISH_CARDINALITY"])

    def test_duplicate_finish_release_is_semantic(self):
        document = primary()
        for row in document["finishes"]:
            if row["release_id"] == "R-GATE":
                row.update({
                    "release_id": "R-NORTH",
                    "bench_id": "B-01",
                    "temper_id": "T-02",
                    "panels": "10",
                })
        self.write(document)
        self.report(False, ["BENCH", "COVERAGE", "FINISH_CARDINALITY", "TEMPER"])

    def test_duplicate_resources_are_semantic(self):
        self.update("charges", "R-GATE", lot_id="L-KA-03")
        self.report(False, ["LOT"])
        self.write(primary())
        self.update("charges", "R-DUNE", kiln_id="K-02")
        self.report(False, ["KILN"])
        self.write(primary())
        self.update("finishes", "R-DUNE", bench_id="B-01")
        self.report(False, ["BENCH"])
        self.write(primary())
        self.update("finishes", "R-DUNE", temper_id="T-02")
        self.report(False, ["TEMPER"])

    def test_charge_quantity_must_match_release(self):
        self.update("charges", "R-NORTH", panels="9", clay_kg="108")
        self.update("finishes", "R-NORTH", panels="9")
        self.report(False, ["CHARGE_QUANTITY"])

    def test_finish_panels_must_match_charge(self):
        self.update("finishes", "R-NORTH", panels="9")
        self.report(False, ["CHARGE_FINISH"])

    def test_clay_mass_must_match_profile(self):
        self.update("charges", "R-NORTH", clay_kg="119")
        self.report(False, ["CLAY_MASS"])

    def test_lot_must_be_certified_and_large_enough(self):
        self.update("charges", "R-NORTH", lot_id="L-IR-19")
        self.report(False, ["LOT"])
        self.write(primary())
        self.update("charges", "R-DUNE", lot_id="L-SP-21")
        self.report(False, ["LOT"])

    def test_kiln_thickness_family_and_capacity(self):
        self.update("charges", "R-HARBOR", kiln_id="K-03")
        self.update("charges", "R-NORTH", kiln_id="K-01")
        self.report(False, ["KILN"])
        self.write(primary())
        self.update("charges", "R-NORTH", kiln_id="K-02")
        self.update("charges", "R-GATE", kiln_id="K-03")
        self.update("charges", "R-DUNE", kiln_id="K-04")
        self.report(False, ["KILN"])
        self.write(primary())
        self.update("charges", "R-DUNE", kiln_id="K-02")
        self.update("charges", "R-GATE", kiln_id="K-03")
        self.update("charges", "R-NORTH", kiln_id="K-05")
        self.report(False, ["KILN"])

    def test_bench_edge_must_match_profile(self):
        self.update("finishes", "R-NORTH", bench_id="B-04")
        self.report(False, ["BENCH"])

    def test_temper_capacity_and_class(self):
        self.update("finishes", "R-NORTH", temper_id="T-03")
        self.update("finishes", "R-DUNE", temper_id="T-02")
        self.report(False, ["TEMPER"])
        self.write(primary())
        self.update("finishes", "R-HARBOR", temper_id="T-01")
        self.update("finishes", "R-GATE", temper_id="T-04")
        self.report(False, ["TEMPER"])

    def test_import_ceiling(self):
        self.update("charges", "R-GATE", lot_id="L-KA-18")
        self.report(False, ["IMPORT_CEILING"])

    def test_spend_ceiling(self):
        self.update("charges", "R-NORTH", lot_id="L-IR-07")
        self.report(False, ["SPEND_CEILING"])

    def test_recycled_floor_is_independent_of_other_aggregates(self):
        self.update("charges", "R-HARBOR", lot_id="L-KA-11")
        self.update("charges", "R-GATE", lot_id="L-KA-24")
        self.report(False, ["RECYCLED_FLOOR", "SPEND_CEILING"])

    def test_product_overflow_is_arithmetic_not_a_verdict(self):
        self.update("charges", "R-NORTH", panels="9223372036854775807")
        self.report(False, ["ARITHMETIC"])

    def test_spend_overflow_is_arithmetic_not_a_verdict(self):
        self.update("charges", "R-NORTH", clay_kg="9223372036854775807")
        self.report(False, ["ARITHMETIC"])

    def test_missing_directory_is_invalid(self):
        missing = Path(self.scratch.name) / "absent"
        run = self.run_oracle(str(missing))
        self.assertEqual(run.returncode, 1)
        self.assertEqual(json.loads(run.stdout)["errors"], ["FILE_SET"])

    def test_directory_entry_named_schedule_is_invalid(self):
        target = self.recovered / NAME
        target.unlink()
        target.mkdir()
        self.report(False, ["FILE_TYPE"])


if __name__ == "__main__":
    unittest.main()
