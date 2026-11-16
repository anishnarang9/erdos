# Local open-claim exchange

This runbook uses a forkless Arc Anvil node, its unlocked synthetic accounts and native local USDC. The verifier is RISC Zero Groth16 3.1.0. It never uses a live Arc wallet or a model API key. The [HTTP route contract](../../commerce/api/OPEN-CLAIM-v1.md) and [adapter interface](open-claim-v1.md) define the buyer and chain calls.

## Tools and checkout

Use the pinned Arc Foundry, solc 0.8.28, Rust 1.98.1, RISC Zero r0vm 3.1.0 and Groth16 prover image described in [the core sprint runbook](../core-sprint.md) and [engine README](../../engine/README.md). Keep one prover process at a time. A Meridian proof took about 17 minutes on the test host; that time is an observation, not a deadline guarantee.

```sh
git checkout codex/open-escrow-rescue
cd commerce
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
cd ../contracts
"$ARC_FORGE" build
```

`ARC_FORGE`, `ARC_CAST` and `ARC_ANVIL` must point to the pinned Arc Foundry executables. Set `UBC26_OPEN_CLAIM_ENGINE_BIN` to the pinned engine binary. Build it with `cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine` if needed. Check its SHA-256 before the run.

## Deploy on a fresh local node

Start this node in a separate terminal. The `--network arc` flag is required for native USDC behavior.

```sh
"$ARC_ANVIL" --network arc --chain-id 5042002 --host 127.0.0.1 --port 18545 \
  --accounts 3 --balance 100
```

Use only the node's unlocked synthetic account for local deployment. The guarded script refuses a non-Arc chain, a missing native USDC predeploy or an existing live core at the known Arc address.

```sh
cd contracts
OPEN_CLAIM_LOCAL=1 "$ARC_FORGE" script \
  script/09_DeployOpenClaimLocal.s.sol:DeployOpenClaimLocal \
  --rpc-url http://127.0.0.1:18545 \
  --sender 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 \
  --unlocked --broadcast
ARC_CAST="$ARC_CAST" python3 script/verify-open-claim-local.py \
  --rpc-url http://127.0.0.1:18545
```

The verifier writes `contracts/deployments/open-claim-local.json`. Check its core, adapter, verifier, implementation, runtime hashes, zero fees and role renounces against the confirmed receipts before any job is funded. The local deployment check is a read-only check; the deployment command is a local synthetic transaction.

## Prepare two funded jobs

Run the API with the real engine and the local deployment addresses. Keep `XAI_API_KEY` unset for typed import. `PACKAGES_DIR` must be an owned private directory. From the repository root, start it in another terminal with the same local node and verified manifest:

```sh
umask 077
: "${SCRATCH_DIR:?Set an owned private scratch directory}"
: "${UBC26_OPEN_CLAIM_ENGINE_BIN:?Set the pinned engine binary}"
: "${BUYER_API_TOKEN:?Set a local token of at least 16 characters}"
export PACKAGES_DIR="$SCRATCH_DIR/packages"
mkdir -p "$PACKAGES_DIR"
export ENGINE_MODE=native ENGINE_PATH="$UBC26_OPEN_CLAIM_ENGINE_BIN"
export OPEN_CLAIM_RPC_URL=http://127.0.0.1:18545 OPEN_CLAIM_CHAIN_ID=5042002
export OPEN_CLAIM_CORE=$(python3 -c 'import json;print(json.load(open("contracts/deployments/open-claim-local.json"))["core"]["address"])')
export OPEN_CLAIM_ADAPTER=$(python3 -c 'import json;print(json.load(open("contracts/deployments/open-claim-local.json"))["adapter"]["address"])')
export OPEN_CLAIM_VERIFIER=$(python3 -c 'import json;print(json.load(open("contracts/deployments/open-claim-local.json"))["verifier"]["address"])')
export OPEN_CLAIM_USDC=0x3600000000000000000000000000000000000000
unset XAI_API_KEY
HOST=127.0.0.1 PORT=18787 DB_PATH="$SCRATCH_DIR/api.db" pnpm --dir commerce/api dev
```

