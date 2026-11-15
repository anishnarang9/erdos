# Settlement client examples (for the commerce client)

TypeScript with viem 2.57.19 (exact pin). It runs with Node's built-in type stripping (Node 22.18 or later, no build step), because the commerce client is TypeScript and these files can be copied or imported as they are. `npm run typecheck` runs `tsc --noEmit` and `npm test` runs `node --test` with no extra test dependencies.

```bash
cd contracts/examples
npm install
npm test
npm run typecheck
```

| File | Purpose |
| --- | --- |
| `abi.ts` | ABIs from `../abi/*.json` (patched core, hook, verifier) and a minimal USDC ABI |
| `manifest.ts` | `loadDeployment()` reads `../deployments/arc-testnet.json` and fails while addresses are null |
| `encode.ts` | `buildContext`, `buildJournal`, `journalDigest`, `keyCommitment`, `envelopeHash`, `fundOptParams`, `submitOptParams` |
| `preflight.ts` | Read-only checks before `fund`, `submit`, `release`, `claimRefund`; `submitGasLimit` |
| `decode.ts` | Event decoders for hook and core events, and `getSettlementEvents` (paged `getLogs`) |
| `writes.ts` | Write examples. Each takes a `WalletClient` from the caller; no key handling here |
| `fixture.test.ts` | Checks the encoders against the engine fixture (journal digest, key commitment, envelope hash, ChaCha20-Poly1305 decrypt) |

## Lifecycle

Poster (four transactions, in this order):

1. `core.createJob(provider, evaluator = hook, expiredAt, description, hook = hook)`. `expiredAt` must be strictly greater than `now + 300 s` (core rule) and at least `now + MIN_EXPIRY_MARGIN` (hook rule, 600 s in the current config) when `fund` lands. Read the margin from the manifest.
2. `core.setBudget(jobId, amount, "0x")`, sent by the Poster. The patched core allows only the client. Amount is USDC in 6-decimal units and must be above zero.
3. `usdc.approve(core, amount)` for exactly the budget. `fund` has no expected-budget argument, so keep the allowance equal to the budget.
4. `core.fund(jobId, abi.encode(imageId, rulesHash, referenceHash))`. The hook freezes the terms and emits `TermsFrozen`.

Solver:

5. `core.submit(jobId, sha256(envelope), abi.encode(envelope, seal, keyCommitment))`. The hook rebuilds the journal and calls the verifier. A bad proof reverts and the job stays Funded, so the Solver may retry before expiry. Success emits `JobSubmitted` and `ProofAccepted`.
6. `hook.release(jobId, key)`. The hook checks `sha256("UBC26/key/v1" || context || key)` against the submitted commitment and calls `core.complete`, which pays the Solver. Emits `JobCompleted`, `PaymentReleased` and `KeyReleased`.

Refund: once `block.timestamp >= expiredAt`, anyone calls `core.claimRefund(jobId)` (Funded or Submitted). It refunds the Poster and emits `Refunded` and `JobExpired`. `submit` and `release` need `block.timestamp < expiredAt`, so the exact-expiry second belongs to refund and the two never overlap.

Job status names, in order: Open, Funded, Submitted, Completed, Rejected, Expired. The Poster's status check is `getJob(jobId).status`.

## Run order for a client

For each write, call the matching `preflight*` first and send only if `ok` is true: `preflightFund` before step 4, `preflightSubmit` before step 5, `preflightRelease` before step 6, `preflightRefund` before `claimRefund`. Then use `getSettlementEvents` or `decodeReceiptLogs` to read results.

## Gotchas

- **Fee floor.** Arc silently drops a transaction with `maxFeePerGas` below 20 gwei and returns no receipt. `writes.ts` uses `arcFees`, which never goes below 20 gwei. A missing receipt usually means this.
- **Log paging.** `eth_getLogs` fails above a 10,000-block range. `getSettlementEvents` pages in windows of at most 10,000 blocks. Start from the manifest `deployBlock` values, not from block 0.
- **The key is public once released.** `release` puts the key in calldata. Everyone can then decrypt the envelope. `preflightRelease` checks the key against the commitment locally and does not send the key anywhere. Its optional `simulate: true` sends the real key to the RPC node in an `eth_call`, which the RPC operator can read; it is off by default.
- **A garbage seal burns nearly all forwarded gas.** A seal whose proof bytes are not a valid curve point makes the precompile call fail and consume everything it was given. Always send `submit` with an explicit `gas` (see `submitGasLimit`: calldata floor plus a 1,000,000 allowance by default), and simulate first. `eth_estimateGas` reports a revert, not a number, for such a call.
- **Calldata cost on Arc** is 21000 + 40 gas per non-zero byte (EIP-7623 floor), so a full submit at the cap (16,412-byte envelope + 260-byte seal, 16,996 calldata bytes) costs at most 700,840 gas in calldata floor, about 0.0140 USDC at 20 gwei. `MAX_ENVELOPE_BYTES` is 16412.
- **Timestamps are non-decreasing**, not strictly increasing. Two blocks can share a timestamp. `preflight*` uses the latest block's timestamp as "now". Keep a margin of at least a minute near expiry, because your transaction lands in a later block.
- **USDC has 6 decimals** in the ERC-20 view and 18 in the native view. Gas is paid in USDC, so the Poster and Solver both need a balance beyond the bounty.
- **Wallets.** Every write function takes a viem `WalletClient` with an account. Build it in your own code (a local account, JSON-RPC wallet or keystore). Nothing in this package reads or stores a private key.
- **Real verifier gas is UNVERIFIED on Arc.** The 340,000 to 390,000 gas figure for a valid `submit` adds two local measurements (contracts/research/GAS.md). Measure it after Nick deploys.
