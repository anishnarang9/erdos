# Proposed synthetic sprint input

## Approval status

**Rehearsal only. Buyer approval is pending.**
Prepared on 2026-11-15 under delegated authority to propose synthetic inputs.
This package is not a buyer-approved job or approved settlement terms.
It contains no live identities, secrets, signatures, or transaction instructions.
All data is synthetic and safe to publish.
Public examples cannot establish confidentiality for those example answers.

The buyer must approve the request, reference bytes, output declarations, and independently authored normalized rules before funding.
The parent session must obtain any separate identity, signing, spending, and live-transaction approvals.
Passing the oracle does not provide any such approval.

## Files and separation

Send **only these files** to the separate plan-author agent:

- `request.md`
- `reference/catalog.json`
- `outputs.json`

`outputs.json` declares output types and limits. It is metadata, not a typed engine plan.
Do not send the oracle, tests, this README, or `candidates/` to the plan author.
Use a file allowlist rather than sharing the whole directory or conversation.
The request and reference contain no known candidate, expected assignment, or expected verdict.
This task deliberately produces no typed engine plan.

Keep these files on the independent evaluation side:

- `oracle.py`: semantic validator with a fixed local reference path.
- `tests/test_oracle.py`: standard-library CLI tests and negative mutations.
- `candidates/valid/`: one feasible delivery.
- `candidates/alternative/`: another feasible delivery with different assignments and stamps.
- `candidates/expected.json`: test-only expected verdicts, costs, and pool counts.

Each candidate directory contains exactly the two output files.
The expected-results file remains outside both recovered-delivery directories.
The oracle never reads candidates, expected results, engine code, or an authored plan.
It accepts any allocation and dispatch that satisfy the request.

## Run

Run these commands from the repository root:

```sh
python3 -B -m unittest discover -s docs/core-sprint-input/tests -v
python3 -B docs/core-sprint-input/oracle.py PATH_TO_RECOVERED_DIRECTORY
```

The oracle accepts exactly one argument: the recovered directory.
It always reads `reference/catalog.json` beside its own script.
It does not accept a reference override or use the current directory to locate the reference.
It uses no shell, network, environment credentials, external packages, or engine calls.
It writes one sanitized JSON report to stdout.
Reports contain fixed error codes and, when available, the encoded byte count.
Reports do not contain input contents, local paths, exception details, assignments, or costs.

Exit codes:

- `0`: accepted.
- `1`: rejected or unreadable input.
- `2`: incorrect CLI argument count.

Use an immutable recovered directory during evaluation.
The import rejects symlinks and nonregular files.
It does not provide an atomic filesystem snapshot against concurrent directory replacement.

## Workload and engine fit

This workload allocates eight tasks among four resource pools.
Its second output chooses each pool's dispatch mode and tick.
It differs from ledger reconciliation: the solver chooses assignments and dispatch times.
It checks feasibility rather than equality to a fixed answer.

The rules need only operations already listed in `engine/capabilities-v1.json`:

- Collection coverage, membership, uniqueness, and counts.
- Joins among tasks, pools, allocations, and dispatches.
- Checked integer multiplication and summation for the budget.
- Nested counts for per-pool task capacities.
- Boolean conditions for special tasks and guarded dispatch.
- Inclusive budget, capacity, cutoff, guard-start, and tier bounds.
- A strict task-deadline bound.

The file declarations, projected fields, record scopes, and lookups fit `engine/plan-v1.schema.json`.
Parser constraints match the engine's normalized i64 strings, strict JSON, depth, and array limits.
Extra members remain allowed within those parser limits.
No conditional sum, division, sorting, optimization proof, external truth, or new primitive is needed.
Conditional rules can use Boolean implication.
The independent oracle instead uses ordinary Python loops, dictionaries, and conditionals.

There are 12 reference records and 12 delivery records.
No collection requires more than eight records.
A direct lowering of the semantic requirements needs about 110 expression nodes, below the 256-node cap.
This is a design-size estimate, not a validated plan measurement.
The separate author must validate the actual node count and record scopes.
No compilation, guest execution, or proof is claimed by this package.

The primary example encodes to 668 bytes.
The alternative example encodes to 667 bytes.
Both include all file headers and filenames and stay below the 16,384-byte delivery cap.
Bundle size is `3 + sum(2 + filename_bytes + 4 + content_bytes)`.
The oracle measures original bytes, not reserialized JSON.

## Verification

TDD started with the oracle absent.
The first run failed because the CLI did not exist.
The implementation then passed the semantic and import tests.
A second test-first cycle exposed missing strict-JSON checks before those checks were implemented.

Tests cover:

- Both feasible candidates and order-independent acceptance.
- Extra members, including their JSON depth and array boundaries.
- Missing, duplicate, and foreign task and pool identifiers.
- Units, tier joins, special-task certification, and dispatch mode.
- Inclusive boundaries and strict deadline equality.
- Capacity, budget, integer encoding, integer range, and checked arithmetic.
- Malformed JSON, duplicate members, nonfinite numbers, invalid UTF-8, and invalid Unicode.
- Missing, renamed, unexpected, nested, and symlinked filesystem entries.
- Collection limits and exact 16,384-byte acceptance versus 16,385-byte rejection.
- Rejection of reference overrides with sanitized output.

The parent session should compare the separately authored engine checker with this oracle.
Use the original candidates and independent negative mutations.
Do not repair the request or oracle merely to match an authored checker.
Resolve any disagreement against the buyer-reviewed semantic requirements first.
