# Fresh English-to-proof exchange

## 2026-11-15 — Anish — Scope and current evidence

The user delegated one new synthetic challenge for a proof-gated 1-USDC exchange. This directory separates problem design, constraint authoring, solving and independent checking.

This is not live Arc acceptance. The new job has no recorded live funding, proof submission, payment or recovery.

## Problem

Read the [English request](request.md). Meridian Kiln must select clay lots and exclusive production resources for four releases. Acceptance checks 13 requirements across 37 reference records:

- Exact release coverage and quantities.
- Clay family, mass, supply and supplier certification.
- Kiln capacity, thickness windows and family restrictions.
- Bench and temper compatibility.
- Import, recycled-content and spend bounds.

The [reference dataset](reference/dataset.json) and [output declaration](outputs.json) define the exact files and units. Integer values use decimal strings. Any solution that meets all requirements is acceptable. The task does not require a unique or optimal solution.

## Independent roles

| Role | Actual execution | Artifacts |
| --- | --- | --- |
| English designer | Grok 4.7, high reasoning | `request.md`, `reference/dataset.json`, `outputs.json`, `provenance.json` |
| Constraint author | Native Orca Grok Build Fast, low reasoning (`grok-4.7-build-fast`) | `plan.json`, `authoring/` |
| Solver | Separate native Orca Grok 4.7, high reasoning | `solver/`, `candidates/valid/`, `candidates/alternative/` |
| Semantic checker | Separate worker, recorded | [verification report](verification/REPORT.md) and [independent review](../../agents/anish/reports/localnet-semantic-review-2026-11-15.json) |

The constraint author received no candidate answers or oracle code. Native workers followed explicit input restrictions, not a separate filesystem sandbox.

## Constraint authoring result

The first plan passed real engine validation without repair. It contains 19 rules and 157 operation nodes.

- Rules hash: `0x5d637c9b710c72857f7752f665ca08565eecc7d1c5b3877a5a8339d700a1f60b`.
- Structure hash: `0xb06974923f9625535275905149690c636bbaa6e6e335365a2179907cbe3b85cf`.
- Initial authoring and validation elapsed time: 25 seconds.

The [authoring record](authoring/provenance.json) identifies the fast model, input hashes and original plan. Its prompt file is a sanitized task summary, not the complete session transcript. Token use and price are unavailable. Do not claim a measured monetary cost.

This was fresh native Orca Grok Build Fast inference at low effort. It was not a call through the API's HTTP `DraftModel` integration, and it does not run as an autonomous solver during a funded suite.

## Solver result

The independent bounded solver reported 3,200 acceptable schedules after 19,609 search visits. It retained two different solutions:

- Primary: 30,480 cents, one imported charge and two recycled charges.
- Alternative: 31,440 cents, one imported charge and two recycled charges.

These totals come from the solver's own record. That record does not claim an oracle or engine check. The solver is a saved deterministic Python search written by a separate Grok 4.7 high worker. The funded suite replays `candidates/valid` and does not call this solver, Grok, or HTTP `DraftModel`.

The [semantic report](verification/REPORT.md) records 34 oracle tests, 39 differential cases, and 2 follow-up kiln mutations. The [independent review](../../agents/anish/reports/localnet-semantic-review-2026-11-15.json) passed those 34 oracle tests, 53 paired engine/oracle checks, and a full enumeration of 3,200 accepted schedules from 19,609 visits. Neither check is a Groth16 proof. The [guest report](../../agents/anish/reports/localnet-meridian-guest-2026-11-15.json) published at `1c0b32e` records a real 16-second compile, verdicts 1, 1, and 0, and about 7.05 million cycles. No Meridian proof, payout, or recovery is recorded.

Recorded commands, from the repository root. This page does not claim a new run:

```sh
python3 -B docs/fresh-exchange-input/solver/solve.py
python3 -B -m unittest docs.fresh-exchange-input.tests.test_oracle
```

The funded rehearsal command, placeholders only, is in the [core sprint runbook](../core-sprint.md#local-first-meridian-rehearsal). It requires `UBC26_FUNDED_WORKLOAD=meridian`, an explicit pinned Arc binary, and a private scratch directory.

## Remaining gates

1. Keep the semantic report's 34 tests, 39 differential cases, and 2 follow-ups distinct from the independent review's 53 paired checks and 3,200 enumerated accepts. Do not treat either count as a proof.
2. Run a fresh local funded proof with acceptance, exact payout, dual recovery, oracle agreement, and process exit 0. The partial legacy report is not that run. Pending interruption, verdict 0, Submitted refund, and indexed API checks are still finishing, so no fresh full pass exists. Local fixture timing is in the [rehearsal section](../core-sprint.md#local-first-meridian-rehearsal).
3. Publish the source-stamped Meridian report only after that process exits 0, then pass final-head CI. Both remain pending.
4. Obtain actual public accounts, protected signing access, and exact spending authorization. A local exit 0 does not grant them.
5. Fund the live job only after that authorization, then check accepted submission, payment, and independent recovery.

The operator may control both roles. Distinct buyer/provider addresses make the bounty transfer observable. A deployed contract or valid local proof does not authorize a wallet. Published indexer confirmations withhold the newest three Arc blocks. Simulation stays at zero, and an embedded caller must pass the count explicitly. See the [indexer note](../core-sprint.md#indexer-confirmation-lag).
