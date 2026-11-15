# `@ubc26/sdk` Arc settlement module: interface contract

How to use the module: [README.md](README.md).

Source of truth: Nick's settlement (`nick-settlement` @ `80c8a4a`): `agents/current plan/SETTLEMENT-IMPLEMENTATION.md`, `contracts/examples/README.md`, and the ABIs and manifest copied here (`abi/`, `arc-testnet.json`). `nick-examples/` is Nick's code for reference, copied unchanged except one `// @ts-nocheck` line at the top of `fixture.test.ts` (see Deviations 9). The module below is ours.

Exported from `@ubc26/sdk` as `arc` (`import { arc } from "@ubc26/sdk"`). Browser-safe throughout. viem 2.57.19.

```ts
// deployment
interface Deployment { chainId: number; rpcUrl: string; usdc: Address; core: Address; hook: Address; verifier: Address;
  minExpiryMarginSeconds: number; coreMinExpirySeconds: number; maxEnvelopeBytes: number; deployBlock: bigint /* min of core and hook */ }
const ARC_TESTNET: Deployment                      // from arc-testnet.json, checked at load (no nulls, checksummed), frozen
function deploymentFrom(manifestJson: unknown): Deployment   // throws ArcError("bad_manifest")
const coreAbi, hookAbi, verifierAbi, erc20Abi, errorsAbi     // errorsAbi: every custom error of core + hook + verifier
const ARC_TESTNET_CHAIN_ID = 5042002; const MIN_MAX_FEE_PER_GAS = 20 gwei; const MAX_LOG_WINDOW = 10_000n

// reads (PublicClient). Rate-limit answers are retried; other failures throw ArcError("rpc").
const JOB_STATUS = ["Open","Funded","Submitted","Completed","Rejected","Expired"] as const
interface Job { id: bigint; client: Address; provider: Address; evaluator: Address; description: string; budget: bigint; expiredAt: bigint; status: JobStatusName; hook: Address }
interface Terms { imageId: Hex; rulesHash: Hex; referenceHash: Hex; provider: Address; budget: bigint; expiry: bigint; frozen: boolean }  // hook.terms; frozen = ABI `funded`
interface Submission { envelopeHash: Hex; keyCommitment: Hex; submitted: boolean }      // hook.submissions; submitted = ABI `accepted`
interface HookConfig { core: Address; verifier: Address; usdc: Address; maxEnvelopeBytes: bigint; minExpiryMarginSeconds: bigint }
checkChain(pc, d): Promise<void>                     // chainId matches, else ArcError("wrong_chain")
verifyDeployment(pc, d): Promise<void>               // chain ID, hook immutables, core.paymentToken, whitelist; else ArcError("bad_manifest")
readJob(pc, d, jobId): Promise<Job>                  // ArcError("not_found") for an unknown ID (the core returns an all-zero struct)
readTerms(pc, d, jobId): Promise<Terms>              // zeros and frozen: false for a job the hook does not know; never throws for that
readSubmission(pc, d, jobId): Promise<Submission>    // zeros and submitted: false until a proof is accepted
readReleased(pc, d, jobId): Promise<boolean>
contextOf(pc, d, jobId): Promise<Uint8Array>         // hook.contextOf: the 169 bytes the hook itself builds
readExpectedJournal(pc, d, jobId, envelopeHash, keyCommitment): Promise<{ journal: Uint8Array; journalDigest: Hex }>
readHookConfig(pc, d): Promise<HookConfig>; readHookWhitelisted(pc, d): Promise<boolean>; readJobCount(pc, d): Promise<bigint>
readUsdc(pc, d, owner): Promise<{ balance: bigint; allowanceToCore: bigint }>   // 6-decimal units
latestTimestamp(pc): Promise<bigint>

// context and encoders (agree byte for byte with the SDK codec and with Nick's encoders; see test/unit/arc-pure.test.ts)
contextForJob(d, job: Job, terms: Terms): Uint8Array   // 169-byte funded context; escrow = d.core; ArcError("not_found") while !terms.frozen
fundOptParams(imageId, rulesHash, referenceHash): Hex
submitOptParams(envelope: Hex, seal: Hex, keyCommitment: Hex): Hex
releaseKeyMatches(context: Uint8Array, key: Hex, keyCommitment: Hex): boolean   // local check; the key is sent nowhere

// transaction requests (pure; no keys). Each is { to, data, value: 0n, chainId, label } ready for a wallet.
interface TxRequest { to: Address; data: Hex; value: 0n; chainId: number; label: "createJob"|"setBudget"|"approve"|"fund"|"submit"|"release"|"claimRefund" }
posterTxRequests(d, a: { provider: Address; expiredAt: bigint; description: string; budget: bigint; imageId: Hex; rulesHash: Hex; referenceHash: Hex; jobId?: bigint }):
  { createJob: TxRequest; setBudget(jobId?): TxRequest; approve: TxRequest; fund(jobId?): TxRequest }   // jobId defaults to a.jobId
fundTx(d, jobId, imageId, rulesHash, referenceHash): TxRequest
submitTx(d, jobId, envelope: Uint8Array, seal: Hex, keyCommitment: Hex): TxRequest   // to the core
releaseTx(d, jobId, key: Hex): TxRequest                                             // to the hook
claimRefundTx(d, jobId): TxRequest
jobIdFromCreateReceipt(d, receipt: { logs }): bigint  // from the core JobCreated log; ArcError("not_found") without one
submitGasLimit(calldataBytes, executionAllowance = 1_000_000n): bigint; calldataBytes(req): number

// preflights (eth_call; never with the real release key)
type PreflightResult = { ok: true } | { ok: false; reason: string; revertName?: string }
preflightFund(pc, d, { jobId, poster, imageId, rulesHash, referenceHash, budget? })
preflightSubmit(pc, d, { jobId, provider, envelope: Uint8Array, seal, keyCommitment, executionAllowance? })
preflightRelease(pc, d, { jobId, provider, dummyKey? = 32 zero bytes, marginSeconds? = 120 })   // ok means the dummy key reverted WrongKey
preflightRefund(pc, d, { jobId, caller? })
arcFees(pc): Promise<{ maxFeePerGas; maxPriorityFeePerGas }>

// events
type DecodedEvent = { name; args; address; blockNumber; transactionHash; logIndex }   // union over the 11 names; args typed per name
decodeSettlementLog(log, d): DecodedEvent | null     // core: JobCreated, BudgetSet, JobFunded, JobSubmitted, JobCompleted, PaymentReleased, Refunded, JobExpired; hook: TermsFrozen, ProofAccepted, KeyReleased
decodeSettlementLogs(logs, d): DecodedEvent[]
getSettlementEvents(pc, d, fromBlock, toBlock?): Promise<DecodedEvent[]>   // windows of <= 10,000 blocks; toBlock defaults to latest
blockWindows(from, to, maxWindow = 10_000n): Array<[bigint, bigint]>

// writes (Node or browser; caller supplies a WalletClient; the module never sees a key)
sendTx(pc, wallet, req: TxRequest, gas?: bigint | { gas?: bigint; receiptTimeoutMs?: number }): Promise<{ hash: Hex; receipt }>  // Arc fee floor, explicit gas, waits for the receipt, throws ArcError("reverted") with the decoded revert
const DEFAULT_RELEASE_GAS = 500_000n; const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000

class ArcError extends Error { code: "wrong_chain" | "reverted" | "bad_manifest" | "not_found" | "rpc" | "bad_input"; revertName?: string; txHash?: Hex }
decodeRevert(data): { revertName; args } | undefined; revertDataOf(err): Hex | undefined
```

