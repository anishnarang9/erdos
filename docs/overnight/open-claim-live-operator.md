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

Run from `commerce/worker`. Use direct Node for inherited password FDs. The pnpm script runner can close descriptors above stderr:

```sh
node --import tsx src/open-claim/operator.ts deploy --config /absolute/private/deploy.json --password-fd 3 3</absolute/private/buyer.password
node --import tsx src/open-claim/operator.ts setup --config /absolute/private/setup.json --password-fd 3 3</absolute/private/buyer.password
node --import tsx src/open-claim/operator.ts preview --config /absolute/private/run.json
node --import tsx src/open-claim/operator.ts fund --config /absolute/private/run.json --password-fd 3 3</absolute/private/buyer.password
node --import tsx src/open-claim/operator.ts prepare --config /absolute/private/run.json
node --import tsx src/open-claim/operator.ts run --config /absolute/private/run.json --password-fd 3 3</absolute/private/solver.password
node --import tsx src/open-claim/operator.ts recover --config /absolute/private/run.json
node --import tsx src/open-claim/operator.ts negative --config /absolute/private/refund-job.json --password-fd 3 3</absolute/private/solver.password
node --import tsx src/open-claim/operator.ts refund --config /absolute/private/refund-job.json --password-fd 3 3</absolute/private/buyer.password
node --import tsx src/open-claim/operator.ts circle --config /absolute/private/run.json --password-fd 3 3</absolute/private/buyer.password
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

`negative` sends one deliberately invalid seal to the separate funded refund job. It sends no release key. It requires a reverted canonical receipt and no payout. `refund` calls only `core.claimRefund(jobId)` after that job expires. It requires the exact refund event, core-to-buyer token transfer, expired core state, and gas-adjusted buyer balance gain. Both commands reconcile saved hashes before another signing attempt. Setup, funding and refund share the buyer lock. Each checks all sibling journals and reserves their confirmed nonces permanently.

`setup` needs no adapter manifest. Its private config includes the common identity/source fields, `directory`, `journalRoot`, and `setup: {authorized: true, validUntil: "<Unix seconds>"}`. It permits only three ordered calls: a 0.04-native-USDC transfer to the configured solver, a 10,000-atomic USDC approval to the pinned Gateway, and a 10,000-atomic deposit. The respective gas caps are 25,000, 80,000 and 150,000 at 25 gwei. It checks four confirmations, exact native balance changes, allowance consumption and the deposit's token transfer. A dropped send resumes by its durable hash. It never replaces a transaction.

The approved setup transfer uses the buyer's newly funded 20 testnet USDC. Buyer funding now caps each of ten calls at 290,000 gas. This lower cap leaves the total allocation, including setup and Gateway, at 0.121625 USDC. The approved aggregate gas ceiling remains 0.1235 USDC. The transferred 0.04 USDC funds solver gas and is not another bounty.

Live operator role checks pace log windows by two seconds. They retain only a complete audit with empty privileged roles. Each later check rechecks the prior canonical block hash and scans all new blocks. A changed audit anchor fails closed.

## Circle Gateway service payment

Circle Gateway's [official schema](https://developers.circle.com/openapi/gateway-nanopayments.yaml) returns a transfer UUID from settlement. The API marks this `gateway-batch-accepted` with `onchainConfirmed: false`. A UUID is not a chain transaction hash. Follow [Circle's reconciliation process](https://developers.circle.com/gateway-nanopayments/howtos/x402-seller-reconciliation) to obtain later transfer status, batch receipts and Gateway balance changes.

Configure the API with `X402_SETTLEMENT_MODE=circle-gateway`, `X402_FACILITATOR_URL=https://gateway-api-testnet.circle.com/v1/x402`, its resource origin, seller `X402_PAY_TO`, and `X402_AMOUNT=1` for a 0.000001-USDC service charge. Set `X402_EXTRA_JSON` to the USDC domain from [Circle's signing guide](https://developers.circle.com/gateway-nanopayments/howtos/eip-3009-signing): `name: GatewayWalletBatched`, `version: 1`, `verifyingContract: 0x0077777d7eba4688bdef3e311b846f25870a19b9`. The current capability endpoint requires 604,800 seconds of remaining authorization validity. The official 3.2.0 client adds a 100-second buffer. This operator signs for 604,900 seconds.

The buyer must deposit the approved 0.01 USDC into Gateway before paying. The [deposit preview](../../agents/anish/reports/circle-gateway-deposit-preview-2026-11-16.json) contains exact approval and deposit calldata and a separate 0.00575-USDC gas cap. The payment client cannot approve tokens, deposit, or fund escrow. Run `circle` on an approved revision before ordinary compilation stores its manifest. It checks the 402 against the approved URL, recipient and exact amount. It saves one signature privately and repeats that signature after a lost response. It requires a successful compile response and an exact replay with no second charge. Its signature uses the Gateway domain rather than the USDC token domain. The command can run before the adapter manifest exists.

The local facilitator tests remain local tests. Only an actual Gateway result, later batch receipt, and balance evidence can establish live payment and settlement.

`circle.refreshRejectedValidity: true` permits one explicit repair of a saved short-validity authorization. The client requires Circle's exact `authorization_validity_too_short` response and an empty transfer search for the exact sender, recipient, network and nonce. It archives the old private state. It retains the same nonce, amount, identities and Gateway domain. Only validity changes. A queued or unknown result blocks repair. Interrupted signing blocks repair. Normal retries replay the saved signature.

`deploy` requires separate `deployment.authorized: true`, absolute `previewFile` and `authorizationFile` paths, and decimal `validUntil`. The records must carry the exact approved deployment and 0.201-USDC aggregate gas cap. The wrapper independently pins the human-approved initcode hash. It checks the local artifact, code, proxy slot, zero fees, USDC, canonical audit anchors, all new privileged logs since the prior audit, simulated runtime and gas estimate before loading a keystore. Creation uses at most 3,072,197 gas at 25 gwei. It shares the buyer lock and saves raw creation bytes privately before one dispatch. It never signs a replacement. Reconciliation checks the created address, runtime hash, four confirmations and exact native gas loss. Require independent manifest verification before funding a proof job.

## Docker memory and a failed proof

Read `engine/README.md` before funding a long proof job. Its low-memory Docker wrapper sets `GOMAXPROCS=2`, `GOGC=25`, and `GOMEMLIMIT=4GiB`. The native operator's clean environment rejects `ENGINE_DOCKER`. Use a reviewed private wrapper with the real Docker path fixed in its script. Prepend that wrapper directory to `engine.environment.PATH`. On Apple Silicon, include `DOCKER_DEFAULT_PLATFORM: linux/amd64`. Check the wrapper digest and run a no-proof environment check before a new funded attempt.

The first job-5 proof completed its STARK work but Docker killed Groth16 compression for memory use. No proof artifact, claim, or key release was published. Preserve the failed directory. Its expiry cannot be extended, so a fresh positive job uses a 4,500-second lifetime. This leaves one measured proof, an optional fresh retry, and confirmation/release margin. Retain one prover at a time. Refund the stranded job after its original expiry.

`gas.refundTotal` is an optional cumulative native gas cap for multiple expired jobs. It defaults to one `gas.refund * maxFeePerGas` reservation. A controlled, authorized budget increase must preserve every journal entry, nonce and maximum charge. The recovery run raises cumulative funding reservations to 0.10875 USDC and refunds to 0.0075 USDC. Its aggregate gas ceiling is 0.25 USDC. Each bounty stays 0.01 USDC, and all per-call gas and fee caps stay unchanged. The independent review and before/after entry digests are recorded in the retry-budget report.
