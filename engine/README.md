# UBC26 engine

The engine turns buyer-approved rules into commitments for a funded job. The final guest will check the deliverable and encrypt its exact bundle bytes. The Arc evaluator will verify the job journal and the matching key commitment. See the [engine plan](../agents/current%20plan/ZKVM-IMPLEMENTATION.md) for the full flow.

## Validate a plan

Run these commands from the repository root.

```sh
cargo +stable run --locked --manifest-path engine/Cargo.toml --bin engine -- \
  validate --plan engine/fixtures/expense-report-plan.json
cargo +stable test --locked --manifest-path engine/Cargo.toml --workspace
node engine/fixtures/check-wire-v1.mjs
```

The validator writes one JSON object to stdout. It includes the normalized structure, ordered parameter slots, canonical JSON, and both hashes. The structure uses zero-based file and field indices in declaration order. Literal values enter parameter slots in rule traversal order. Edit the budget in the sample plan to see the rules hash change while the structure hash stays the same.

The current syntax supports scalar `bool`, `i64`, and `string` values. Write `i64` literals as decimal strings. Rules can read declared fields from `json/v1` files or compare all the text in a `text/v1` file. Use `opaque/v1` for a file declaration with no projected fields. The rule operations are `field`, `literal`, `add`, `sub`, `mul`, `lt`, `lte`, `gt`, `gte`, `eq`, `ne`, `and`, `or`, and `not`. Every rule in the top-level list must evaluate to a Boolean.

A validation failure exits with code 2 and writes JSON to stderr. Unsupported operations, parsers, and evidence profiles include a request with the capability kind and name. For example, an unsupported `sum` rule reports:

```json
{"code":"unsupported_capability","path":"/rules/0/op","message":"Unsupported operation \"sum\"","request":{"kind":"operation","name":"sum"}}
```

## Compile, prove, and decrypt

Use Rust 1.98.1, Docker, and a local `r0vm` 3.1.0. Follow the [proof toolchain setup](proof-smoke/README.md) to load the pinned Groth16 image before proving. Set `DOCKER_DEFAULT_PLATFORM=linux/amd64` on Apple Silicon.

The [JSON Schema](plan-v1.schema.json) describes the scalar authoring format. The validator also checks types, unique names, declared fields, integer range, and aggregate limits. Use normalized decimal strings for `i64` fields in delivery and reference JSON, such as `"9400"`. Reference and delivery directories must contain the exact declared file sets.

```sh
cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine
engine/target/debug/engine compile --plan PLAN --reference REFERENCE_DIR --out PACKAGE_DIR
engine/target/debug/engine prove --package PACKAGE_DIR --job JOB_JSON \
  --deliverables DELIVERY_DIR --reference REFERENCE_DIR --out ATTEMPT_DIR
engine/target/debug/engine decrypt --submission ATTEMPT_DIR/proof.json \
  --key-file ATTEMPT_DIR/release-key.hex --out RECOVERED_DIR
```

- `compile` writes `guest.elf`, `structure.jcs`, `parameters.jcs`, and `manifest.json`. The RISC Zero program binary bundles the guest ELF with the pinned kernel. The manifest reports the RISC Zero image ID in Solidity byte order, the rules and reference hashes, the guest builder, and per-file SHA-256 digests.
- `prove` reads job JSON with two fields. `context` is the 169-byte context in 0x-prefixed hex. `imageId` is the 0x-prefixed image ID from the funded job. Use confirmed chain state for both fields. `--evidence` is optional for scalar plans and must identify an empty directory if supplied.
- `prove` writes `proof.json` and the private `release-key.hex` file. The proof JSON uses numbers for `version` and `verdict`, and 0x-prefixed hex for all byte fields. A valid failing check produces a real proof with verdict 0. The stdout JSON reports `verdict`, `proofFile`, `keyFile`, `proveMillis`, and `userCycles`. Keep the key file private. It contains exactly 32 bytes encoded as lowercase 0x-prefixed hex.
- `decrypt` reads the context from `proof.json`, checks a passing journal and key commitment, then authenticates the envelope. It writes the recovered files to a new directory. The caller checks chain acceptance and retrieves the released key.

The CLI writes JSON errors to stderr. Exit code 2 reports an argument, input, or output error. Exit code 3 reports a Docker build, prover, or randomness failure. Each output directory must be new. The CLI publishes it after all files are ready.

The scalar guest embeds the canonical rule structure in a fixed Rust entry point. Parameters remain runtime inputs. Record collections, signed evidence, and specialized Rust generation remain pending. Run [the funded-job test](tests/funded-job.sh) against the built CLI with `bash engine/tests/funded-job.sh engine/target/debug/engine`. Set `CHECK_FAILING_VERDICT=1` to also produce a verdict-0 receipt.

## Use the wire fixture

[wire-v1.json](fixtures/wire-v1.json) contains the complete bytes for a synthetic funded context, file bundle, encrypted envelope, and journal. The fixture includes a public test key and nonce. The Rust tests and Node script check the same fixture independently. The Node script also checks exact bundle recovery and rejection after the job ID changes.

## Verify the proof toolchain

The [proof smoke check](proof-smoke/README.md) runs a standalone RISC Zero guest and exports a Groth16 seal for the released Solidity verifier. The smoke receipt has a fixed test journal. A funded job requires the full context, rule verdict, envelope hash, and key commitment in its journal.
