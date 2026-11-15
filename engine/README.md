# UBC26 engine

The engine turns buyer-approved rules into commitments for a funded job. The scalar guest checks the deliverable and encrypts its exact bundle bytes. The Arc evaluator will verify the job journal and the matching key commitment. See the [engine plan](../agents/current%20plan/ZKVM-IMPLEMENTATION.md) for the full flow.

## Validate a plan

Run these commands from the repository root.

```sh
cargo +1.98.1 run --locked --manifest-path engine/Cargo.toml --bin engine -- \
  validate --plan engine/fixtures/expense-report-plan.json
cargo +1.98.1 test --locked --manifest-path engine/Cargo.toml --workspace
node engine/fixtures/check-wire-v1.mjs
```

The validator writes one JSON object to stdout. Its preview preserves file and field names and normalizes decimal values. Revalidating that preview produces the same commitments. It includes the normalized structure, ordered parameter slots, canonical JSON, and both hashes. The structure uses zero-based file and field indices in declaration order. Evidence signers occupy the first parameter slots in declaration order. Literal values follow in rule traversal order. Edit the budget in the sample plan to see the rules hash change while the structure hash stays the same.

The current syntax supports scalar `bool`, `i64`, and `string` values. Write `i64` literals as decimal strings. Rules can read declared fields from `json/v1` files or compare all the text in a `text/v1` file. Use `opaque/v1` for a file declaration with no projected fields. Run `engine capabilities` for the full list of operations. Every rule in the top-level list must evaluate to a Boolean.

A validation failure exits with code 2 and writes JSON to stderr. Unsupported operations, parsers, and evidence profiles include a request with the capability kind and name. A `regex_match` rule at index 0 produces this error.

```json
{"code":"unsupported_capability","message":"Unsupported operation \"regex_match\"","path":"/rules/0/op","request":{"kind":"operation","name":"regex_match"}}
```

## Evaluate an example

Run `engine eval --plan PLAN --deliverables DELIVERY_DIR` to check the example with the same rule evaluator used in the guest. Add `--reference REFERENCE_DIR` when the plan requires reference files. The command returns `{"verdict":1}` or `{"verdict":0}`. It uses the host and does not create an onchain submission.

## Compile, prove, and decrypt

Use Rust 1.98.1, Docker, and a local `r0vm` 3.1.0. Follow the [proof toolchain setup](proof-smoke/README.md) to load the pinned Groth16 image before proving. Set `DOCKER_DEFAULT_PLATFORM=linux/amd64` on Apple Silicon.

The [JSON Schema](plan-v1.schema.json) describes the typed authoring format. The validator also checks types, unique names, declared fields, integer range, and aggregate limits. Use normalized decimal strings for `i64` fields in delivery and reference JSON, such as `"9400"`. Reference and delivery directories must contain the exact declared file sets.

```sh
cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine
engine/target/debug/engine compile --plan PLAN --reference REFERENCE_DIR --out PACKAGE_DIR
engine/target/debug/engine prove --package PACKAGE_DIR --job JOB_JSON \
  --deliverables DELIVERY_DIR --reference REFERENCE_DIR --out ATTEMPT_DIR
engine/target/debug/engine decrypt --submission ATTEMPT_DIR/proof.json \
  --key-file ATTEMPT_DIR/release-key.hex --out RECOVERED_DIR
```

- `compile` writes `guest.elf`, `structure.jcs`, `parameters.jcs`, and `manifest.json`. The RISC Zero program binary bundles the guest ELF with the pinned kernel. The manifest reports the RISC Zero image ID in Solidity byte order, the rules and reference hashes, the guest builder, and per-file SHA-256 digests.
- `prove` reads job JSON with two fields. `context` is the 169-byte context in 0x-prefixed hex. `imageId` is the 0x-prefixed image ID from the funded job. Use confirmed chain state for both fields. `--evidence` is optional when the plan declares no evidence.
- `prove` writes `proof.json` and the private `release-key.hex` file. The proof JSON uses numbers for `version` and `verdict`, and 0x-prefixed hex for all byte fields. A well-formed delivery that fails a rule produces a real proof with verdict 0. Invalid evidence aborts proving. The stdout JSON reports `verdict`, `proofFile`, `keyFile`, `proveMillis`, and `userCycles`. Keep the key file private. It contains exactly 32 bytes encoded as lowercase 0x-prefixed hex.
- `decrypt` reads the context from `proof.json`, checks a passing journal and key commitment, then authenticates the envelope. It writes the recovered files to a new directory. The caller checks chain acceptance and retrieves the released key.