Use the API's [typed revision, approval and compile routes](../../commerce/api/CONTRACT-T5-T8.md) to compile the `docs/fresh-exchange-input` Meridian plan and references. Approve the exact revision, rules and reference digests before compile. `POST /v1/jobs/:id/open-claim-terms` returns the ordered unsigned buyer transactions. Send them only from the unlocked local buyer account, in its `createJob`, `setBudget`, `approve`, `fund`, `register` order. Use the confirmed `JobCreated` event's job ID in the last three calls. Check every receipt, then call `open-claim-link` after the five receipts have three more local blocks. The public `GET /v1/open-jobs` feed must show the registered funded job before a solver starts.

From the repository root, this creates the typed Meridian revision without a model call. The API server must already use the real engine and the same private `PACKAGES_DIR`. Set `SCRATCH_DIR` to a new mode-0700 directory and `BUYER_API_TOKEN` to the server's local token. The fixed reference digest belongs to the checked-in `dataset.json`; a changed file must fail validation.

```sh
: "${SCRATCH_DIR:?Set an owned private scratch directory}"
: "${BUYER_API_TOKEN:?Set the local API buyer token}"
: "${PACKAGES_DIR:?Set the API package directory}"
api=http://127.0.0.1:18787
python3 - "$PWD" > "$SCRATCH_DIR/import.json" <<'PY'
import base64, json, sys
from pathlib import Path
root = Path(sys.argv[1])
reference = (root / 'docs/fresh-exchange-input/reference/dataset.json').read_bytes()
body = {
    'source': 'import',
    'revision': {
        'plan': json.loads((root / 'docs/fresh-exchange-input/plan.json').read_text()),
        'referenceDigest': '0x9c652686c37d6fd375c8b7f930eff54bdc7b67c1c23666f4eb3542f75bc30812',
        'outputs': [{'name': 'schedule.json', 'format': 'json'}],
        'expirySeconds': 7200,
        'maxBudget': '1000000',
    },
    'references': [{'name': 'dataset.json', 'contentBase64': base64.b64encode(reference).decode()}],
}
print(json.dumps(body))
PY
curl -fsS -X POST "$api/v1/jobs" \
  -H "Authorization: Bearer $BUYER_API_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: meridian-import-1' \
  --data-binary @"$SCRATCH_DIR/import.json" > "$SCRATCH_DIR/created.json"
job_id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["jobId"])' "$SCRATCH_DIR/created.json")
revision_hash=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["revision"]["revisionHash"])' "$SCRATCH_DIR/created.json")
curl -fsS -X POST "$api/v1/jobs/$job_id/approve" \
  -H "Authorization: Bearer $BUYER_API_TOKEN" -H "If-Match: $revision_hash" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: meridian-approve-1' \
  -d "{\"revisionHash\":\"$revision_hash\",\"referenceDigest\":\"0x9c652686c37d6fd375c8b7f930eff54bdc7b67c1c23666f4eb3542f75bc30812\"}" \
  > "$SCRATCH_DIR/approved.json"
curl -fsS -X POST "$api/v1/jobs/$job_id/compile" \
  -H "Authorization: Bearer $BUYER_API_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: meridian-compile-1' \
  -d "{\"revisionHash\":\"$revision_hash\"}" > "$SCRATCH_DIR/compiled.json"
python3 - "$PACKAGES_DIR" "$SCRATCH_DIR/package" <<'PY'
from pathlib import Path
import shutil, sys
packages = [p for p in Path(sys.argv[1]).iterdir() if p.is_dir()]
if len(packages) != 1:
    raise SystemExit('Use a fresh PACKAGES_DIR with one compiled package')
shutil.copytree(packages[0], Path(sys.argv[2]))
PY
```

