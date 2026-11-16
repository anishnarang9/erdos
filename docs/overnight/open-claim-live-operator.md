# Protected open-claim operator

2026-11-16 — Anish. Continue the [testnet handoff](open-claim-testnet-operator.md). The buyer and solver use separate encrypted V3 keystores. The worker accepts password bytes through an inherited private file descriptor. It never passes wallet credentials to the engine.

Before you expose a password file descriptor, run this check from the repository root. Repeat it immediately before each signing command. The check covers the launcher script as well as source and locked dependencies. Keep the reviewed checkout private while it runs.

```sh
: "${OPEN_CLAIM_CONFIG:?Set the approved private config path}"
source_commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceCommit"])' "$OPEN_CLAIM_CONFIG")
test "$(git rev-parse HEAD)" = "$source_commit"
git diff --quiet HEAD -- commerce/worker/package.json commerce/package.json commerce/pnpm-workspace.yaml \
  commerce/worker/src commerce/sdk/src commerce/api/src commerce/pnpm-lock.yaml contracts/src contracts/abi
test -z "$(git ls-files --others --exclude-standard -- commerce/worker/package.json commerce/package.json \
  commerce/pnpm-workspace.yaml commerce/worker/src commerce/sdk/src commerce/api/src commerce/pnpm-lock.yaml \
  contracts/src contracts/abi)"
```

Run from `commerce/worker`:

```sh
pnpm open-claim:operator preview --config /absolute/private/run.json
pnpm open-claim:operator fund --config /absolute/private/run.json --password-fd 3 3</absolute/private/buyer.password
pnpm open-claim:operator prepare --config /absolute/private/run.json
pnpm open-claim:operator run --config /absolute/private/run.json --password-fd 3 3</absolute/private/solver.password
pnpm open-claim:operator recover --config /absolute/private/run.json
pnpm open-claim:operator negative --config /absolute/private/refund-job.json --password-fd 3 3</absolute/private/solver.password
pnpm open-claim:operator refund --config /absolute/private/refund-job.json --password-fd 3 3</absolute/private/buyer.password
pnpm open-claim:operator circle --config /absolute/private/run.json --password-fd 3 3</absolute/private/buyer.password
```

`prepare` proves without signing. `run` can prove and settle, or resume the saved proof. A pending receipt returns a sent phase. Repeat the same command with the same private directories. It checks the saved hash and never replaces or resends an uncertain transaction. Preserve stale locks for manual review. All proving operators must share `proverLockRoot`. Keep all other host provers stopped.

`fund` confirms the five buyer calls before it links the job to the API. Its final result is `funding-result.json`. The API must already hold the approved revision and its `open-claim-terms` intent. Set `BUYER_API_TOKEN` through the operator's private environment. It must not appear in arguments or logs.

The private config requires:

| Field | Meaning |
| --- | --- |
| `version`, `mode`, `chainId` | `1`, `open-claim`, `5042002` |
| `sourceCommit` | Exact clean, committed operator source SHA |
| `rpcUrl`, `manifest` | Approved HTTPS Arc RPC and verified deployment manifest path. Local manifests require loopback HTTP. |
| `buyer`, `solver` | Each has a public `address` and absolute `keystorePath`. |
| `signingAuthorized` | `true` only after the operator approves the exact spending preview. |
| `approval` | Exact API-approved `revision`, `imageId`, `rulesHash`, `referenceHash`, decimal `budget`, decimal absolute `expiry`, and `description`. |
| `apiUrl`, `apiJobId` | Buyer API origin and approved job identity. |
| `directory`, `journalRoot`, `proverLockRoot` | Existing operator-owned directories with mode 0700. Every run for an account shares one durable journal root. |
| `packageDir`, `referenceDir`, `deliverablesDir`, `attemptDir` | Verified package, approved references, solver output, and a new private attempt path. |
| `engine` | The existing sprint engine identity: `mode: native`, absolute `executable`, `executableSha256`, `wrapperSha256`, and an explicit clean `environment`. |
| `gas` | Decimal strings: `buyerPerCall`, `claim`, `release`, `maxFeePerGas`, `maxPriorityFeePerGas`, `buyerTotal`, `solverTotal`. Native units use 18 decimals. |
| `purpose` | Optional `expiry-refund` selects a 750-second funding reserve for the separate refund job. Ordinary proof jobs require 2,460 seconds. |
| `circle` | Optional `url`, `payTo`, decimal `amount`, and separately approved `authorized: true`. |

The proposed main expiry is current confirmed chain time plus 3,600 seconds. The measured proof took 1,053 seconds. The operator allows 1,800 seconds for proving, 60 for claim, and 600 for release and confirmations. Copy the API's exact absolute expiry into the config. Never refresh it inside a retry. The API requires at least 1,200 seconds when it prepares terms. Use a 1,500-second lifetime for the separate refund job. It can expire near the end of proving or shortly afterward.

`recover` writes each audit to a new private attempt directory, so the same approved config can be retried. An interrupted process can leave a public release key in an unfinished private audit directory; review stale attempts manually. It reads the public claim transaction and confirmed key event. It checks exact context and payout receipts, SDK and engine recovery, and gas-adjusted native USDC balances. Its output excludes the release key. The independent workload oracle remains a separate check.

`negative` sends one deliberately invalid seal to the separate funded refund job. It sends no release key. It requires a reverted canonical receipt and no payout. `refund` calls only `core.claimRefund(jobId)` after that job expires. It requires the exact refund event, core-to-buyer token transfer, expired core state, and gas-adjusted buyer balance gain. Both commands reconcile saved hashes before another signing attempt. Funding and refund share the buyer lock and inspect each other's nonce reservations.

## Circle Gateway service payment

Circle Gateway's [official schema](https://developers.circle.com/openapi/gateway-nanopayments.yaml) returns a transfer UUID from settlement. The API marks this `gateway-batch-accepted` with `onchainConfirmed: false`. A UUID is not a chain transaction hash. Follow [Circle's reconciliation process](https://developers.circle.com/gateway-nanopayments/howtos/x402-seller-reconciliation) to obtain later transfer status, batch receipts and Gateway balance changes.

Configure the API with `X402_SETTLEMENT_MODE=circle-gateway`, `X402_FACILITATOR_URL=https://gateway-api-testnet.circle.com/v1/x402`, its resource origin, seller `X402_PAY_TO`, and `X402_AMOUNT=1` for a 0.000001-USDC service charge. Set `X402_EXTRA_JSON` to the USDC domain from [Circle's signing guide](https://developers.circle.com/gateway-nanopayments/howtos/eip-3009-signing): `name: GatewayWalletBatched`, `version: 1`, `verifyingContract: 0x0077777d7eba4688bdef3e311b846f25870a19b9`. The current capability endpoint requires 604,800 seconds of authorization validity.

The buyer must deposit the approved 0.01 USDC into Gateway before paying. The [deposit preview](../../agents/anish/reports/circle-gateway-deposit-preview-2026-11-16.json) contains exact approval and deposit calldata and a separate 0.00575-USDC gas cap. The payment client cannot approve tokens, deposit, or fund escrow. Run `circle` on an approved revision before ordinary compilation stores its manifest. It checks the 402 against the approved URL, recipient and exact amount. It saves one signature privately and repeats that signature after a lost response. It requires a successful compile response and an exact replay with no second charge. Its signature uses the Gateway domain rather than the USDC token domain. The command can run before the adapter manifest exists.

The local facilitator tests remain local tests. Only an actual Gateway result, later batch receipt, and balance evidence can establish live payment and settlement.