The CLI writes JSON errors to stderr. Exit code 2 reports an argument, input, or output error. Exit code 3 reports a Docker build, prover, or randomness failure. Each output directory must be new. The CLI publishes it after all files are ready.

The scalar guest embeds the canonical rule structure in a fixed Rust entry point. Parameters remain runtime inputs. The compiler emits typed Rust nodes for each supported rule. Run [the funded-job test](tests/funded-job.sh) against the built CLI with `bash engine/tests/funded-job.sh engine/target/debug/engine`. Set `CHECK_FAILING_VERDICT=1` to also produce a verdict-0 receipt.

### Retry Groth16 compression after a memory limit

If Docker records an OOM and exits with code 137, run with the low-memory wrapper. It sets two Go threads, a lower GC target, and a 4 GiB Go memory target in the CPU prover container. It does not change the guest image, witness, or verifier.

```sh
export ENGINE_DOCKER="$(command -v docker)"
wrapper_dir="$(mktemp -d)"
install -m 700 engine/tests/low-memory-docker.sh "$wrapper_dir/docker"
PATH="$wrapper_dir:$PATH" bash engine/tests/funded-job.sh engine/target/debug/engine
```

## Use the wire fixture

[wire-v1.json](fixtures/wire-v1.json) contains the complete bytes for a synthetic funded context, file bundle, encrypted envelope, and journal. The fixture includes a public test key and nonce. The Rust tests and Node script check the same fixture independently. The Node script also checks exact bundle recovery and rejection after the job ID changes.

## Use the scalar proof fixtures

The [passing receipt](fixtures/scalar-proof-pass-v1.json) and [failing receipt](fixtures/scalar-proof-fail-v1.json) contain real Groth16 seals for the expense report example. They share a synthetic job context and the same image ID. Run `node engine/fixtures/check-scalar-proofs.mjs` to reconstruct both journals from their public submission fields. The released Solidity verifier checked both receipts on a local EVM. It rejected the failing receipt when the caller supplied a journal with verdict 1.

The passing check used a total of 9,400 cents. The failing check used 10,400 cents. The cap was 10,000 cents. The proof files contain public submission fields only.

## Verify the proof toolchain

The [proof smoke check](proof-smoke/README.md) runs a standalone RISC Zero guest and exports a Groth16 seal for the released Solidity verifier. The smoke receipt has a fixed test journal. A funded job requires the full context, rule verdict, envelope hash, and key commitment in its journal.

## Reconcile bounded record collections

A JSON file can declare collections alongside scalar fields. Each collection declares its name and record fields. The checker accepts up to 256 records per collection. The sample [reconciliation plan](fixtures/reconciliation/plan.json) checks exact matches against a committed ledger and includes a second text file in the encrypted delivery.

Run the following command. Replace pass with fail to check a changed amount.

    engine eval --plan engine/fixtures/reconciliation/plan.json --deliverables engine/fixtures/reconciliation/pass --reference engine/fixtures/reconciliation/reference

Collection operations use a collection object with source, file, and field. The count operation can include a Boolean where expression. The sum operation uses an integer value expression. The all and any operations use a Boolean where expression. The unique operation names a record field. The lookup operation names keyField and valueField and takes a typed key expression. A lookup requires one matching row and rejects duplicate keys in its source collection.

Use record_field inside a collection expression. Its field identifies the record field. An optional level selects an outer record scope, with 0 for the current record. An empty collection satisfies all and fails any. Empty sums and counts return 0. Arithmetic remains checked. The checker limits each evaluation to 1,000,000 expression visits.

## Verify signed evidence

An evidence declaration names a file, profile, approved signer, payload parser, and projected fields. The compiler puts signer values in committed parameter slots. Rules use source "evidence" to read verified payload fields. A binding connects a signed string field to the SHA-256 hash of a named delivery file. The optional contextField connects another signed string field to SHA-256 of the 169-byte context.

