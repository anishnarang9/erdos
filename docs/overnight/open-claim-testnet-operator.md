# Arc Testnet open-claim operator handoff

2026-11-16 — Anish. The [combined local run](../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json) passed with a fresh real proof, exact payout, recovery and refund. These are prepared testnet inputs and commands. No live adapter was deployed, and no live wallet or Circle Gateway payment was used.

## Fixed inputs

Read these values from [the proposed manifest](../../contracts/deployments/open-claim-arc-testnet.template.json) and check them against Arc at one fixed block before signing:

| Input | Value |
| --- | --- |
| RPC | `https://rpc.testnet.arc.io` |
| Chain ID | `5042002` |
| Native USDC | `0x3600000000000000000000000000000000000000` (six decimals) |
| Frozen core proxy | `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8` |
| Core implementation | `0x55A3C9319EEe607579855880b5651766eBF103d7` |
| RISC Zero verifier | `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992` (version `3.1.0`, selector `0xe71e6620`) |
| Adapter constructor | `(core proxy, verifier, native USDC)` in that order |
| Contract | `contracts/src/OpenClaimAdapter.sol:OpenClaimAdapter` |

The adapter address, deployment transaction and block are still unknown. Keep the template's adapter fields null until a confirmed deployment supplies them. The buyer wallet, solver wallet, budget, expiry, gas caps, keystore names and signing authority are also operator inputs. Do not copy local Anvil accounts into a live transaction.

## Read-only checks before deployment

Run these from `contracts/` with the pinned Arc Foundry tools. The existing [deployment guide](../../contracts/script/README.md) defines the toolchain and signer flags. The core verification script checks all admin role holders, the proxy history, code pins and zero fees. It does not deploy the adapter.

```sh
ARC_RPC_URL=https://rpc.testnet.arc.io
ARC_CORE=0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8
ARC_VERIFIER=0xCf8D70A203b40D3A17d023c0CDDF752870BC3992
ARC_USDC=0x3600000000000000000000000000000000000000

arc-cast chain-id --rpc-url "$ARC_RPC_URL"                     # require 5042002
SETTLEMENT_EXPECT_FROZEN=1 arc-forge script \
  script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url "$ARC_RPC_URL"
arc-cast call "$ARC_VERIFIER" 'VERSION()(string)' --rpc-url "$ARC_RPC_URL"
arc-cast call "$ARC_VERIFIER" 'SELECTOR()(bytes4)' --rpc-url "$ARC_RPC_URL"
arc-cast call "$ARC_CORE" 'paymentToken()(address)' --rpc-url "$ARC_RPC_URL"
arc-cast call "$ARC_CORE" 'platformFeeBP()(uint256)' --rpc-url "$ARC_RPC_URL"
arc-cast call "$ARC_CORE" 'evaluatorFeeBP()(uint256)' --rpc-url "$ARC_RPC_URL"
arc-forge build --network arc
```

Compare the outputs with the manifest and the compiled adapter ABI. Stop if the chain, token, verifier or core checks differ. The operator must also check the current `OpenClaimAdapter` runtime build and the deployment transaction before accepting its runtime hash as a pin.

## Authorized adapter deployment

The following command is a prepared **live write**. It requires the operator's exact deployment and gas approval. Set `OPERATOR_KEYSTORE` to a Foundry keystore name and `OPERATOR_ADDRESS` to its address. These flags match the pinned Arc Foundry `forge create --help`. Check the transaction preview before the operator runs it. Never put a raw key in this command, a report or an agent prompt.

```sh
: "${ARC_RPC_URL:?Set the approved Arc RPC URL}"
: "${OPERATOR_KEYSTORE:?Set the approved Foundry keystore name}"
: "${OPERATOR_ADDRESS:?Set the approved deployer address}"
arc-forge create src/OpenClaimAdapter.sol:OpenClaimAdapter \
  --chain 5042002 --rpc-url "$ARC_RPC_URL" \
  --account "$OPERATOR_KEYSTORE" --from "$OPERATOR_ADDRESS" \
  --gas-price 25gwei --priority-gas-price 25gwei \
  --broadcast --constructor-args "$ARC_CORE" "$ARC_VERIFIER" "$ARC_USDC"
```

After confirmation, record the adapter address, transaction hash, block, runtime code hash and constructor inputs in a new deployed manifest. Check `core()`, `verifier()` and `usdc()` on the adapter at a confirmed block. Keep the selected-provider manifest unchanged. The [manifest schema](../../contracts/deployments/OPEN-CLAIM-SCHEMA.md) names every required field and check.

## Funded job and proof inputs

The buyer first imports the typed Meridian plan and references, approves the exact revision, and compiles with the real engine. The [versioned HTTP contract](../../commerce/api/OPEN-CLAIM-v1.md) gives the request bodies. Its `open-claim-terms` response supplies the unsigned `createJob`, `setBudget`, `approve`, `fund`, `register` order. The buyer must inspect and sign each call with their own approved wallet. After the confirmed registration, `open-claim-link` checks both receipts and the exact terms. A solver can then read the public funded feed.

Use at least the measured local proof time plus claim, confirmation and release margin when choosing an expiry. The Meridian proof took about 17 minutes on this host. That measurement is not a testnet timing guarantee. The solver must use its actual payout address in the proof context. After registration, this command creates the public engine job input without signing:

```sh
cd commerce/worker
: "${ARC_RPC_URL:?Set the approved Arc RPC URL}"
: "${OPEN_CLAIM_MANIFEST:?Set the verified deployed manifest path}"
: "${CHAIN_JOB_ID:?Set the confirmed core job ID}"
: "${SOLVER_ADDRESS:?Set the approved solver address}"
: "${PRIVATE_DIR:?Set an owned private output directory}"
pnpm open-claim:job-input --rpc-url "$ARC_RPC_URL" \
  --manifest "$OPEN_CLAIM_MANIFEST" \
  --job-id "$CHAIN_JOB_ID" --solver "$SOLVER_ADDRESS" \
  --out "$PRIVATE_DIR/job.json"
```

The current worker runs through `runOpenClaim` with an injected restricted signer. Its CLI does not broadcast an open-claim transaction. The operator must supply and review that signer, exact gas caps, buyer approval and funded-job manifest before a live claim or release. The local suite used unlocked synthetic Anvil accounts only. The local x402 check used a test facilitator; it did not establish a Circle Gateway charge. Do not use the x402 receipt as evidence that the core bounty was funded.
