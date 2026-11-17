# Meridian Kiln Cooperative — façade panel week

Meridian Kiln Cooperative has one production week to make architectural terracotta façade panels for four released projects. Each release draws clay from one lot, is charged in one kiln, is edged on one bench, and passes through one temper station. The two schedule collections are those stages: a charge records the lot and kiln, and a finish records the bench and temper for the same release.

Acceptance is fully decided by the 13 requirements below. Any schedule that meets all of them is acceptable. Spend, import count, recycled count, and station choice have no ranking inside the allowed region.

This is a manufacturing-procurement problem. The deliverable is the schedule JSON declared in `outputs.json`. No payment, signature, or proof object is part of this problem.

## Files

- Reference data is `reference/dataset.json`. Bundle it as one file named `dataset.json` with parser `json/v1`.
- The deliverable schema is `outputs.json`. The solver produces one file named `schedule.json`.
- Integer fields in both files are JSON strings, not JSON numbers. A value is canonical when it is an optional leading `-`, then decimal digits, with no `+` and no leading zero except for zero itself. Examples: `"0"`, `"1"`, `"32000"`.
- String equality is exact and case-sensitive. Row order does not matter.
- These 13 requirements are the complete acceptance criteria. Do not add a hash of `schedule.json`, a byte-size target, a minimum, a maximum beyond the stated ceilings and floors, or a preferred assignment.

## Reference schema

`dataset.json` is one object. Its scalar fields and collections are:

| Field or collection | Type | Role |
| --- | --- | --- |
| `max_spend_cents` | i64 | Ceiling on total clay spend, in integer cents |
| `max_import_charges` | i64 | Ceiling on the number of charges whose supplier is an import supplier |
| `min_recycled_charges` | i64 | Floor on the number of charges whose lot is recycled |
| `suppliers` | collection | `supplier_id` string, `certified` i64, `import` i64 |
| `profiles` | collection | `profile_id` string, `thickness_mm` i64, `clay_family` string, `kg_per_panel` i64, `edge_code` string |
| `releases` | collection | `release_id` string, `profile_id` string, `panels` i64, `temper_required` i64 |
| `lots` | collection | `lot_id` string, `clay_family` string, `kg_available` i64, `cents_per_kg` i64, `recycled` i64, `supplier_id` string |
| `kilns` | collection | `kiln_id` string, `thickness_min_mm` i64, `thickness_max_mm` i64, `capacity_kg` i64, `family_lock` string |
| `benches` | collection | `bench_id` string, `edge_code` string |
| `tempers` | collection | `temper_id` string, `thickness_min_mm` i64, `thickness_max_mm` i64, `capacity_panels` i64, `temper_class` string |

Reference joins, each from a foreign id to exactly one parent row:

- `releases.profile_id` joins `profiles.profile_id`.
- `lots.supplier_id` joins `suppliers.supplier_id`.

Field meanings:

- `panels` is the integer number of finished panels the release must produce.
- `kg_per_panel` is the integer kilograms of clay in one panel of that profile. The charge draws exactly `panels * kg_per_panel` kilograms. A lot may have unused kilograms left. One lot supplies at most one charge.
- `cents_per_kg` is the integer cent price of one drawn kilogram. Spend adds `clay_kg * cents_per_kg` over charges. This cent is an accounting unit inside the problem.
- `certified` is `1` when the supplier may be used and `0` otherwise. `import` is `1` when a charge from that supplier counts toward the import ceiling and `0` otherwise.
- `recycled` is `1` when a charge from that lot counts toward the recycled floor and `0` otherwise.
- `temper_required` is `1` when the finish must use a fire temper and `0` when it must use a bypass temper.
- `family_lock` is the empty string when the kiln accepts every clay family. Otherwise it is the only `clay_family` that kiln accepts.
- `temper_class` is `fire` or `bypass`.
- Thickness windows are inclusive. Capacities are inclusive upper bounds.

An encoding example from the reference, not a schedule, is `{"supplier_id": "S-LOCAL", "certified": "1", "import": "0"}`.

## Deliverable

`schedule.json` has the collections declared in `outputs.json` and no scalar fields.

Each `charges` row has `release_id`, `lot_id`, `kiln_id`, `panels`, and `clay_kg`. It is the clay-draw and kiln-charge stage for that release.