The profiles and signer encodings are as follows.

| Profile | Approved signer bytes | Evidence file |
| --- | --- | --- |
| ed25519/v1 | Raw 32-byte public key | JSON with payload and signature hex |
| eip712/v1 | Raw 20-byte EOA | JSON with payload and signature hex |
| jws/Ed25519/v1 | Raw 32-byte public key | Compact JWS with Ed25519 alg |
| jws/EdDSA/v1 | Raw 32-byte public key | Compact JWS with explicit legacy EdDSA alg |
| jws/ES256/v1 | SEC1 P-256 public key | Compact JWS with ES256 alg |
| jws/RS256/v1 | DER SubjectPublicKeyInfo, 2048–4096 bits | Compact JWS with RS256 alg |

Encode signer and raw envelope byte values as 0x-prefixed hex. Raw Ed25519 evidence signs UBC26/evidence/v1 followed by JCS payload bytes. EIP-712 uses the domain and Evidence type from the shared plan. It requires a low-S signature and recovery byte 0, 1, 27, or 28. JWS signs its original encoded header and payload segments. The parser accepts protected alg and optional typ headers. It rejects key discovery headers and unsupported extensions.

Pass the evidence directory to prove or execute with --evidence. For a host preview, use eval with --evidence and --job when the signatures bind a funded context. The execute command takes the same inputs as prove, with the output directory omitted. It runs the real guest and compares the entire journal with the host checker. It reports verdict and userCycles.

The [public evidence vectors](fixtures/evidence-v1/vectors.json) came from Node crypto and ethers. Rust tests check all six profiles, wrong keys, malformed signatures, altered headers, artifact substitution, and changed contexts. The [test issuer](tests/evidence-fixture.cjs) prepares an isolated job and signs it after compilation. It stores synthetic issuer keys in its scratch directory.

## Reuse checker builds

The compiler emits Rust constructors for the normalized operations and indices. User strings stay in canonical data files. The guest compares the generated nodes with the embedded approved structure before evaluating them.

Compilation caches by the exact staged sources, generated Rust, structure, lockfile, builder configuration, and kernel. Every cache hit recalculates the true image ID and checks the program digest. Successful writes publish atomically. A damaged entry moves to a retained quarantine file before rebuilding.

Set UBC26_ENGINE_CACHE to choose the cache directory. Otherwise the engine uses the user's cache directory. The package includes its exact source tree and lockfile in source/. The compile report adds cacheHit and compileMillis. The package manifest contains buildFingerprint. Parameters and reference contents stay outside the build fingerprint so changes to them can reuse the same guest when its structure is identical.

Keep Docker guest builds and Groth16 compression sequential on an 8 GiB Docker VM. The low-memory prover uses about 5.8 GiB during compression.

## Read the capability catalog

Run engine capabilities to read the machine-readable [catalog](capabilities-v1.json). It lists supported parsers, scalar value types, collection declarations, operations, evidence profiles, limits, and proof fields. Declare record lists with `collections` on a JSON file or evidence policy. The validate command returns the normalized approval preview alongside canonical structure and parameter encodings.

Use file_hash and file_size to compare opaque, text, or JSON files by their exact original bytes. Each operation takes source and file. File hashes use 0x-prefixed SHA-256 strings. File sizes use i64 byte counts. For evidence sources, these operations inspect the authenticated payload. JSON files and record objects can contain unprojected fields, which remain part of the encrypted file bytes.

## Replay verifier checks

Install the pinned test dependencies and check out the released verifier.

```sh
npm ci --prefix engine/tests --ignore-scripts
git clone --depth 1 --branch v3.1.0 https://github.com/risc0/risc0-ethereum.git /tmp/risc0-ethereum-v3.1.0
node engine/tests/solidity/verify.cjs /tmp/risc0-ethereum-v3.1.0 \
  engine/fixtures/signed-text/proof-pass-v1.json /tmp/ubc26-verifier.hex
node engine/tests/verify-arc-rpc.mjs /tmp/ubc26-verifier.hex \
  engine/fixtures/signed-text/proof-pass-v1.json
```

