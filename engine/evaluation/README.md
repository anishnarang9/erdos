# Engine evaluation

The suite separates four questions:

1. Did authoring preserve the request?
2. Does the host checker match independent expected behavior?
3. Does the generated guest match those expectations?
4. Does a real proof bind the checked artifact and recover the exact files?

The deterministic corpus contains 60 requests and 341 candidate deliveries.
Forty requests fit the current language. Ten require clarification.
Ten request named capabilities outside the catalog.
See [challenge coverage](CHALLENGES.md) and [seeded checks](SEEDED.md).

## Run deterministic checks

Run from the repository root. Install Rust 1.98.1, Node, Docker, and `r0vm` 3.1.0.
Use the [engine toolchain setup](../proof-smoke/README.md).
The output directory must not exist.

```sh
RISC0_SERVER_PATH=/path/to/r0vm \
DOCKER_DEFAULT_PLATFORM=linux/amd64 \
engine/evaluation/run-engine-checks.sh /tmp/ubc26-engine-evaluation
```

The command runs the workspace tests, 10,000 seeded cases, and independent Node tests.
It evaluates every candidate with the real CLI.
It then compiles the forty plans and executes their generated guests.
It checks exact artifact identity, expected outcomes, image stability, and input commitments.

The command removes `RUST_LOG` and `RISC0_DEV_MODE` from its child environment.
The engine requires real guest execution. It refuses either variable.
The Docker wrapper applies the measured memory settings to compression containers.
Compilation and execution run sequentially.

All jobs use synthetic contexts. Approval is simulated for evaluation.
Actual buyer approval remains a product requirement.
The scripts do not deploy contracts or send live transactions.
They do not call a model.

## Replay the measured authoring and proof results

Install the local verifier dependencies and the commerce TypeScript dependencies first.
Use Node 24.20 or the tested compatible runtime.
The verifier checkout must be at `ff30da77ba4afdd496290ebebedb205348b15d83`.

```sh
npm ci --prefix engine/tests --ignore-scripts
# Run pnpm install --frozen-lockfile from commerce/.
RISC0_SERVER_PATH=/path/to/r0vm \
engine/evaluation/evaluate.sh \
  /tmp/ubc26-evaluation-replay /path/to/risc0-ethereum
```

This command replays saved model outputs. It makes no new model calls.
It runs the independent host checks and the typed adapters.
It then executes the archived checker packages and verifies every published receipt with the real Solidity verifier.
It also tests each passing/failing pair against reconstructed journals and changed public inputs.
The command rejects an incomplete proof index.

For fresh decryption checks, supply the private proof directory as the third argument.
The command reads release keys there and compares the recovered files byte for byte.
It keeps the keys out of its output.
Without those keys, it reports the original recovery evidence separately from fresh checks.

```sh
RISC0_SERVER_PATH=/path/to/r0vm \
engine/evaluation/evaluate.sh \
  /tmp/ubc26-private-replay /path/to/risc0-ethereum /private/proof-run
```

Git omits empty directories. Replay creates exact reference and evidence directories in private scratch space.
It keeps the public fixture tree unchanged.

## Authoring records and adapters

The [local engine adapter](engine-adapter.ts) implements commerce's imported `Engine` interface.
It returns typed invalid and unsupported results. It throws separate I/O, process, and build failures.
Validation retains the normalized report and preview.
Compilation returns the commerce manifest, the unchanged engine manifest, and the persistent package path.
The package directory must have mode 0700 or stricter.

The [recorded model adapter](recorded-draft-model.ts) implements `DraftModel`.
It matches the exact authoring input before returning a saved result.
It identifies the model and trace. It does not make inference calls.

The [model records](model-records) contain three fresh Luna batch results and two validation-only repair follow-ups.
The configured model was `gpt-6-luna` with `low` reasoning. See the [model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
Each initial batch contains sixty requests in a different order.
Each request therefore has three trial results. Requests within one batch share context and model-authored helpers.
These results are not 180 isolated API calls or independent samples for statistical inference.
The archived helper programs are text records. Replay consumes their JSON outputs.

The model received file contracts, approved reference bytes, the schema, and the capability catalog.
It did not receive the expected predicates, labels, or counterexamples.
The prompt restricted file access. The native model route did not provide a separate filesystem sandbox.
The provenance report records that limit and leaves unavailable token usage as `null`.

The engine accepted 85 of 120 initial draft plans.
One validation-only repair corrected each of the other 35 plans.
All 1,023 candidate outcomes then matched the independent checks.
Four synthetic controls confirm detection of omitted requirements, weaker predicates, changed units, and invented thresholds.
These controls call the real engine and do not count as model trials.
Thirteen final source quotes were not verbatim. The report preserves this annotation defect.
Coverage checks do not grant buyer approval or prove full natural-language equivalence.
Hash-based report comparisons assume SHA-256 collision resistance.

To rebuild and execute every accepted model structure, use the authoring output from a replay:

```sh
env -u RUST_LOG -u RISC0_DEV_MODE \
RISC0_SERVER_PATH=/path/to/r0vm \
node --experimental-transform-types engine/evaluation/run-authoring-guests.mjs \
  /path/to/engine AUTHORING_RUN AUDITED_HOST_RUN/suite NEW_GUEST_RUN
```

For new proofs, `run-proofs.mjs` consumes `proof-selection.json` from that authoring run.
Set `UBC26_AUTHORING_GUEST_REPORT` to the completed model guest report.
Set the pinned prover paths and the low-memory Docker wrapper as the engine guide describes.
The driver runs sequentially and retains completed proofs after a failure.
It never kills a command because of a driver timeout.

## Reports

| Report | Evidence |
| --- | --- |
| `seeded.json` | Seeded native compiler/runtime cases and independent expectations |
| `host/host-report.json` | CLI validation, candidate outcomes, and exact input fingerprints |
| `packages/package-report.json` | Compiled manifests and images grouped by rule structure |
| `execution/execution-report.json` | Actual guest executions and host input rejections |
| `guest-audit.json` | Identity and expectation checks for every executed candidate |
| `invariants/invariants.json` | Parameter, reference, rule-shape, and funded-term checks |
| `logs/` | Actual command output |

Input errors can correctly stop before guest execution.
The report counts those rejections separately from actual guest executions.
The seeded native checks use the runtime evaluator and independent host calculations.
They do not establish guest or proof correctness by themselves.

The checked-in [reports](reports) describe recorded runs.
They do not establish live settlement or live Grok behavior.
Current model and proof coverage appears in the owner status and execution plan.

## Recover a prepared run

`execute-packages.mjs` can consume existing complete packages without repeating Docker builds.
It requires an audited host report for the same engine binary and exact candidate bytes.
An optional final PID lets it wait for a currently live package preparer.
It stops if that process exits before a required package appears.

```sh
env -u RUST_LOG -u RISC0_DEV_MODE \
RISC0_SERVER_PATH=/path/to/r0vm \
node engine/evaluation/execute-packages.mjs \
  /path/to/engine HOST_RUN PACKAGES NEW_EXECUTION_RUN
```

Keep scratch directories private. Proof attempts retain their release keys there.
Do not commit release keys or private deliverables.
