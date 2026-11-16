"""Semantic and import-boundary tests. Uses only the Python standard library."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
ORACLE = ROOT / "oracle.py"


class OracleTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="sprint-oracle-")
        self.addCleanup(self.scratch.cleanup)
        self.recovered = Path(self.scratch.name) / "recovered"
        shutil.copytree(ROOT / "candidates" / "valid", self.recovered)

    def result(self, accepted, code=None):
        self.assertTrue(ORACLE.is_file(), "oracle CLI is not implemented")
        run = subprocess.run(
            [sys.executable, "-B", str(ORACLE), str(self.recovered)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(run.stderr, "")
        self.assertEqual(run.returncode, 0 if accepted else 1, run.stdout)
        report = json.loads(run.stdout)
        self.assertIs(report["accepted"], accepted)
        if code:
            self.assertIn(code, report["errors"])
        return report

    def edit(self, name, change):
        path = self.recovered / name
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))

    def allocation(self, index, field, value):
        self.edit("allocations.json", lambda d: d["allocations"][index].__setitem__(field, value))

    def dispatch(self, index, field, value):
        self.edit("dispatch.json", lambda d: d["dispatches"][index].__setitem__(field, value))

    def alternative(self):
        for path in (ROOT / "candidates" / "alternative").iterdir():
            shutil.copyfile(path, self.recovered / path.name)

    def test_valid_at_budget_capacity_cutoff_and_guard_start(self):
        self.result(True)

    def test_valid_alternative_with_different_assignments_and_stamps(self):
        self.alternative()
        self.result(True)

    def test_order_and_extra_members_do_not_matter(self):
        def change(data):
            data["allocations"].reverse()
            data["ignored"] = "synthetic extra"
            data["allocations"][0]["ignored"] = True
        self.edit("allocations.json", change)
        self.result(True)

    def test_duplicate_task(self):
        self.allocation(7, "task_id", "T01")
        self.result(False, "TASK_SET")

    def test_missing_task(self):
        self.edit("allocations.json", lambda d: d["allocations"].pop())
        self.result(False, "TASK_SET")

    def test_foreign_task(self):
        self.allocation(7, "task_id", "T99")
        self.result(False, "TASK_SET")

    def test_foreign_allocation_pool(self):
        self.allocation(7, "pool_id", "P-X")
        self.result(False, "POOL_ID")

    def test_duplicate_dispatch_pool(self):
        self.dispatch(3, "pool_id", "P-A")
        self.result(False, "DISPATCH_SET")

    def test_missing_dispatch(self):
        self.edit("dispatch.json", lambda d: d["dispatches"].pop())
        self.result(False, "DISPATCH_SET")

    def test_foreign_dispatch_pool(self):
        self.dispatch(3, "pool_id", "P-X")
        self.result(False, "DISPATCH_SET")

    def test_units_must_match_task(self):
        self.allocation(0, "units", "4")
        self.result(False, "UNITS")

    def test_tier_join(self):
        self.allocation(4, "pool_id", "P-A")
        self.result(False, "TIER")

    def test_special_requires_certification(self):
        self.allocation(6, "pool_id", "P-A")
        self.dispatch(0, "mode", "guarded")
        self.dispatch(0, "stamp", "4")
        self.result(False, "CERTIFICATION")

    def test_special_requires_guarded_dispatch(self):
        self.dispatch(1, "mode", "open")
        self.result(False, "SPECIAL_MODE")

    def test_dispatch_mode_enum(self):
        self.dispatch(0, "mode", "OPEN")
        self.result(False, "MODE")

    def test_stamp_nonnegative(self):
        self.dispatch(0, "stamp", "-1")
        self.result(False, "STAMP_MIN")

    def test_cutoff_is_inclusive_but_one_above_fails(self):
        self.dispatch(2, "stamp", "13")
        self.result(False, "CUTOFF")

    def test_guard_start_is_inclusive_but_one_below_fails(self):
        self.dispatch(1, "stamp", "5")
        self.result(False, "GUARD_START")

    def test_deadline_equality_fails(self):
        self.dispatch(0, "stamp", "10")
        self.result(False, "DEADLINE")

    def test_pool_capacity_counts_tasks(self):
        self.allocation(7, "pool_id", "P-B")
        self.result(False, "CAPACITY")

    def test_budget_above_limit_fails(self):
        self.alternative()
        self.allocation(0, "pool_id", "P-D")
        self.result(False, "BUDGET")

    def test_i64_encoding_and_range(self):
        for value in [3, True, 3.0, "03", "+3", "-0", " 3", "3.0",
                      "9223372036854775808", "-9223372036854775809"]:
            with self.subTest(value=value):
                self.allocation(0, "units", value)
                self.result(False, "SCHEMA")

    def test_missing_field(self):
        self.edit("allocations.json", lambda d: d["allocations"][0].pop("units"))
        self.result(False, "SCHEMA")

    def test_checked_integer_arithmetic(self):
        self.allocation(0, "units", "9223372036854775807")
        self.result(False, "ARITHMETIC")

    def test_wrong_root_collection_record_and_field_types(self):
        path = self.recovered / "allocations.json"
        for value in [[], {}, {"allocations": {}}, {"allocations": [0]},
                      {"allocations": [{"task_id": 1, "pool_id": "P-A", "units": "3"}]}]:
            with self.subTest(value=value):
                path.write_text(json.dumps(value))
                self.result(False, "SCHEMA")

    def test_malformed_json(self):
        (self.recovered / "allocations.json").write_text("{")
        self.result(False, "JSON")

    def test_non_utf8(self):
        (self.recovered / "allocations.json").write_bytes(b"\xff")
        self.result(False, "JSON")

    def test_nonfinite_json(self):
        self.edit("allocations.json", lambda d: d.__setitem__("extra", float("nan")))
        self.result(False, "JSON")

    def test_duplicate_json_members_even_when_unprojected(self):
        path = self.recovered / "allocations.json"
        raw = path.read_text()
        path.write_text('{"ignored":1,"ignored":2,' + raw[1:])
        self.result(False, "JSON")

    def test_unpaired_unicode_surrogate(self):
        self.edit("allocations.json", lambda d: d.__setitem__("extra", "\ud800"))
        self.result(False, "JSON")

    def test_float_overflow_in_extra_member(self):
        path = self.recovered / "allocations.json"
        raw = path.read_text()
        path.write_text('{"extra":1e999,' + raw[1:])
        self.result(False, "JSON")

    def test_integer_number_overflow_in_extra_member(self):
        path = self.recovered / "allocations.json"
        raw = path.read_text()
        path.write_text('{"extra":' + "9" * 400 + "," + raw[1:])
        self.result(False, "JSON")

    def test_extra_array_limit(self):
        self.edit("allocations.json", lambda d: d.__setitem__("extra", [0] * 256))
        self.result(True)
        self.edit("allocations.json", lambda d: d["extra"].append(0))
        self.result(False, "JSON_LIMIT")

    def test_json_depth_limit(self):
        value = 0
        for _ in range(30):
            value = {"child": value}
        self.edit("allocations.json", lambda d: d.__setitem__("extra", value))
        self.result(True)  # Root at depth 1. Deepest scalar at depth 32.
        self.edit("allocations.json", lambda d: d.__setitem__("extra", {"child": value}))
        self.result(False, "JSON_LIMIT")

    def test_missing_filename(self):
        (self.recovered / "dispatch.json").unlink()
        self.result(False, "FILE_SET")

    def test_wrong_filename(self):
        (self.recovered / "dispatch.json").rename(self.recovered / "Dispatch.json")
        self.result(False, "FILE_SET")

    def test_additional_filename(self):
        (self.recovered / "extra.json").write_text("{}")
        self.result(False, "FILE_SET")

    def test_nested_directory(self):
        (self.recovered / "nested").mkdir()
        self.result(False, "FILE_SET")

    def test_symlink(self):
        path = self.recovered / "dispatch.json"
        path.unlink()
        path.symlink_to(ROOT / "candidates" / "valid" / "dispatch.json")
        self.result(False, "FILE_TYPE")

    def test_missing_directory(self):
        self.recovered = self.recovered / "absent"
        self.result(False, "FILE_SET")

    def test_record_limit(self):
        self.edit("allocations.json", lambda d: d.__setitem__(
            "allocations", [{"task_id": "", "pool_id": "", "units": "0"}] * 257))
        # Keep the file below the bundle limit to isolate the record cap.
        self.result(False, "JSON_LIMIT")

    def test_encoded_bundle_limit_is_inclusive(self):
        paths = list(self.recovered.iterdir())
        encoded_size = 3 + sum(6 + len(p.name.encode("ascii")) + p.stat().st_size for p in paths)
        path = self.recovered / "allocations.json"
        with path.open("ab") as handle:
            handle.write(b" " * (16384 - encoded_size))
        self.assertEqual(self.result(True)["encoded_bytes"], 16384)
        with path.open("ab") as handle:
            handle.write(b" ")
        self.result(False, "BUNDLE_LIMIT")

    def test_cli_rejects_reference_override_without_disclosing_path(self):
        self.assertTrue(ORACLE.is_file(), "oracle CLI is not implemented")
        run = subprocess.run(
            [sys.executable, "-B", str(ORACLE), str(self.recovered), "/synthetic-private-marker"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(run.returncode, 2)
        self.assertEqual(run.stderr, "")
        self.assertEqual(json.loads(run.stdout), {"accepted": False, "errors": ["USAGE"]})


if __name__ == "__main__":
    unittest.main()
