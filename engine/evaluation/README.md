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