Check `compiled.json` against the approved revision and the package manifest. Then call `open-claim-terms` as shown in the [versioned HTTP contract](../../commerce/api/OPEN-CLAIM-v1.md). The recorded slow test used job 2 for refund and job 3 for the exchange. Its checked-in reports refer to those exact IDs and transaction hashes. On a fresh node, create and fund two jobs, regenerate the reports from their own receipts, and pass the report paths to the slow test. The IDs need only be positive and distinct. Do not reuse a report against different chain state.

For the two-solver acceptance test, reserve one registered funded job for the exchange and a second funded job for the expiry refund. Both use a 1,000,000-unit bounty, meaning one USDC at six decimals. Use at least 7,200 seconds between funding and expiry for the Meridian proof on this host. Do not set the refund job's expiry earlier than the exchange job's expected release time.

The checked-in [local funding report](../../agents/anish/reports/open-claim-local-funding-api-2026-11-16.json) records the exact approved manifest, five buyer transactions, confirmed job 3 and API detail from the first run. It is evidence for that run, not a reusable transaction recipe. Native USDC also pays gas. Check the `Transfer` from buyer to core for exactly 1,000,000 units; a buyer account balance delta also includes gas.

## Prove and settle

The explicit slow suite lives in `commerce/worker/test/integration/open-claim-real.test.ts`. It reads the checked-in local deployment and funding reports by default. For a fresh node, set `UBC26_OPEN_CLAIM_DEPLOYMENT_REPORT` and `UBC26_OPEN_CLAIM_FUNDING_REPORT` to new JSON files in the same shapes. The deployment report supplies `contracts` (`core`, `adapter`, `verifier`, `implementation`), four `runtimeCodeHashes`, and the core and adapter deployment blocks in `receipts[2]` and `receipts[3]`. The funding report supplies `workload` commitments and candidate SHA-256, `apiJob` with the linked API job ID, core job ID, revision, amount, expiry and registration hash, and `directFundedJob` with the separate refund job ID, amount and expiry. Use the confirmed `JobCreated`, `JobFunded` and `TermsRegistered` receipts and approved API compile output to fill them. Keep the older reports unchanged.

The suite first verifies a separately generated exchange-job proof for solver 2, including an `eth_call` through the real on-chain verifier. It then asks the worker to generate a fresh exchange-job proof for solver 1 and make one claim and one release. It mines three confirmation blocks after each send and resumes from the saved hashes. It checks that the losing worker sends neither a claim nor a key, reads the exact core-to-adapter and adapter-to-solver transfers, recovers bytes through SDK and engine, runs the independent oracle, then expires and refunds the other job.

Create the solver-2 proof with the same pinned engine, approved package, reference and valid candidate files. Its job JSON context must use the adapter, the exchange job ID and solver 2. Keep `proof.json` and `release-key.hex` in a private directory. Never commit the key. The suite generates solver 1's proof itself. The scratch directory must contain `package/` from the approved compile and `attempt/proof.json` from a separate refund-job/solver-1 proof. The latter is used only for the wrong-job rejection check.

The read-only worker command builds the engine job JSON from confirmed adapter terms and the local deployment manifest. It checks code pins, role history and SDK context bytes. Run it for each independent proof before `engine prove`:

```sh
cd commerce/worker
: "${SCRATCH_DIR:?Set an owned private scratch directory}"
: "${EXCHANGE_JOB_ID:?Set the confirmed core job ID}"
scratch="$SCRATCH_DIR"
pnpm open-claim:job-input --rpc-url http://127.0.0.1:18545 \
  --manifest ../../contracts/deployments/open-claim-local.json \
  --job-id "$EXCHANGE_JOB_ID" --solver 0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc \
  --out "$scratch/exchange-solver2.json"
"$UBC26_OPEN_CLAIM_ENGINE_BIN" prove \
  --package "$scratch/package" --job "$scratch/exchange-solver2.json" \
  --deliverables ../../docs/fresh-exchange-input/candidates/valid \
  --reference ../../docs/fresh-exchange-input/reference \
  --out "$scratch/attempt3"
```