The Solidity test checks the released source revision before compiling it. The Arc script supplies its runtime code to a read-only RPC call through a state override. The stored [RPC reports](fixtures/arc-rpc) record simulated execution against Arc Testnet state. Deployed settlement requires the actual evaluator and funded job terms.

The [signed text fixture](fixtures/signed-text) includes the synthetic job, plan, signature, input file and a real receipt. The [reconciliation fixture](fixtures/reconciliation) includes a synthetic funded context, the ledger, two delivery cases and real receipts for both verdicts. Compile and prove again when the job pins a different image.

## Prepare job JSON from funded terms

Read the confirmed terms from the settlement contract. Check that its image ID, rules hash, and reference hash match the package manifest. Use the Escrow or ERC-8183 core address and the funded provider in the job context.

```sh
node engine/tests/prepare-job.mjs PACKAGE_DIR/manifest.json \
  CHAIN_ID CORE_ADDRESS JOB_ID PROVIDER_ADDRESS > job.json
```

Provide the chain ID and job ID as unsigned decimal integers. The helper encodes the context and writes the JSON input for prove. It uses the package hashes and the supplied addresses. The settlement client must confirm those values on chain.

To compile and prove the demo cases with synthetic job contexts, run the reproduction script. It checks the cold and warm engine cache results, verifies that both builds produced the same guest digest, and compares the recovered files byte for byte. Keep the scratch directory private. It contains release keys and synthetic signer keys.

```sh
bash engine/tests/reproduce-release.sh engine/target/debug/engine NEW_SCRATCH_DIR
node engine/tests/report-release.mjs NEW_SCRATCH_DIR
```

The [release measurements](fixtures/release-report.json) cover the reviewed reconciliation pair, signed text, and full delivery limit. Each proof uses a 260-byte seal. On an Apple M3 Pro with the amd64 compression container, engine cache misses took 14.7–17.9 seconds and hits took 3.5–3.6 seconds. Docker could reuse its own build cache. The signed-text proving run was interrupted by host sleep. Use the recorded guest cycles to compare the cases. Native Linux proving time is pending.

Run the Solidity wire harness with the passing and failing receipts from the same checker and job. It rebuilds each journal from context, verdict, envelope, and key commitment. It checks that a passing-only verifier rejects a verdict-0 receipt and changed inputs.

```sh
node engine/tests/solidity/check-job-wire.cjs /tmp/risc0-ethereum-v3.1.0 \
  engine/fixtures/reconciliation/proof-pass-v1.json \
  engine/fixtures/reconciliation/proof-fail-v1.json
node engine/tests/measure-submit-calldata.mjs engine/fixtures/reconciliation/proof-pass-v1.json
```

The calldata tool encodes the documented submit ABI and counts zero and nonzero bytes. It reports the calldata gas component under the stated per-byte assumptions. Actual settlement gas includes verification, storage, and contract calls and requires the deployed evaluator.

The [delivery limit fixture](fixtures/limits) uses a 16,384-byte encoded delivery. The envelope is 16,412 bytes and the documented submit calldata is 16,996 bytes. The [offline measurement](fixtures/limits/calldata.json) reports 268,228 gas for calldata under the 4 and 16 gas per byte assumptions. The proof took 548.906 seconds and the recovered 16,367-byte file matched the original. The reproduction driver generates the file from repeated `0x7f` bytes.

To check a deployed verifier directly, supply its confirmed Arc Testnet address and a proof JSON file. The probe reads the chain ID, code, selector, and proof result at a single block. The estimate covers the verifier call.

```sh
node engine/tests/verify-deployed-arc.mjs VERIFIER_ADDRESS PASS_PROOF_JSON
```

After confirming the deployed core and evaluator, run the funded submit preflight with a proof for that job. It reads the provider and escrow address from the committed context. At one Arc block it simulates `submit` with the original seal and checks that a changed seal reverts. Add `--fail-proof FAIL_PROOF_JSON` to check a verdict-0 receipt for the same funded job and image. The gas estimate, when available, covers the submit call. The preflight requires no signing key.

```sh
node engine/tests/verify-funded-arc.mjs PASS_PROOF_JSON
```
