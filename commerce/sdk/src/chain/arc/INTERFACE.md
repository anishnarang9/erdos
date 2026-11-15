# `@ubc26/sdk` Arc settlement module: interface contract

Source of truth: Nick's settlement (`nick-settlement` @ `80c8a4a`): `agents/current plan/SETTLEMENT-IMPLEMENTATION.md`, `contracts/examples/README.md`, and the ABIs and manifest copied here (`abi/`, `arc-testnet.json`). `nick-examples/` is Nick's code, copied unchanged for reference; the module below is ours.

Exported from `@ubc26/sdk` as `arc` (`import { arc } from "@ubc26/sdk"`). Browser-safe except where noted. viem 2.57.19.

```ts
// deployment
interface Deployment { chainId: number; rpcUrl: string; usdc: Address; core: Address; hook: Address; verifier: Address;
  minExpiryMarginSeconds: number; coreMinExpirySeconds: number; maxEnvelopeBytes: number; deployBlock: bigint /* min of core and hook */ }
const ARC_TESTNET: Deployment                      // from arc-testnet.json, checked at load (no nulls, checksummed)
function deploymentFrom(manifestJson: unknown): Deployment
const coreAbi, hookAbi, verifierAbi, erc20Abi

// reads (PublicClient)
const JOB_STATUS = ["Open","Funded","Submitted","Completed","Rejected","Expired"] as const
interface Job { id: bigint; client: Address; provider: Address; evaluator: Address; description: string; budget: bigint; expiredAt: bigint; status: JobStatusName; hook: Address }
interface Terms { imageId: Hex; rulesHash: Hex; referenceHash: Hex; frozen: boolean }   // whatever hook.terms returns, normalized
interface Submission { envelopeHash: Hex; keyCommitment: Hex; submitted: boolean }      // hook.submissions
checkChain(pc, d): Promise<void>                     // chainId matches, else ArcError("wrong_chain")
readJob(pc, d, jobId): Promise<Job>; readTerms(...); readSubmission(...); readReleased(...): Promise<boolean>
latestTimestamp(pc): Promise<bigint>

// context and encoders (must agree byte for byte with the SDK codec: encodeContext, encodeJournal, keyCommitment)
contextForJob(d, job: Job, terms: Terms): Uint8Array   // 169-byte funded context from confirmed chain state
fundOptParams(imageId, rulesHash, referenceHash): Hex
submitOptParams(envelope: Hex, seal: Hex, keyCommitment: Hex): Hex

// transaction requests (pure; no keys). Each is { to, data, value: 0n, chainId } ready for a wallet.
interface TxRequest { to: Address; data: Hex; value: 0n; chainId: number; label: "createJob"|"setBudget"|"approve"|"fund"|"submit"|"release"|"claimRefund" }
posterTxRequests(d, a: { provider: Address; expiredAt: bigint; description: string; budget: bigint; imageId: Hex; rulesHash: Hex; referenceHash: Hex; jobId?: bigint }):
  { createJob: TxRequest; setBudget(jobId): TxRequest; approve: TxRequest; fund(jobId): TxRequest }
submitTx(d, jobId, envelope: Uint8Array, seal: Hex, keyCommitment: Hex): TxRequest
releaseTx(d, jobId, key: Hex): TxRequest
claimRefundTx(d, jobId): TxRequest
jobIdFromCreateReceipt(d, receipt): bigint           // from the core JobCreated log

// preflights (eth_call; never with the real release key)
preflightFund / preflightSubmit / preflightRelease(dummy key) / preflightRefund -> { ok: true } | { ok: false; reason: string; revertName?: string }
submitGasLimit(calldataBytes): bigint; arcFees(pc): Promise<{ maxFeePerGas; maxPriorityFeePerGas }>

// events
decodeSettlementLog(log, d): DecodedEvent | null     // core: JobCreated, BudgetSet, JobFunded, JobSubmitted, JobCompleted, PaymentReleased, Refunded, JobExpired; hook: TermsFrozen, ProofAccepted, KeyReleased
getSettlementEvents(pc, d, fromBlock, toBlock): Promise<DecodedEvent[]>   // windows of <= 10,000 blocks

// writes (Node or browser; caller supplies a WalletClient; the module never sees a key)
sendTx(pc, wallet, req: TxRequest, gas?: bigint): Promise<{ hash: Hex; receipt }>  // Arc fee floor, explicit gas, waits for the receipt, throws ArcError("reverted") with the decoded revert

class ArcError extends Error { code: "wrong_chain" | "reverted" | "bad_manifest" | "not_found" | "rpc" ; revertName?: string }
```
