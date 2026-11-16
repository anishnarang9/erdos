# Meridian Kiln semantic verification

Independent checker for the English requirements in `request.md`. The oracle and these notes were written without using the plan, authoring artifacts, or solver candidates. Those files were read only after `oracle.py` and `tests/test_oracle.py` existed.

No engine source, model, or solver file was edited. Nothing was compiled, proved, funded, or submitted. Problem selection was already delegated. This check is not wallet approval.

## Inputs left unchanged

Recomputed SHA-256 matches the native designer and author records:

| File | SHA-256 |
| --- | --- |
| `request.md` | `229223c55c23c24e0f70413154acd84994672fa6fee76fe247557c288ec2750e` |
| `reference/dataset.json` | `6ccaaf06a64a68039dace223fc36fad9f60efce3f250d6044c5f7274b60fc06f` |
| `outputs.json` | `ccf5f21cac432a09c93b51ebfe000aeb602227cea70707a0815c74489dce79aa` |
| `plan.json` | `8adab8d931f6065cd91fab141b8049d231fcb29ab438350118c4973c63b9238a` |
| `candidates/valid/schedule.json` | `0607a7b43bf95913d5561d1872b14df0e9ba3fce160946f0bfac99d76608fbc2` |
| `candidates/alternative/schedule.json` | `a6084c49e8fdef4e8fc0059df1f035126a496a634123a57c0447da35e35a7ecd` |

`engine/target/debug/engine validate --plan docs/fresh-exchange-input/plan.json` exited 0. Rules hash `0x5d637c9b710c72857f7752f665ca08565eecc7d1c5b3877a5a8339d700a1f60b`. Structure hash `0xb06974923f9625535275905149690c636bbaa6e6e335365a2179907cbe3b85cf`. Both match `authoring/provenance.json`.

## Requirement map

The plan has 19 rules and 157 operation nodes. Each numbered requirement is one pass, plus a separate `unique` or `count` rule where the request allows it. There is no file hash, file size, byte-equality target, or preferred assignment.

| Requirement | Plan rules | Judgment |
| --- | --- | --- |
| 1 Charge cardinality | 0 `unique` release id, 1 charge count equals release count | Faithful |
| 2 Charge quantity | 2 panels equal the looked-up release panels | Faithful |
| 3 Finish cardinality | 3 `unique` release id, 4 finish count equals release count | Faithful |
| 4 Coverage | 5 every release has a charge and a finish | Faithful |
| 5 Charge-finish join | 6 finish panels equal the looked-up charge panels | Faithful |
| 6 Clay mass | 7 `clay_kg` equals panels times looked-up `kg_per_panel` | Faithful |
| 7 Lot | 8 `unique` lot, 9 family, availability, certified supplier | Faithful |
| 8 Kiln | 10 `unique` kiln, 11 inclusive window, capacity, empty or matching family lock | Faithful |
| 9 Bench | 12 `unique` bench, 13 edge code | Faithful |
| 10 Temper | 14 `unique` temper, 15 inclusive window, capacity, fire when required is 1 and bypass when required is 0 | Faithful |
| 11 Import ceiling | 16 import-charge count at most `max_import_charges` | Faithful |
| 12 Recycled floor | 17 recycled-charge count at least `min_recycled_charges` | Faithful |
| 13 Spend ceiling | 18 sum of `clay_kg * cents_per_kg` at most `max_spend_cents` | Faithful |

A missing lookup key, or any duplicate key in a collection used as a lookup source, aborts evaluation. That is invalid input, not verdict 0. Checked i64 overflow is the same class. Duplicate lot, kiln, bench, and temper ids are ordinary `unique` failures and stay verdict 0, because those lookups read the reference tables.

## Oracle

`docs/fresh-exchange-input/oracle.py` reads `reference/dataset.json` beside itself. It takes one recovered directory and expects only `schedule.json`. Integers are canonical signed i64 strings. Output is `{"accepted", "errors", ...}` with `encoded_bytes` on a real verdict. Structural failures, lookup aborts, and arithmetic aborts omit `encoded_bytes`.

Command:

```sh
python3 -B -m unittest docs.fresh-exchange-input.tests.test_oracle
```

Result: 34 tests, OK. The tests build schedules from the reference. They do not read candidates. They cover both published shapes indirectly by checking two independently chosen feasible assignments, row reordering, unprojected fields, unknown ids, duplicate ids, quantity and resource failures, import and spend ceilings, recycled floor together with spend, overflow, malformed JSON, and the 16384-byte ceiling. A schedule padded to exactly 16384 encoded bytes is accepted. One byte over is `BUNDLE_LIMIT`.

## Engine differential

Command shape, using the existing debug binary and no compiler:

```sh
engine/target/debug/engine eval \
  --plan docs/fresh-exchange-input/plan.json \
  --deliverables <directory> \
  --reference docs/fresh-exchange-input/reference
```

`verification/differential.json` records 39 cases. Oracle and engine agree on all 39: pass, verdict 0, or invalid input. Two follow-up kiln mutations also agree: north on `K-05` (120 kg over 88 kg capacity) and dune on iron-locked `K-04`. Both are oracle `KILN` and engine verdict 0.

Public codes differ and do not change the class. Engine lookup failures are `invalid_deliverable` / `Invalid rule expression`. Overflow is `Rule arithmetic exceeds the i64 range`. Schema and duplicate JSON keys are `File contents do not match the declared schema`. An extra or missing file is `Bundle files differ from the declared files`. A symlink or an oversized bundle is `bundle_input`. None of those returned verdict 0.

Checked schedules:

- `candidates/valid`: accepted. Spend 30480, one import, two recycled. Engine verdict 1.
- `candidates/alternative`: accepted. Spend 31440, one import, two recycled. Engine verdict 1. It differs by charging harbor from `L-KA-24` instead of `L-KA-11`.
- An independent assignment at spend 30180 also received verdict 1. It was not taken from the solver.

The solver's own provenance says it found 3200 accepted assignments in 19609 visits and that an oracle had not checked them. This check did not rerun that search.

## Disagreements

No accept/reject disagreement. No requirement is unsupported or contradicted by the plan.

Dataset boundaries that no feasible schedule hits exactly: lot `kg_available` equal to drawn kilograms, kiln `capacity_kg` equal to drawn kilograms, and spend equal to 32000. The largest lot combination that still meets import and recycled bounds costs 31840. The oracle still uses inclusive comparisons. Passing cases include temper capacity 10 with 10 panels, temper thickness 25 and 40, and kiln thickness 30. Failing cases include kiln capacity, kiln thickness, kiln family lock, spend 32880, and import count 2.

A recycled count of 1 does not fail alone. The assignments that drop below two recycled charges also break spend or import. The oracle reports `RECYCLED_FLOOR` with that other code. Dropping the gate charge and finish is verdict 0 on both sides and includes `RECYCLED_FLOOR`.

## Left outside this check

Live funding, proof generation, payout, and recovery were not run.
