#!/usr/bin/env python3
"""Deterministic bounded search for the Meridian Kiln week schedule.

Reads only reference/dataset.json. Writes two schedules and provenance.json.
Does not read a plan, an oracle, or tests, and does not claim agreement with them.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = ROOT / "reference" / "dataset.json"
REQUEST_PATH = ROOT / "request.md"
OUTPUTS_PATH = ROOT / "outputs.json"
VALID_PATH = ROOT / "candidates" / "valid" / "schedule.json"
ALTERNATIVE_PATH = ROOT / "candidates" / "alternative" / "schedule.json"
PROVENANCE_PATH = ROOT / "solver" / "provenance.json"

SEARCH_BOUND = 2_000_000
I64_MIN = -(2**63)
I64_MAX = 2**63 - 1
CANONICAL_I64 = re.compile(r"^(0|-?[1-9][0-9]*)$")

SOLVER_COMMAND = "python3 -B docs/fresh-exchange-input/solver/solve.py"
REASONING = (
    "Each release fixes its panel count and clay kilograms from the joined profile. "
    "A charge is feasible only when the lot family matches, the drawn kilograms fit "
    "the lot, the supplier is certified, the kiln thickness window and capacity hold, "
    "and the kiln family lock is empty or equal to that family. A finish is feasible "
    "only when the bench edge code matches and the temper window, panel capacity, and "
    "fire-or-bypass class match the release. Lots, kilns, benches, and tempers are "
    "exclusive. Releases are assigned in sorted release id order and each resource list "
    "is tried in lexicographic id order. A complete assignment is kept only when the "
    "import-charge count, recycled-charge count, and exact cent spend meet the three "
    "global bounds. The valid file is the lexicographically first accepted assignment. "
    "The alternative is the next accepted assignment whose lot, kiln, or temper choice "
    "differs. No objective is optimized."
)


def parse_i64(text: object, field: str) -> int:
    if not isinstance(text, str) or CANONICAL_I64.fullmatch(text) is None:
        raise ValueError(f"non-canonical i64 for {field}: {text!r}")
    value = int(text)
    if value < I64_MIN or value > I64_MAX:
        raise ValueError(f"i64 out of range for {field}")
    return value


def emit_i64(value: int) -> str:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("integer field is not an exact int")
    if value < I64_MIN or value > I64_MAX:
        raise ValueError("i64 out of range")
    rendered = str(value)
    if CANONICAL_I64.fullmatch(rendered) is None:
        raise ValueError(f"emitted non-canonical i64 {rendered}")
    return rendered


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{digest}"


def index_rows(rows: list[dict], key: str) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for row in rows:
        row_id = row[key]
        if not isinstance(row_id, str) or row_id == "" or row_id in found:
            raise ValueError(f"duplicate or empty {key}")
        found[row_id] = row
    return found


def load_dataset(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    suppliers = index_rows(raw["suppliers"], "supplier_id")
    profiles = index_rows(raw["profiles"], "profile_id")
    releases = index_rows(raw["releases"], "release_id")
    lots = index_rows(raw["lots"], "lot_id")
    kilns = index_rows(raw["kilns"], "kiln_id")
    benches = index_rows(raw["benches"], "bench_id")
    tempers = index_rows(raw["tempers"], "temper_id")

    for supplier in suppliers.values():
        supplier["certified"] = parse_i64(supplier["certified"], "certified")
        supplier["import"] = parse_i64(supplier["import"], "import")
    for profile in profiles.values():
        profile["thickness_mm"] = parse_i64(profile["thickness_mm"], "thickness_mm")
        profile["kg_per_panel"] = parse_i64(profile["kg_per_panel"], "kg_per_panel")
    for release in releases.values():
        release["panels"] = parse_i64(release["panels"], "panels")
        release["temper_required"] = parse_i64(release["temper_required"], "temper_required")
        if release["profile_id"] not in profiles:
            raise ValueError(f"release profile missing: {release['profile_id']}")
    for lot in lots.values():
        lot["kg_available"] = parse_i64(lot["kg_available"], "kg_available")
        lot["cents_per_kg"] = parse_i64(lot["cents_per_kg"], "cents_per_kg")
        lot["recycled"] = parse_i64(lot["recycled"], "recycled")
        if lot["supplier_id"] not in suppliers:
            raise ValueError(f"lot supplier missing: {lot['supplier_id']}")
    for kiln in kilns.values():
        kiln["thickness_min_mm"] = parse_i64(kiln["thickness_min_mm"], "thickness_min_mm")
        kiln["thickness_max_mm"] = parse_i64(kiln["thickness_max_mm"], "thickness_max_mm")
        kiln["capacity_kg"] = parse_i64(kiln["capacity_kg"], "capacity_kg")
    for temper in tempers.values():
        temper["thickness_min_mm"] = parse_i64(temper["thickness_min_mm"], "thickness_min_mm")
        temper["thickness_max_mm"] = parse_i64(temper["thickness_max_mm"], "thickness_max_mm")
        temper["capacity_panels"] = parse_i64(temper["capacity_panels"], "capacity_panels")

    return {
        "max_spend_cents": parse_i64(raw["max_spend_cents"], "max_spend_cents"),
        "max_import_charges": parse_i64(raw["max_import_charges"], "max_import_charges"),
        "min_recycled_charges": parse_i64(raw["min_recycled_charges"], "min_recycled_charges"),
        "suppliers": suppliers,
        "profiles": profiles,
        "releases": releases,
        "lots": lots,
        "kilns": kilns,
        "benches": benches,
        "tempers": tempers,
    }


def release_view(dataset: dict, release_id: str) -> dict:
    release = dataset["releases"][release_id]
    profile = dataset["profiles"][release["profile_id"]]
    panels = release["panels"]
    kg_per_panel = profile["kg_per_panel"]
    return {
        "release_id": release_id,
        "panels": panels,
        "clay_kg": panels * kg_per_panel,
        "thickness_mm": profile["thickness_mm"],
        "clay_family": profile["clay_family"],
        "edge_code": profile["edge_code"],
        "temper_required": release["temper_required"],
        "kg_per_panel": kg_per_panel,
    }


def charge_compatible(view: dict, lot: dict, supplier: dict, kiln: dict) -> bool:
    if lot["clay_family"] != view["clay_family"]:
        return False
    if view["clay_kg"] > lot["kg_available"]:
        return False
    if supplier["certified"] != 1:
        return False
    thickness = view["thickness_mm"]
    if thickness < kiln["thickness_min_mm"] or thickness > kiln["thickness_max_mm"]:
        return False
    if view["clay_kg"] > kiln["capacity_kg"]:
        return False
    if kiln["family_lock"] != "" and kiln["family_lock"] != view["clay_family"]:
        return False
    return True


def finish_compatible(view: dict, bench: dict, temper: dict) -> bool:
    if bench["edge_code"] != view["edge_code"]:
        return False
    thickness = view["thickness_mm"]
    if thickness < temper["thickness_min_mm"] or thickness > temper["thickness_max_mm"]:
        return False
    if view["panels"] > temper["capacity_panels"]:
        return False
    required = view["temper_required"]
    if required == 1 and temper["temper_class"] != "fire":
        return False
    if required == 0 and temper["temper_class"] != "bypass":
        return False
    if required not in (0, 1):
        return False
    return True


def schedule_from_choices(dataset: dict, choices: list[dict]) -> dict:
    charges = []
    finishes = []
    for choice in sorted(choices, key=lambda item: item["release_id"]):
        view = release_view(dataset, choice["release_id"])
        charges.append(
            {
                "release_id": choice["release_id"],
                "lot_id": choice["lot_id"],
                "kiln_id": choice["kiln_id"],
                "panels": emit_i64(view["panels"]),
                "clay_kg": emit_i64(view["clay_kg"]),
            }
        )
        finishes.append(
            {
                "release_id": choice["release_id"],
                "bench_id": choice["bench_id"],
                "temper_id": choice["temper_id"],
                "panels": emit_i64(view["panels"]),
            }
        )
    return {"charges": charges, "finishes": finishes}


def audit(dataset: dict, schedule: dict) -> list[str]:
    """Independent transcription of the 13 acceptance requirements."""
    failures: list[str] = []
    releases = dataset["releases"]
    profiles = dataset["profiles"]
    lots = dataset["lots"]
    suppliers = dataset["suppliers"]
    kilns = dataset["kilns"]
    benches = dataset["benches"]
    tempers = dataset["tempers"]
    charges = schedule.get("charges")
    finishes = schedule.get("finishes")
    if not isinstance(charges, list) or not isinstance(finishes, list):
        return ["shape"]

    def unique_ids(rows: list, field: str) -> bool:
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get(field), str):
                return False
            if row[field] in seen:
                return False
            seen.add(row[field])
        return True

    if not unique_ids(charges, "release_id") or len(charges) != len(releases):
        failures.append("1")
    if not unique_ids(finishes, "release_id") or len(finishes) != len(releases):
        failures.append("3")

    charge_by_release: dict[str, dict] = {}
    finish_by_release: dict[str, dict] = {}
    if unique_ids(charges, "release_id"):
        charge_by_release = {row["release_id"]: row for row in charges}
    if unique_ids(finishes, "release_id"):
        finish_by_release = {row["release_id"]: row for row in finishes}

    for charge in charges:
        release_id = charge.get("release_id")
        release = releases.get(release_id) if isinstance(release_id, str) else None
        if release is None:
            failures.append("2")
            continue
        try:
            panels = parse_i64(charge.get("panels"), "panels")
        except ValueError:
            failures.append("2")
            continue
        if panels != release["panels"]:
            failures.append("2")

    for release_id in releases:
        if release_id not in charge_by_release or release_id not in finish_by_release:
            failures.append("4")

    for finish in finishes:
        release_id = finish.get("release_id")
        charge = charge_by_release.get(release_id) if isinstance(release_id, str) else None
        if charge is None:
            failures.append("5")
            continue
        try:
            finish_panels = parse_i64(finish.get("panels"), "panels")
            charge_panels = parse_i64(charge.get("panels"), "panels")
        except ValueError:
            failures.append("5")
            continue
        if finish_panels != charge_panels:
            failures.append("5")

    prepared: list[tuple[dict, dict, dict, dict, dict]] = []
    for charge in charges:
        release = releases.get(charge.get("release_id"))
        if release is None:
            failures.append("6")
            continue
        profile = profiles[release["profile_id"]]
        try:
            panels = parse_i64(charge.get("panels"), "panels")
            clay_kg = parse_i64(charge.get("clay_kg"), "clay_kg")
        except ValueError:
            failures.append("6")
            continue
        if clay_kg != panels * profile["kg_per_panel"]:
            failures.append("6")
        lot = lots.get(charge.get("lot_id"))
        kiln = kilns.get(charge.get("kiln_id"))
        if lot is None or kiln is None:
            failures.append("7")
            continue
        supplier = suppliers[lot["supplier_id"]]
        prepared.append((charge, release, profile, lot, kiln))
        if lot["clay_family"] != profile["clay_family"]:
            failures.append("7")
        if clay_kg > lot["kg_available"]:
            failures.append("7")
        if supplier["certified"] != 1:
            failures.append("7")
        thickness = profile["thickness_mm"]
        if thickness < kiln["thickness_min_mm"] or thickness > kiln["thickness_max_mm"]:
            failures.append("8")
        if clay_kg > kiln["capacity_kg"]:
            failures.append("8")
        if kiln["family_lock"] != "" and kiln["family_lock"] != profile["clay_family"]:
            failures.append("8")

    if not unique_ids(charges, "lot_id"):
        failures.append("7")
    if not unique_ids(charges, "kiln_id"):
        failures.append("8")
    if not unique_ids(finishes, "bench_id"):
        failures.append("9")
    if not unique_ids(finishes, "temper_id"):
        failures.append("10")

    for finish in finishes:
        release = releases.get(finish.get("release_id"))
        bench = benches.get(finish.get("bench_id"))
        temper = tempers.get(finish.get("temper_id"))
        if release is None or bench is None or temper is None:
            failures.append("9")
            continue
        profile = profiles[release["profile_id"]]
        if bench["edge_code"] != profile["edge_code"]:
            failures.append("9")
        thickness = profile["thickness_mm"]
        if thickness < temper["thickness_min_mm"] or thickness > temper["thickness_max_mm"]:
            failures.append("10")
        try:
            panels = parse_i64(finish.get("panels"), "panels")
        except ValueError:
            failures.append("10")
            continue
        if panels > temper["capacity_panels"]:
            failures.append("10")
        required = release["temper_required"]
        expected = "fire" if required == 1 else "bypass" if required == 0 else None
        if temper["temper_class"] != expected:
            failures.append("10")

    import_charges = 0
    recycled_charges = 0
    spend = 0
    for charge, _release, _profile, lot, _kiln in prepared:
        try:
            clay_kg = parse_i64(charge.get("clay_kg"), "clay_kg")
        except ValueError:
            failures.append("13")
            continue
        supplier = suppliers[lot["supplier_id"]]
        if supplier["import"] == 1:
            import_charges += 1
        if lot["recycled"] == 1:
            recycled_charges += 1
        spend += clay_kg * lot["cents_per_kg"]
    if len(prepared) == len(charges):
        if import_charges > dataset["max_import_charges"]:
            failures.append("11")
        if recycled_charges < dataset["min_recycled_charges"]:
            failures.append("12")
        if spend > dataset["max_spend_cents"]:
            failures.append("13")
    return sorted(set(failures), key=lambda item: int(item) if item.isdigit() else 99)


def assignment_key(dataset: dict, choices: list[dict]) -> tuple:
    return tuple(
        (
            choice["release_id"],
            choice["lot_id"],
            choice["kiln_id"],
            choice["bench_id"],
            choice["temper_id"],
        )
        for choice in sorted(choices, key=lambda item: item["release_id"])
    )


def structural_key(choices: list[dict]) -> tuple:
    return tuple(
        (choice["release_id"], choice["lot_id"], choice["kiln_id"], choice["temper_id"])
        for choice in sorted(choices, key=lambda item: item["release_id"])
    )


def search(dataset: dict) -> tuple[list[list[dict]], int]:
    release_ids = sorted(dataset["releases"])
    options: dict[str, dict[str, list[str]]] = {}
    for release_id in release_ids:
        view = release_view(dataset, release_id)
        lots = []
        for lot_id in sorted(dataset["lots"]):
            lot = dataset["lots"][lot_id]
            supplier = dataset["suppliers"][lot["supplier_id"]]
            if lot["clay_family"] == view["clay_family"] and view["clay_kg"] <= lot["kg_available"]:
                if supplier["certified"] == 1:
                    lots.append(lot_id)
        kilns = []
        for kiln_id in sorted(dataset["kilns"]):
            kiln = dataset["kilns"][kiln_id]
            thickness = view["thickness_mm"]
            family_ok = kiln["family_lock"] == "" or kiln["family_lock"] == view["clay_family"]
            window_ok = kiln["thickness_min_mm"] <= thickness <= kiln["thickness_max_mm"]
            if family_ok and window_ok and view["clay_kg"] <= kiln["capacity_kg"]:
                kilns.append(kiln_id)
        benches = [
            bench_id
            for bench_id in sorted(dataset["benches"])
            if dataset["benches"][bench_id]["edge_code"] == view["edge_code"]
        ]
        tempers = []
        for temper_id in sorted(dataset["tempers"]):
            temper = dataset["tempers"][temper_id]
            thickness = view["thickness_mm"]
            window_ok = temper["thickness_min_mm"] <= thickness <= temper["thickness_max_mm"]
            class_ok = (
                (view["temper_required"] == 1 and temper["temper_class"] == "fire")
                or (view["temper_required"] == 0 and temper["temper_class"] == "bypass")
            )
            if window_ok and class_ok and view["panels"] <= temper["capacity_panels"]:
                tempers.append(temper_id)
        options[release_id] = {
            "lots": lots,
            "kilns": kilns,
            "benches": benches,
            "tempers": tempers,
        }

    found: list[list[dict]] = []
    visits = 0

    def walk(index: int, chosen: list[dict], used: dict[str, set[str]]) -> None:
        nonlocal visits
        visits += 1
        if visits > SEARCH_BOUND:
            raise RuntimeError(f"search exceeded {SEARCH_BOUND} visits")
        if index == len(release_ids):
            schedule = schedule_from_choices(dataset, chosen)
            if audit(dataset, schedule) == []:
                found.append([dict(choice) for choice in chosen])
            return
        release_id = release_ids[index]
        view = release_view(dataset, release_id)
        for lot_id in options[release_id]["lots"]:
            if lot_id in used["lots"]:
                continue
            lot = dataset["lots"][lot_id]
            supplier = dataset["suppliers"][lot["supplier_id"]]
            for kiln_id in options[release_id]["kilns"]:
                if kiln_id in used["kilns"]:
                    continue
                kiln = dataset["kilns"][kiln_id]
                if not charge_compatible(view, lot, supplier, kiln):
                    continue
                for bench_id in options[release_id]["benches"]:
                    if bench_id in used["benches"]:
                        continue
                    bench = dataset["benches"][bench_id]
                    for temper_id in options[release_id]["tempers"]:
                        if temper_id in used["tempers"]:
                            continue
                        temper = dataset["tempers"][temper_id]
                        if not finish_compatible(view, bench, temper):
                            continue
                        chosen.append(
                            {
                                "release_id": release_id,
                                "lot_id": lot_id,
                                "kiln_id": kiln_id,
                                "bench_id": bench_id,
                                "temper_id": temper_id,
                            }
                        )
                        used["lots"].add(lot_id)
                        used["kilns"].add(kiln_id)
                        used["benches"].add(bench_id)
                        used["tempers"].add(temper_id)
                        walk(index + 1, chosen, used)
                        used["tempers"].remove(temper_id)
                        used["benches"].remove(bench_id)
                        used["kilns"].remove(kiln_id)
                        used["lots"].remove(lot_id)
                        chosen.pop()

    walk(0, [], {"lots": set(), "kilns": set(), "benches": set(), "tempers": set()})
    found.sort(key=lambda choices: assignment_key(dataset, choices))
    return found, visits


def objectives(dataset: dict, schedule: dict) -> dict[str, str]:
    spend = 0
    import_charges = 0
    recycled_charges = 0
    for charge in schedule["charges"]:
        lot = dataset["lots"][charge["lot_id"]]
        supplier = dataset["suppliers"][lot["supplier_id"]]
        clay_kg = parse_i64(charge["clay_kg"], "clay_kg")
        spend += clay_kg * lot["cents_per_kg"]
        if supplier["import"] == 1:
            import_charges += 1
        if lot["recycled"] == 1:
            recycled_charges += 1
    return {
        "spend_cents": emit_i64(spend),
        "import_charges": emit_i64(import_charges),
        "recycled_charges": emit_i64(recycled_charges),
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")


def self_check(dataset: dict, schedule: dict) -> None:
    if audit(dataset, schedule) != []:
        raise RuntimeError("self-check baseline failed")
    broken_mass = json.loads(json.dumps(schedule))
    broken_mass["charges"][0]["clay_kg"] = emit_i64(
        parse_i64(broken_mass["charges"][0]["clay_kg"], "clay_kg") + 1
    )
    if "6" not in audit(dataset, broken_mass):
        raise RuntimeError("self-check did not reject a bad clay mass")
    broken_kiln = json.loads(json.dumps(schedule))
    broken_kiln["charges"][1]["kiln_id"] = broken_kiln["charges"][0]["kiln_id"]
    if "8" not in audit(dataset, broken_kiln):
        raise RuntimeError("self-check did not reject a repeated kiln")
    broken_panels = json.loads(json.dumps(schedule))
    broken_panels["finishes"][0]["panels"] = emit_i64(
        parse_i64(broken_panels["finishes"][0]["panels"], "panels") + 1
    )
    if "5" not in audit(dataset, broken_panels):
        raise RuntimeError("self-check did not reject a charge-finish panel mismatch")


def select_pair(found: list[list[dict]]) -> tuple[list[dict], list[dict]]:
    if len(found) < 2:
        raise RuntimeError(f"need two solutions, found {len(found)}")
    first = found[0]
    first_structure = structural_key(first)
    for candidate in found[1:]:
        if structural_key(candidate) != first_structure:
            return first, candidate
    raise RuntimeError("no second solution differs in lot, kiln, or temper")


def main() -> None:
    dataset = load_dataset(DATASET_PATH)
    found, visits = search(dataset)
    first, alternative = select_pair(found)
    valid_schedule = schedule_from_choices(dataset, first)
    alternative_schedule = schedule_from_choices(dataset, alternative)
    for schedule in (valid_schedule, alternative_schedule):
        failures = audit(dataset, schedule)
        if failures:
            raise RuntimeError(f"accepted schedule failed audit: {failures}")
        self_check(dataset, schedule)
    write_json(VALID_PATH, valid_schedule)
    write_json(ALTERNATIVE_PATH, alternative_schedule)
    reread_valid = json.loads(VALID_PATH.read_text(encoding="utf-8"))
    reread_alternative = json.loads(ALTERNATIVE_PATH.read_text(encoding="utf-8"))
    if audit(dataset, reread_valid) != [] or audit(dataset, reread_alternative) != []:
        raise RuntimeError("reread schedules failed audit")
    valid_totals = objectives(dataset, reread_valid)
    alternative_totals = objectives(dataset, reread_alternative)
    provenance = {
        "problem": "Meridian Kiln Cooperative facade panel week",
        "model": "grok-4.7",
        "effort": "high",
        "interface": "Grok Build CLI as an Orca dispatched worker",
        "solver_command": SOLVER_COMMAND,
        "search": {
            "method": "depth-first backtracking",
            "order": "release_id ascending, then lot_id, kiln_id, bench_id, temper_id ascending",
            "bound_visits": SEARCH_BOUND,
            "visits": visits,
            "solutions_found": len(found),
            "selection": "lexicographic first, then the next assignment with a different lot, kiln, or temper",
        },
        "input_hashes": {
            "request.md": sha256_file(REQUEST_PATH),
            "reference/dataset.json": sha256_file(DATASET_PATH),
            "outputs.json": sha256_file(OUTPUTS_PATH),
        },
        "requirements_modeled": [
            "1 charge cardinality",
            "2 charge quantity",
            "3 finish cardinality",
            "4 coverage",
            "5 charge-finish join",
            "6 clay mass",
            "7 lot family, availability, certified supplier, unique lot",
            "8 kiln window, capacity, family lock, unique kiln",
            "9 bench edge code, unique bench",
            "10 temper window, capacity, fire or bypass, unique temper",
            "11 import ceiling",
            "12 recycled floor",
            "13 spend ceiling",
        ],
        "reasoning": REASONING,
        "objectives": {
            "valid": valid_totals,
            "alternative": alternative_totals,
        },
        "engine_or_oracle_checked": False,
        "engine_oracle_agreement": "not claimed; checked only by this solver's integer audit",
    }
    write_json(PROVENANCE_PATH, provenance)
    print(f"solutions={len(found)} visits={visits} bound={SEARCH_BOUND}")
    print(
        "valid "
        f"spend_cents={valid_totals['spend_cents']} "
        f"import_charges={valid_totals['import_charges']} "
        f"recycled_charges={valid_totals['recycled_charges']} "
        f"path={VALID_PATH}"
    )
    print(
        "alternative "
        f"spend_cents={alternative_totals['spend_cents']} "
        f"import_charges={alternative_totals['import_charges']} "
        f"recycled_charges={alternative_totals['recycled_charges']} "
        f"path={ALTERNATIVE_PATH}"
    )
    print("structural_difference=lot_or_kiln_or_temper")
    print("validator=pass")
    print("self_check=pass")
    print("engine_or_oracle_checked=false")


if __name__ == "__main__":
    main()
