# Arc Testnet open-claim operator handoff

2026-11-16 — Anish. The [combined local run](../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json) passed with a fresh real proof, exact payout, recovery and refund. The [adapter was deployed and verified on Arc Testnet](../../agents/anish/reports/open-claim-arc-deployment-2026-11-16.md). No live funded proof, buyer/solver exchange or Circle Gateway payment has been recorded.

## Fixed inputs

Read these values from [the deployed manifest](../../contracts/deployments/open-claim-arc-testnet.json) and check them against Arc at one fixed block before any funded job:

| Input | Value |
| --- | --- |
| RPC | `https://rpc.testnet.arc.io` |
| Chain ID | `5042002` |
| Native USDC | `0x3600000000000000000000000000000000000000` (six decimals) |
| Frozen core proxy | `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8` |
| Core implementation | `0x55A3C9319EEe607579855880b5651766eBF103d7` |
| RISC Zero verifier | `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992` (version `3.1.0`, selector `0xe71e6620`) |
| Verified open-claim adapter | `0x1fEd5e532A1405FAcD45b4096aD1ABf25BbA0CB8`; runtime hash `0x469a337cfb28530e01426274e353792fee03ea8cc7f9663a63c5f9c2a4e13f20` |
| Adapter constructor | `(core proxy, verifier, native USDC)` in that order |
| Contract | `contracts/src/OpenClaimAdapter.sol:OpenClaimAdapter` |

The [read-only preflight](../../agents/anish/reports/open-claim-arc-preflight-2026-11-16.md) checked the frozen core and verifier at Arc block `72554683`, hash `0x240f99565001722f6bfdbeb85e475c7cc0445b8b66ea482cda88fcf68c61192f`. It replayed the complete core role history and found no admin holders. The standard verifier script hit RPC HTTP 429 during its log replay, so it did not finish; the slower independent replay did. A fresh pre-broadcast check at block 72563220 found unchanged pins, zero fees and no new privilege events.

The adapter's confirmed transaction is `0x30a8bc27f9cecf068eeaf5c822196c5149f825671c4e65013d559de353572e14` in block 72563239. The runtime and constructor getters match the compiled artifact and [manifest](../../contracts/deployments/open-claim-arc-testnet.json). The buyer wallet, solver wallet, budget, expiry and protected signing authority remain separate operator inputs. Do not copy local Anvil accounts into a live transaction.

## Read-only checks before live use

Run these from `contracts/` with the pinned Arc Foundry tools. Set the binary paths explicitly; `arc-forge` and `arc-cast` are not on this host's `PATH`. The existing [deployment guide](../../contracts/script/README.md) defines the toolchain and signer flags. The core verification script checks all admin role holders, the proxy history, code pins and zero fees. It does not deploy the adapter.

```sh
ARC_RPC_URL=https://rpc.testnet.arc.io
ARC_FORGE=/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/forge
ARC_CAST=/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/cast
ARC_CORE=0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8
ARC_VERIFIER=0xCf8D70A203b40D3A17d023c0CDDF752870BC3992
ARC_USDC=0x3600000000000000000000000000000000000000

"$ARC_CAST" chain-id --rpc-url "$ARC_RPC_URL"                 # require 5042002
SETTLEMENT_EXPECT_FROZEN=1 "$ARC_FORGE" script \
  script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url "$ARC_RPC_URL"
"$ARC_CAST" call "$ARC_VERIFIER" 'VERSION()(string)' --rpc-url "$ARC_RPC_URL"
"$ARC_CAST" call "$ARC_VERIFIER" 'SELECTOR()(bytes4)' --rpc-url "$ARC_RPC_URL"
"$ARC_CAST" call "$ARC_CORE" 'paymentToken()(address)' --rpc-url "$ARC_RPC_URL"
"$ARC_CAST" call "$ARC_CORE" 'platformFeeBP()(uint256)' --rpc-url "$ARC_RPC_URL"
"$ARC_CAST" call "$ARC_CORE" 'evaluatorFeeBP()(uint256)' --rpc-url "$ARC_RPC_URL"
"$ARC_FORGE" build --network arc
```

Compare the outputs with the manifest and the compiled adapter ABI. Stop if the chain, token, verifier or core checks differ. The operator must also check the current `OpenClaimAdapter` runtime build and the deployment transaction before accepting its runtime hash as a pin.

## Verified adapter deployment

The dedicated encrypted Foundry keystore `ubc26-openclaim-arc-testnet` signed one authorized creation from `0xA2416Eb8159606C133298fF113a472608E6F9Fb7`. Its password remains in macOS Keychain. The transaction used 2,538,847 gas at 25 gwei and paid 0.063471175 testnet USDC, within the approved 0.075 ceiling. The [deployment report](../../agents/anish/reports/open-claim-arc-deployment-2026-11-16.md) records the exact historical command, receipt, creation data, runtime comparison and Blockscout source verification. The [manifest schema](../../contracts/deployments/OPEN-CLAIM-SCHEMA.md) defines the checked fields. No second adapter creation is needed for this handoff.

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

The [protected operator commands](open-claim-live-operator.md) execute the five buyer steps and the solver claim/release through encrypted local keystores and durable journals. The operator must still approve exact gas caps, buyer terms and the deployed manifest before a live write. The local suite used unlocked synthetic Anvil accounts only. The local x402 check used a test facilitator; it did not establish a Circle Gateway charge. Do not use the x402 receipt as evidence that the core bounty was funded.