## Deviations from the first draft of this contract

1. **`Terms` has three more fields**: `provider`, `budget`, `expiry`. `hook.terms(jobId)` returns them and the context needs the frozen `provider`. `frozen` is the ABI's `funded`; `Submission.submitted` is the ABI's `accepted`. The draft names are kept.
2. **`ArcError` has one more code, `bad_input`**, for arguments the contracts would revert on or that cannot be encoded (zero provider, zero budget, a hash that is not 32 bytes, an envelope above `maxEnvelopeBytes`, a bad address checksum, a wallet without an account). It also carries `txHash` when a mined transaction reverted.
3. **Preflights take one argument object** after `(pc, d)`; the draft left their arguments open. `preflightRelease` has no key parameter other than `dummyKey`, and throws `bad_input` if that key matches the accepted commitment.
4. **A preflight throws `ArcError("rpc")`** when the `eth_call` fails for a reason that is not an EVM execution failure (transport, rate limit after retries). It returns `ok: false` only for a revert, out of gas, or a failed local check. `revertName` is set only when the chain reverted with a decodable error.
5. **`preflightRelease` adds an expiry margin** (120 s by default) after the dummy-key call. A release that lands after expiry reverts and still publishes the key.
6. **`getSettlementEvents` takes `toBlock` as optional** (latest block). `DecodedEvent.args` is typed per event name rather than `Record<string, unknown>`.
7. **`setBudget` and `fund` take an optional `jobId`** that defaults to `a.jobId`; one of the two must be given.
8. **Added exports** not in the draft: `verifyDeployment`, `contextOf`, `readExpectedJournal`, `readHookConfig`, `readHookWhitelisted`, `readJobCount`, `readUsdc`, `releaseKeyMatches`, `fundTx`, `calldataBytes`, `decodeSettlementLogs`, `blockWindows`, `errorsAbi`, `decodeRevert`, `revertDataOf`, and the constants above. `erc20Abi` is viem's standard ERC-20 ABI.
9. **`nick-examples/fixture.test.ts` starts with `// @ts-nocheck`.** It is a `node:test` file that fails this package's `tsc` (`setAAD` overload under `@types/node` 22) and was failing `tsc -p tsconfig.json` as vendored. Nothing else in `nick-examples/` is changed.
10. **`sendTx`'s last argument** is a gas limit as drafted, or `{ gas?, receiptTimeoutMs? }`. A broadcast transaction with no receipt after 120 s throws `ArcError("rpc")` with `txHash`. For `release` (and for every request from a local account) it signs locally and sends raw, so the calldata reaches the RPC only inside the signed transaction.
11. **`deploymentFrom` also rejects** `network: "arc-testnet"` with a chain ID other than 5042002, a fee floor in the manifest above 20 gwei, a log range below 10,000, `hookWhitelisted: false`, and `usdc.decimals` other than 6.

## Facts confirmed on the live deployment (2026-11-15, read-only)

- The context's `escrow` is the **core proxy** `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`, not the hook: `hook.contextOf` equals `encodeContext` with `escrow = d.core`, and `hook.expectedJournal` equals `encodeJournal` and `journalDigest`.
- `core.getJob(unknownId)` returns an all-zero struct (id 0, status 0 = Open); it does not revert.
- Reverts for an unknown job: `submit`, `fund`, `claimRefund` give `InvalidJob` (core); `hook.release` gives `NotProvider`.
- The hook's immutables, the whitelist, the payment token and the verifier selector and version equal the manifest.
- `eth_getLogs` over 10,001 blocks is rejected ("requested range too large"); 10,000 is accepted.