For the wrong-job proof, use the separate refund job ID, solver `0x70997970c51812dc3a010c7d01b50e0d17dc79c8`, and output directory `$scratch/attempt`. Keep `$scratch` owned and private. The command was checked against the first run's job-3 input and produced identical public bytes.

On a memory-limited host, put a `docker` wrapper at the front of a private `PATH` directory. The first run used this wrapper with `ENGINE_DOCKER` set to the real Docker executable:

```sh
#!/bin/sh
set -eu
: "${ENGINE_DOCKER:?Set ENGINE_DOCKER to the real Docker executable}"
if [ "$#" -gt 0 ] && [ "$1" = run ]; then
  shift
  exec "$ENGINE_DOCKER" run -e GOMAXPROCS=2 -e GOGC=25 -e GOMEMLIMIT=4GiB "$@"
fi
exec "$ENGINE_DOCKER" "$@"
```

Clear `RISC0_DEV_MODE` and `RUST_LOG` before the real proof. Do not use a development receipt.

```sh
cd commerce/worker
: "${SCRATCH_DIR:?Set an owned private scratch directory}"
: "${UBC26_OPEN_CLAIM_ENGINE_BIN:?Set the pinned engine binary}"
: "${LOSER_PROOF_DIR:?Set the private solver-2 proof directory}"
: "${DEPLOYMENT_REPORT:?Set the fresh local deployment report}"
: "${FUNDING_REPORT:?Set the fresh local funding report}"
: "${RISC0_R0VM_PATH:?Set r0vm 3.1.0}"
: "${ENGINE_DOCKER:?Set the real Docker executable}"
: "${WRAPPER_DIR:?Set the private Docker wrapper directory}"
UBC26_OPEN_CLAIM_LOCAL_RPC=http://127.0.0.1:18545 \
UBC26_OPEN_CLAIM_API_URL=http://127.0.0.1:18787 \
UBC26_OPEN_CLAIM_SCRATCH="$SCRATCH_DIR" \
UBC26_OPEN_CLAIM_ENGINE_BIN="$UBC26_OPEN_CLAIM_ENGINE_BIN" \
UBC26_OPEN_CLAIM_LOSER_PROOF_DIR="$LOSER_PROOF_DIR" \
UBC26_OPEN_CLAIM_DEPLOYMENT_REPORT="$DEPLOYMENT_REPORT" \
UBC26_OPEN_CLAIM_FUNDING_REPORT="$FUNDING_REPORT" \
RISC0_R0VM_PATH="$RISC0_R0VM_PATH" RISC0_SERVER_PATH="$RISC0_R0VM_PATH" \
ENGINE_DOCKER="$ENGINE_DOCKER" PATH="$WRAPPER_DIR:$PATH" \
pnpm exec vitest run --config vitest.open-claim-real.config.ts
```

The test writes a private `open-claim-acceptance-result.json` in its scratch directory. Review its process exit code and the chain receipts. The [passing combined report](../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json) records the independently audited result from one run. A unit or mock-verifier pass does not replace this slow suite. The fast, read-only deployment port test uses `UBC26_OPEN_CLAIM_LOCAL_RPC=http://127.0.0.1:18545 pnpm exec vitest run --config vitest.open-claim.config.ts` from `commerce/worker` after the jobs exist.

## Live boundary

The local manifest does not supply a live adapter address. [The testnet template](../../contracts/deployments/open-claim-arc-testnet.template.json) keeps null fields; the separate [deployed manifest](../../contracts/deployments/open-claim-arc-testnet.json) records the verified Arc adapter. The [operator handoff](open-claim-testnet-operator.md) lists its fixed inputs and read-only checks. Before a live funded job, an operator still needs buyer approval, solver wallet policy and exact signing authority. The local proof and synthetic USDC moves do not authorize a Circle Gateway payment or real buyer/solver signing.
