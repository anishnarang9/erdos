// Write examples. Every function takes a viem WalletClient (with an account) from the caller; this
// package never builds a signer from a private key. Run the matching `preflight*` first.
//
// Arc drops any transaction whose maxFeePerGas is below 20 gwei without a receipt, so every write
// here sets maxFeePerGas to at least 20 gwei (`arcFees`).
import { parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { coreAbi, erc20Abi, settlementHookAbi } from "./abi.ts";
import { envelopeHash, fundOptParams, submitOptParams } from "./encode.ts";
import type { Deployment } from "./manifest.ts";
import { submitGasLimit } from "./preflight.ts";

export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n; // 20 gwei

/** Fee fields for an Arc transaction: never below the 20 gwei floor. */
export async function arcFees(client: PublicClient): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const est = await client.estimateFeesPerGas();
  const maxFeePerGas = est.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? est.maxFeePerGas : MIN_MAX_FEE_PER_GAS;
  const prio = est.maxPriorityFeePerGas ?? 0n;
  return { maxFeePerGas, maxPriorityFeePerGas: prio < maxFeePerGas ? prio : maxFeePerGas };
}

function accountOf(w: WalletClient) {
  if (!w.account) throw new Error("WalletClient has no account; create it with an account (json-rpc or local) in the caller");
  return w.account;
}

async function send(
  pub: PublicClient,
  wallet: WalletClient,
  req: { address: Address; abi: typeof coreAbi; functionName: string; args: readonly unknown[]; gas?: bigint },
): Promise<Hex> {
  const fees = await arcFees(pub);
  return wallet.writeContract({
    account: accountOf(wallet),
    chain: wallet.chain ?? null,
    address: req.address,
    abi: req.abi,
    functionName: req.functionName,
    args: req.args,
    ...(req.gas !== undefined ? { gas: req.gas } : {}),
    ...fees,
  });
}

/** Wait for a receipt and throw unless it succeeded. */
export async function confirm(pub: PublicClient, hash: Hex) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

// ───────────── Poster ─────────────

/** Poster tx 1: createJob(provider, evaluator = hook, expiredAt, description, hook = hook). Returns the job ID. */
export async function posterCreateJob(
  pub: PublicClient,
  poster: WalletClient,
  d: Deployment,
  a: { provider: Address; expiredAt: bigint; description: string },
): Promise<{ jobId: bigint; hash: Hex }> {
  const hash = await send(pub, poster, {
    address: d.core,
    abi: coreAbi,
    functionName: "createJob",
    args: [a.provider, d.hook, a.expiredAt, a.description, d.hook],
  });
  const receipt = await confirm(pub, hash);
  const [created] = parseEventLogs({ abi: coreAbi, eventName: "JobCreated", logs: receipt.logs });
  if (!created) throw new Error("JobCreated not found in receipt");
  return { jobId: (created.args as { jobId: bigint }).jobId, hash };
}

/** Poster tx 2: setBudget(jobId, amount, 0x). Client-only on our patched core. */
export async function posterSetBudget(pub: PublicClient, poster: WalletClient, d: Deployment, jobId: bigint, amount: bigint): Promise<Hex> {
  return send(pub, poster, { address: d.core, abi: coreAbi, functionName: "setBudget", args: [jobId, amount, "0x"] });
}

/** Poster tx 3: USDC approve(core, amount) for exactly the budget (6-decimal units). */
export async function posterApprove(pub: PublicClient, poster: WalletClient, d: Deployment, amount: bigint): Promise<Hex> {
  return send(pub, poster, { address: d.usdc, abi: erc20Abi as never, functionName: "approve", args: [d.core, amount] });
}

/** Poster tx 4: fund(jobId, abi.encode(imageId, rulesHash, referenceHash)). */
export async function posterFund(
  pub: PublicClient,
  poster: WalletClient,
  d: Deployment,
  a: { jobId: bigint; imageId: Hex; rulesHash: Hex; referenceHash: Hex },
): Promise<Hex> {
  return send(pub, poster, {
    address: d.core,
    abi: coreAbi,
    functionName: "fund",
    args: [a.jobId, fundOptParams(a.imageId, a.rulesHash, a.referenceHash)],
  });
}

// ───────────── Solver ─────────────

/** Solver: submit(jobId, sha256(envelope), abi.encode(envelope, seal, keyCommitment)) with an explicit gas limit. */
export async function solverSubmit(
  pub: PublicClient,
  solver: WalletClient,
  d: Deployment,
  a: { jobId: bigint; envelope: Hex; seal: Hex; keyCommitment: Hex; executionAllowance?: bigint },
): Promise<Hex> {
  const optParams = submitOptParams(a.envelope, a.seal, a.keyCommitment);
  const calldataBytes = 4 + 32 * 4 + (optParams.length - 2) / 2;
  return send(pub, solver, {
    address: d.core,
    abi: coreAbi,
    functionName: "submit",
    args: [a.jobId, envelopeHash(a.envelope), optParams],
    gas: submitGasLimit(calldataBytes, a.executionAllowance),
  });
}

/** Solver: hook.release(jobId, key). Publishes the key in calldata. */
export async function solverRelease(pub: PublicClient, solver: WalletClient, d: Deployment, jobId: bigint, key: Hex): Promise<Hex> {
  return send(pub, solver, { address: d.hook, abi: settlementHookAbi, functionName: "release", args: [jobId, key] });
}

// ───────────── Anyone ─────────────

/** claimRefund(jobId): permissionless once block.timestamp >= expiredAt. Refunds the Poster. */
export async function claimRefund(pub: PublicClient, anyone: WalletClient, d: Deployment, jobId: bigint): Promise<Hex> {
  return send(pub, anyone, { address: d.core, abi: coreAbi, functionName: "claimRefund", args: [jobId] });
}
