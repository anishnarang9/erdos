#!/usr/bin/env python3
"""Independent feasibility oracle for Meridian Kiln. No engine or candidate imports."""

import json
import math
import os
from pathlib import Path
import stat
import sys


REFERENCE = Path(__file__).resolve().parent / "reference" / "dataset.json"
FILES = ("schedule.json",)
LIMIT = 16384
I64_MIN = -(2**63)
I64_MAX = 2**63 - 1

CHARGES = {
    "release_id": "string",
    "lot_id": "string",
    "kiln_id": "string",
    "panels": "i64",
    "clay_kg": "i64",
}
FINISHES = {
    "release_id": "string",
    "bench_id": "string",
    "temper_id": "string",
    "panels": "i64",
}


class Invalid(ValueError):
    """Contains only a fixed, public error code."""


def checked_add(left, right):
    result = left + right
    if result < I64_MIN or result > I64_MAX:
        raise Invalid("ARITHMETIC")
    return result


def checked_mul(left, right):
    result = left * right
    if result < I64_MIN or result > I64_MAX:
        raise Invalid("ARITHMETIC")
    return result


def integer(value):
    if not isinstance(value, str) or len(value) > 20:
        raise Invalid("SCHEMA")
    try:
        number = int(value, 10)
    except ValueError:
        raise Invalid("SCHEMA") from None
    if value != str(number) or not I64_MIN <= number <= I64_MAX:
        raise Invalid("SCHEMA")
    return number


def nonfinite(_value):
    raise ValueError("nonfinite JSON")


