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

Run the API with the real engine and the local deployment addresses. Keep `XAI_API_KEY` unset for typed import. `PACKAGES_DIR` must be an owned private directory. Use the API's [typed revision, approval and compile routes](../../commerce/api/CONTRACT-T5-T8.md) to compile the `docs/fresh-exchange-input` Meridian plan and references. Approve the exact revision, rules and reference digests before compile. `POST /v1/jobs/:id/open-claim-terms` returns the ordered unsigned buyer transactions. Sign them only with the unlocked local buyer account, then call `open-claim-link` after the five receipts have three more local blocks. The public `GET /v1/open-jobs` feed must show the registered funded job before a solver starts.

For the two-solver acceptance test, reserve one registered funded job for the exchange and a second funded job for the expiry refund. Both use a 1,000,000-unit bounty, meaning one USDC at six decimals. Use at least 7,200 seconds between funding and expiry for the Meridian proof on this host. Do not set the refund job's expiry earlier than the exchange job's expected release time.

The checked-in [local funding report](../../agents/anish/reports/open-claim-local-funding-api-2026-11-16.json) records the exact approved manifest, five buyer transactions, confirmed job 3 and API detail from the first run. It is evidence for that run, not a reusable transaction recipe. Native USDC also pays gas. Check the `Transfer` from buyer to core for exactly 1,000,000 units; a buyer account balance delta also includes gas.

## Prove and settle

The explicit slow suite lives in `commerce/worker/test/integration/open-claim-real.test.ts`. It uses the checked-in local deployment and funding reports and assumes they match the running node. It first verifies a separately generated job-3 proof for solver 2, including an `eth_call` through the real on-chain verifier. It then asks the worker to generate a fresh job-3 proof for solver 1 and make one claim and one release. It mines three confirmation blocks after each send and resumes from the saved hashes. It checks the losing worker sends neither a claim nor a key, reads the exact core-to-adapter and adapter-to-solver transfers, recovers bytes through SDK and engine, runs the independent oracle, then expires and refunds job 2.

Create the solver-2 proof with the same pinned engine, approved package, reference and valid candidate files. Its job JSON context must be `adapter + job 3 + solver 2`, not the core or another solver. Keep `proof.json` and `release-key.hex` in a private directory. Never commit the key. The suite generates solver 1's proof itself. The scratch directory must contain `package/` from the approved compile and `attempt/proof.json` from a separate job-2/solver-1 proof. The latter is used only for the wrong-job rejection check.

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
UBC26_OPEN_CLAIM_LOCAL_RPC=http://127.0.0.1:18545 \
UBC26_OPEN_CLAIM_API_URL=http://127.0.0.1:18787 \
UBC26_OPEN_CLAIM_SCRATCH=<owned-private-scratch-dir> \
UBC26_OPEN_CLAIM_ENGINE_BIN=<pinned-engine-binary> \
UBC26_OPEN_CLAIM_LOSER_PROOF_DIR=<private-job-3-solver-2-proof-dir> \
RISC0_R0VM_PATH=<r0vm-3.1.0> RISC0_SERVER_PATH=<r0vm-3.1.0> \
ENGINE_DOCKER=<real-docker-executable> PATH=<private-wrapper-directory>:$PATH \
pnpm exec vitest run --config vitest.open-claim-real.config.ts
```

The test writes a private `open-claim-acceptance-result.json` in its scratch directory. Review its process exit code and the chain receipts. A unit or mock-verifier pass does not replace this slow suite. The fast, read-only deployment port test uses `UBC26_OPEN_CLAIM_LOCAL_RPC=http://127.0.0.1:18545 pnpm exec vitest run --config vitest.open-claim.config.ts` from `commerce/worker` after the jobs exist.

## Live boundary

The local manifest does not supply a live adapter address. [The testnet template](../../contracts/deployments/open-claim-arc-testnet.template.json) has null deployment fields. Before any live use, an operator must supply the actual deployment receipts and runtime hashes, a funded buyer approval, solver wallet policy and exact signing authority. The local proof and synthetic USDC moves do not authorize live deployment, Circle Gateway payment or real wallet signing.