Each `finishes` row has `release_id`, `bench_id`, `temper_id`, and `panels`. It is the edge-bench and temper stage for that same release. `release_id` joins a finish to its charge.

Every id in the schedule is the id of a row in the corresponding reference collection: lots, kilns, benches, tempers, and releases. Profile and supplier ids appear only through those joins.

## Requirements

Encode the requirements with the supported operations only: `field`, `literal`, `record_field`, `add`, `sub`, `mul`, `lt`, `lte`, `gt`, `gte`, `eq`, `ne`, `and`, `or`, `not`, `sum`, `count`, `all`, `any`, `unique`, and `lookup`. A lookup key may itself be a lookup. Conjoin the comparisons of one numbered requirement inside a single pass over a collection. Use a second rule only for a uniqueness or count check that sits beside that pass. That direct encoding is about 160 nodes, inside the 256-node limit. Do not use division, sorting, string concatenation, minimization, or maximization.

1. **Charge cardinality.** In `charges`, `release_id` is unique, and the number of rows equals the number of rows in `releases`.
2. **Charge quantity.** For every charge, `release_id` equals some `releases.release_id`, and the charge `panels` equal that release's `panels`.
3. **Finish cardinality.** In `finishes`, `release_id` is unique, and the number of rows equals the number of rows in `releases`.
4. **Coverage.** For every release, at least one charge has that `release_id`, and at least one finish has that `release_id`.
5. **Charge-finish join.** For every finish, the finish `panels` equal the `panels` of the charge whose `release_id` equals the finish `release_id`.
6. **Clay mass.** For every charge, `clay_kg` equals the charge `panels` multiplied by `kg_per_panel` of the profile joined through the release.
7. **Lot.** In `charges`, `lot_id` is unique. For every charge, the lot's `clay_family` equals the joined profile's `clay_family`, `clay_kg` is at most the lot's `kg_available`, and the joined supplier's `certified` equals `1`.
8. **Kiln.** In `charges`, `kiln_id` is unique. For every charge, the joined profile's `thickness_mm` is at least the kiln's `thickness_min_mm` and at most the kiln's `thickness_max_mm`, `clay_kg` is at most the kiln's `capacity_kg`, and the kiln's `family_lock` is the empty string or equals the profile's `clay_family`.
9. **Bench.** In `finishes`, `bench_id` is unique. For every finish, the bench's `edge_code` equals the `edge_code` of the profile joined through the finish's release.
10. **Temper.** In `finishes`, `temper_id` is unique. For every finish, the joined profile's `thickness_mm` lies in the temper's inclusive thickness window, the finish `panels` are at most the temper's `capacity_panels`, and `temper_class` is `fire` when that release's `temper_required` is `1` and `bypass` when `temper_required` is `0`.
11. **Import ceiling.** The number of charges whose joined supplier has `import` equal to `1` is at most `max_import_charges`.
12. **Recycled floor.** The number of charges whose lot has `recycled` equal to `1` is at least `min_recycled_charges`.
13. **Spend ceiling.** The sum over charges of `clay_kg` multiplied by the lot's `cents_per_kg` is at most `max_spend_cents`.

## Instance size

The reference has 37 records: 4 suppliers, 4 profiles, 4 releases, 10 lots, 5 kilns, 6 benches, and 4 tempers. The largest collection has 10 rows. A schedule that meets the cardinality requirements has 4 charge rows and 4 finish rows. One reference file and one deliverable file are sufficient. Those sizes sit inside the engine limits of 256 records per collection, 256 rule nodes, nesting depth 32, a 32768-byte reference bundle, a 16384-byte delivery bundle, and 1000000 expression visits.

## Reference invariants

The published reference already satisfies these facts, so a schedule rule can look up through them:

- `supplier_id`, `profile_id`, `release_id`, `lot_id`, `kiln_id`, `bench_id`, and `temper_id` are unique inside their own collections.
- Every release profile id exists in `profiles`, and every lot supplier id exists in `suppliers`.
- `certified`, `import`, `recycled`, and `temper_required` are `0` or `1`.
- Every thickness window has `thickness_min_mm` at most `thickness_max_mm`.
- `panels`, `kg_per_panel`, `kg_available`, `capacity_kg`, `capacity_panels`, and `cents_per_kg` are positive integers.
- Every `temper_class` is `fire` or `bypass`.
- Every non-empty `family_lock` equals some profile's `clay_family`.