def unique_members(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def check_json(value, depth=1):
    if depth > 32:
        raise Invalid("JSON_LIMIT")
    if isinstance(value, str):
        value.encode("utf-8")
    elif type(value) in (int, float):
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("nonfinite JSON")
    elif isinstance(value, dict):
        for key, item in value.items():
            key.encode("utf-8")
            check_json(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 256:
            raise Invalid("JSON_LIMIT")
        for item in value:
            check_json(item, depth + 1)


def parse(raw):
    try:
        value = json.loads(
            raw.decode("utf-8"), parse_constant=nonfinite, object_pairs_hook=unique_members,
        )
        check_json(value)
        return value
    except Invalid:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise Invalid("JSON") from None


def records(document, collection, fields):
    if not isinstance(document, dict) or not isinstance(document.get(collection), list):
        raise Invalid("SCHEMA")
    rows = document[collection]
    if len(rows) > 256:
        raise Invalid("RECORD_LIMIT")
    projected = []
    for row in rows:
        if not isinstance(row, dict):
            raise Invalid("SCHEMA")
        result = {}
        for field, kind in fields.items():
            value = row.get(field)
            if kind == "i64":
                result[field] = integer(value)
            elif not isinstance(value, str):
                raise Invalid("SCHEMA")
            else:
                result[field] = value
        projected.append(result)
    return projected


def index(rows, field):
    mapped = {}
    for row in rows:
        key = row[field]
        if key in mapped:
            raise Invalid("REFERENCE")
        mapped[key] = row
    return mapped


def load_reference():
    """Load only the fixed sibling reference. Caller cannot override it."""
    try:
        document = parse(REFERENCE.read_bytes())
        if not isinstance(document, dict):
            raise Invalid("REFERENCE")
        suppliers = index(records(document, "suppliers", {
            "supplier_id": "string", "certified": "i64", "import": "i64",
        }), "supplier_id")
        profiles = index(records(document, "profiles", {
            "profile_id": "string", "thickness_mm": "i64", "clay_family": "string",
            "kg_per_panel": "i64", "edge_code": "string",
        }), "profile_id")
        releases = index(records(document, "releases", {
            "release_id": "string", "profile_id": "string", "panels": "i64",
            "temper_required": "i64",
        }), "release_id")
        lots = index(records(document, "lots", {
            "lot_id": "string", "clay_family": "string", "kg_available": "i64",
            "cents_per_kg": "i64", "recycled": "i64", "supplier_id": "string",
        }), "lot_id")
        kilns = index(records(document, "kilns", {
            "kiln_id": "string", "thickness_min_mm": "i64", "thickness_max_mm": "i64",
            "capacity_kg": "i64", "family_lock": "string",
        }), "kiln_id")
        benches = index(records(document, "benches", {
            "bench_id": "string", "edge_code": "string",
        }), "bench_id")
        tempers = index(records(document, "tempers", {
            "temper_id": "string", "thickness_min_mm": "i64", "thickness_max_mm": "i64",
            "capacity_panels": "i64", "temper_class": "string",
        }), "temper_id")
        limits = {
            "max_spend_cents": integer(document.get("max_spend_cents")),
            "max_import_charges": integer(document.get("max_import_charges")),
            "min_recycled_charges": integer(document.get("min_recycled_charges")),
        }
        families = {row["clay_family"] for row in profiles.values()}
        if not releases or not all(row["profile_id"] in profiles for row in releases.values()):
            raise Invalid("REFERENCE")
        if not lots or not all(row["supplier_id"] in suppliers for row in lots.values()):
            raise Invalid("REFERENCE")
        for row in list(suppliers.values()) + list(lots.values()) + list(releases.values()):
            for field in ("certified", "import", "recycled", "temper_required"):
                if field in row and row[field] not in (0, 1):
                    raise Invalid("REFERENCE")
        for row in list(kilns.values()) + list(tempers.values()):
            if row["thickness_min_mm"] > row["thickness_max_mm"]:
                raise Invalid("REFERENCE")
        for row in profiles.values():
            if row["kg_per_panel"] <= 0:
                raise Invalid("REFERENCE")
        for row in releases.values():
            if row["panels"] <= 0:
                raise Invalid("REFERENCE")
        for row in lots.values():
            if row["kg_available"] <= 0 or row["cents_per_kg"] <= 0:
                raise Invalid("REFERENCE")
        for row in kilns.values():
            if row["capacity_kg"] <= 0:
                raise Invalid("REFERENCE")
            if row["family_lock"] not in families and row["family_lock"] != "":
                raise Invalid("REFERENCE")
        for row in tempers.values():
            if row["capacity_panels"] <= 0 or row["temper_class"] not in ("fire", "bypass"):
                raise Invalid("REFERENCE")
        return {
            "suppliers": suppliers,
            "profiles": profiles,
            "releases": releases,
            "lots": lots,
            "kilns": kilns,
            "benches": benches,
            "tempers": tempers,
            **limits,
        }
    except (OSError, Invalid):
        raise Invalid("REFERENCE") from None


def load_delivery(directory):
    try:
        if directory.is_symlink():
            raise Invalid("FILE_TYPE")
        if {entry.name for entry in directory.iterdir()} != set(FILES):
            raise Invalid("FILE_SET")
        payloads = {}
        encoded_size = 3
        for name in FILES:
            path = directory / name
            if not stat.S_ISREG(path.lstat().st_mode):
                raise Invalid("FILE_TYPE")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise Invalid("FILE_TYPE")
                raw = handle.read(LIMIT + 1)
            encoded_size += 2 + len(name.encode("ascii")) + 4 + len(raw)
            if encoded_size > LIMIT:
                raise Invalid("BUNDLE_LIMIT")
            payloads[name] = raw
        return payloads, encoded_size
    except OSError:
        raise Invalid("FILE_SET") from None


def require(table, key):
    try:
        return table[key]
    except KeyError:
        raise Invalid("LOOKUP") from None


def charge_index(charges):
    """Lookup of charges by release id aborts on any duplicate key."""
    indexed = {}
    for row in charges:
        key = row["release_id"]
        if key in indexed:
            raise Invalid("LOOKUP")
        indexed[key] = row
    return indexed


def evaluate_schedule(charges, finishes, reference):
    releases = reference["releases"]
    # A finish joins its charge by lookup. That lookup runs only across finishes.
    joined = charge_index(charges) if finishes else {}
    resolved_charges = []
    for row in charges:
        release = require(releases, row["release_id"])
        profile = require(reference["profiles"], release["profile_id"])
        lot = require(reference["lots"], row["lot_id"])
        supplier = require(reference["suppliers"], lot["supplier_id"])
        kiln = require(reference["kilns"], row["kiln_id"])
        resolved_charges.append((row, release, profile, lot, supplier, kiln))
    resolved_finishes = []
    for row in finishes:
        release = require(releases, row["release_id"])
        profile = require(reference["profiles"], release["profile_id"])
        charge = joined.get(row["release_id"])
        if charge is None:
            raise Invalid("LOOKUP")
        bench = require(reference["benches"], row["bench_id"])
        temper = require(reference["tempers"], row["temper_id"])
        resolved_finishes.append((row, release, profile, charge, bench, temper))

    terms = []
    for row, _release, profile, lot, _supplier, _kiln in resolved_charges:
        checked_mul(row["panels"], profile["kg_per_panel"])
        terms.append(checked_mul(row["clay_kg"], lot["cents_per_kg"]))
    spend = 0
    for term in terms:
        spend = checked_add(spend, term)

    errors = set()
    charge_ids = [row["release_id"] for row, *_rest in resolved_charges]
    finish_ids = [row["release_id"] for row, *_rest in resolved_finishes]
    if len(charge_ids) != len(releases) or len(set(charge_ids)) != len(charge_ids):
        errors.add("CHARGE_CARDINALITY")
    if any(row["panels"] != release["panels"] for row, release, *_rest in resolved_charges):
        errors.add("CHARGE_QUANTITY")
    if len(finish_ids) != len(releases) or len(set(finish_ids)) != len(finish_ids):
        errors.add("FINISH_CARDINALITY")
    covered = set(releases)
    if not covered <= set(charge_ids) or not covered <= set(finish_ids):
        errors.add("COVERAGE")
    if any(row["panels"] != charge["panels"] for row, _release, _profile, charge, *_rest in resolved_finishes):
        errors.add("CHARGE_FINISH")
    if any(
        row["clay_kg"] != row["panels"] * profile["kg_per_panel"]
        for row, _release, profile, *_rest in resolved_charges
    ):
        errors.add("CLAY_MASS")
    lot_ids = [lot["lot_id"] for _row, _release, _profile, lot, *_rest in resolved_charges]
    if (
        len(set(lot_ids)) != len(lot_ids)
        or any(lot["clay_family"] != profile["clay_family"] for _row, _release, profile, lot, *_rest in resolved_charges)
        or any(row["clay_kg"] > lot["kg_available"] for row, _release, _profile, lot, *_rest in resolved_charges)
        or any(supplier["certified"] != 1 for *_head, supplier, _kiln in resolved_charges)
    ):
        errors.add("LOT")
    kiln_ids = [kiln["kiln_id"] for *_head, kiln in resolved_charges]
    if len(set(kiln_ids)) != len(kiln_ids) or any(
        profile["thickness_mm"] < kiln["thickness_min_mm"]
        or profile["thickness_mm"] > kiln["thickness_max_mm"]
        or row["clay_kg"] > kiln["capacity_kg"]
        or (kiln["family_lock"] != "" and kiln["family_lock"] != profile["clay_family"])
        for row, _release, profile, _lot, _supplier, kiln in resolved_charges
    ):
        errors.add("KILN")
    bench_ids = [bench["bench_id"] for *_head, bench, _temper in resolved_finishes]
    if len(set(bench_ids)) != len(bench_ids) or any(
        bench["edge_code"] != profile["edge_code"]
        for _row, _release, profile, _charge, bench, _temper in resolved_finishes
    ):
        errors.add("BENCH")
    temper_ids = [temper["temper_id"] for *_head, temper in resolved_finishes]
    if len(set(temper_ids)) != len(temper_ids) or any(
        profile["thickness_mm"] < temper["thickness_min_mm"]
        or profile["thickness_mm"] > temper["thickness_max_mm"]
        or row["panels"] > temper["capacity_panels"]
        or temper["temper_class"] != ("fire" if release["temper_required"] == 1 else "bypass" if release["temper_required"] == 0 else None)
        for row, release, profile, _charge, _bench, temper in resolved_finishes
    ):
        errors.add("TEMPER")
    imports = sum(supplier["import"] == 1 for *_head, supplier, _kiln in resolved_charges)
    recycled = sum(lot["recycled"] == 1 for _row, _release, _profile, lot, *_rest in resolved_charges)
    if imports > reference["max_import_charges"]:
        errors.add("IMPORT_CEILING")
    if recycled < reference["min_recycled_charges"]:
        errors.add("RECYCLED_FLOOR")
    if spend > reference["max_spend_cents"]:
        errors.add("SPEND_CEILING")
    return errors


def evaluate(directory):
    try:
        payloads, encoded_size = load_delivery(Path(directory))
        document = parse(payloads["schedule.json"])
        charges = records(document, "charges", CHARGES)
        finishes = records(document, "finishes", FINISHES)
        reference = load_reference()
        errors = evaluate_schedule(charges, finishes, reference)
        return {"accepted": not errors, "errors": sorted(errors), "encoded_bytes": encoded_size}
    except Invalid as error:
        return {"accepted": False, "errors": [str(error)]}
    except (OSError, RecursionError, ValueError):
        return {"accepted": False, "errors": ["INPUT"]}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"accepted": False, "errors": ["USAGE"]}, sort_keys=True))
        return 2
    report = evaluate(sys.argv[1])
    print(json.dumps(report, sort_keys=True))
    return 0 if report["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
