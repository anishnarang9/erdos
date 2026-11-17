#!/usr/bin/env python3
"""Independent feasibility oracle. No engine, candidate, or expected-result imports."""

import json
import math
import os
from pathlib import Path
import re
import stat
import sys


REFERENCE = Path(__file__).resolve().parent / "reference" / "catalog.json"
FILES = ("allocations.json", "dispatch.json")
LIMIT = 16384
I64_MIN = -(2**63)
I64_MAX = 2**63 - 1
DECIMAL = re.compile(r"(?:0|-?[1-9][0-9]*)", re.ASCII)


class Invalid(ValueError):
    """Contains only a fixed, public error code."""


def checked(value):
    if not I64_MIN <= value <= I64_MAX:
        raise Invalid("ARITHMETIC")
    return value


def integer(value):
    if not isinstance(value, str) or not DECIMAL.fullmatch(value):
        raise Invalid("SCHEMA")
    # Avoid converting arbitrarily long strings, even within the file limit.
    if len(value) > 20:
        raise Invalid("SCHEMA")
    result = int(value)
    if not I64_MIN <= result <= I64_MAX:
        raise Invalid("SCHEMA")
    return result


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
        value.encode("utf-8")  # Reject unpaired surrogates, including escaped ones.
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
            elif kind == "bool":
                if type(value) is not bool:
                    raise Invalid("SCHEMA")
                result[field] = value
            else:
                if not isinstance(value, str):
                    raise Invalid("SCHEMA")
                result[field] = value
        projected.append(result)
    return projected


def load_reference():
    """Load only the fixed sibling reference. Caller cannot override it."""
    try:
        document = parse(REFERENCE.read_bytes())
        tasks = records(document, "tasks", {
            "id": "string", "units": "i64", "min_tier": "i64",
            "special": "bool", "deadline": "i64",
        })
        pools = records(document, "pools", {
            "id": "string", "tier": "i64", "unit_cost": "i64",
            "capacity": "i64", "certified": "bool",
            "cutoff": "i64", "guard_start": "i64",
        })
        budget = integer(document.get("budget"))
        task_map = {row["id"]: row for row in tasks}
        pool_map = {row["id"]: row for row in pools}
        if not tasks or not pools or len(task_map) != len(tasks) or len(pool_map) != len(pools):
            raise Invalid("REFERENCE")
        return task_map, pool_map, budget
    except (OSError, Invalid):
        raise Invalid("REFERENCE") from None


def load_delivery(directory):
    try:
        if directory.is_symlink():
            raise Invalid("FILE_TYPE")
        if {entry.name for entry in directory.iterdir()} != set(FILES):
            raise Invalid("FILE_SET")
        payloads = {}
        encoded_size = 3  # Version byte and u16 file count.
        for name in FILES:
            path = directory / name
            if not stat.S_ISREG(path.lstat().st_mode):
                raise Invalid("FILE_TYPE")
            # Do not follow a symlink if an entry changes after lstat.
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


def evaluate(directory):
    """Accept any feasible delivery. Return only public codes and byte counts."""
    try:
        payloads, encoded_size = load_delivery(Path(directory))
        allocations = records(parse(payloads["allocations.json"]), "allocations", {
            "task_id": "string", "pool_id": "string", "units": "i64",
        })
        dispatches = records(parse(payloads["dispatch.json"]), "dispatches", {
            "pool_id": "string", "mode": "string", "stamp": "i64",
        })
        tasks, pools, budget = load_reference()
        errors = set()
        task_ids = [row["task_id"] for row in allocations]
        dispatch_ids = [row["pool_id"] for row in dispatches]
        if len(task_ids) != len(tasks) or set(task_ids) != set(tasks):
            errors.add("TASK_SET")
        if len(dispatch_ids) != len(pools) or set(dispatch_ids) != set(pools):
            errors.add("DISPATCH_SET")
        if any(row["pool_id"] not in pools for row in allocations):
            errors.add("POOL_ID")
        # Validate coverage and uniqueness before constructing joins.
        if errors:
            return {"accepted": False, "errors": sorted(errors), "encoded_bytes": encoded_size}
        dispatch_by_pool = {row["pool_id"]: row for row in dispatches}
        counts = {pool_id: 0 for pool_id in pools}
        total_cost = 0
        for row in dispatches:
            pool = pools[row["pool_id"]]
            if row["mode"] not in ("open", "guarded"):
                errors.add("MODE")
            if row["stamp"] < 0:
                errors.add("STAMP_MIN")
            if row["stamp"] > pool["cutoff"]:
                errors.add("CUTOFF")
            if row["mode"] == "guarded" and row["stamp"] < pool["guard_start"]:
                errors.add("GUARD_START")
        for row in allocations:
            task = tasks[row["task_id"]]
            pool = pools[row["pool_id"]]
            dispatch = dispatch_by_pool[row["pool_id"]]
            if row["units"] != task["units"]:
                errors.add("UNITS")
            if pool["tier"] < task["min_tier"]:
                errors.add("TIER")
            if task["special"]:
                if not pool["certified"]:
                    errors.add("CERTIFICATION")
                if dispatch["mode"] != "guarded":
                    errors.add("SPECIAL_MODE")
            if dispatch["stamp"] >= task["deadline"]:
                errors.add("DEADLINE")
            counts[row["pool_id"]] += 1
            cost = checked(row["units"] * pool["unit_cost"])
            total_cost = checked(total_cost + cost)
        if any(counts[pool_id] > pool["capacity"] for pool_id, pool in pools.items()):
            errors.add("CAPACITY")
        if total_cost > budget:
            errors.add("BUDGET")
        return {"accepted": not errors, "errors": sorted(errors), "encoded_bytes": encoded_size}
    except Invalid as error:
        return {"accepted": False, "errors": [str(error)]}
    except (OSError, RecursionError, ValueError):
        # Do not expose paths, input contents, or interpreter tracebacks.
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
