// Transaction requests. Pure and browser-safe: no keys, no RPC. Each request is ready for a wallet.
import { bytesToHex, encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { envelopeHash } from "../../codec/crypto.ts";
import { coreAbi, erc20Abi, hookAbi } from "./abi.ts";
import type { Deployment } from "./deployment.ts";
import { fundOptParams, requireAddress, requireBytes, requireBytes32, requireUint, submitOptParams } from "./encode.ts";
import { ArcError } from "./errors.ts";

export type TxLabel = "createJob" | "setBudget" | "approve" | "fund" | "submit" | "release" | "claimRefund";

/** A transaction for a wallet to sign. `value` is always 0: USDC moves through the ERC-20 interface only. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: 0n;
  chainId: number;
  label: TxLabel;
}

export interface PosterArgs {
  /** The Solver. Must not be the zero address (the hook reverts ZeroProvider). */
  provider: Address;
  /**
   * Unix seconds. The core needs expiredAt > block.timestamp + coreMinExpirySeconds at createJob and
   * the hook needs expiredAt >= block.timestamp + minExpiryMarginSeconds when fund lands.
   */
  expiredAt: bigint;
  description: string;
  /** USDC in 6-decimal units; above zero. The approve is for exactly this amount. */
  budget: bigint;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  /** Known once createJob is mined (`jobIdFromCreateReceipt`). When set, setBudget() and fund() need no argument. */
  jobId?: bigint;
}

export interface PosterTxRequests {
  createJob: TxRequest;
  setBudget(jobId?: bigint): TxRequest;
  approve: TxRequest;
  fund(jobId?: bigint): TxRequest;
}

const request = (d: Deployment, to: Address, data: Hex, label: TxLabel): TxRequest => ({ to, data, value: 0n, chainId: d.chainId, label });

function requireJobId(jobId: bigint | undefined): bigint {
  if (jobId === undefined) throw new ArcError("bad_input", "jobId is required (read it from the createJob receipt)");
  return requireUint(jobId, "jobId", 1n);
}

/**
 * The Poster's four transactions, to be sent in this order, each after the previous one is mined:
 *
 * 1. `createJob`: core.createJob(provider, evaluator = hook, expiredAt, description, hook = hook)
 * 2. `setBudget(jobId)`: core.setBudget(jobId, budget, 0x). Only the client may call it.
 * 3. `approve`: usdc.approve(core, budget), for exactly the budget.
 * 4. `fund(jobId)`: core.fund(jobId, abi.encode(imageId, rulesHash, referenceHash)). The hook freezes the terms.
 */
export function posterTxRequests(d: Deployment, a: PosterArgs): PosterTxRequests {
  const provider = requireAddress(a.provider, "provider");
  const expiredAt = requireUint(a.expiredAt, "expiredAt", 1n);
  const budget = requireUint(a.budget, "budget", 1n);
  if (typeof a.description !== "string") throw new ArcError("bad_input", "description must be a string");
  fundOptParams(a.imageId, a.rulesHash, a.referenceHash); // validates the three hashes now, not at fund()
  if (a.jobId !== undefined) requireJobId(a.jobId);

  return {
    createJob: request(
      d,
      d.core,
      encodeFunctionData({ abi: coreAbi, functionName: "createJob", args: [provider, d.hook, expiredAt, a.description, d.hook] }),
      "createJob",
    ),
    setBudget: (jobId = a.jobId) =>
      request(d, d.core, encodeFunctionData({ abi: coreAbi, functionName: "setBudget", args: [requireJobId(jobId), budget, "0x"] }), "setBudget"),
    approve: request(d, d.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.core, budget] }), "approve"),
    fund: (jobId = a.jobId) => fundTx(d, requireJobId(jobId), a.imageId, a.rulesHash, a.referenceHash),
  };
}

/** Poster transaction 4 on its own: core.fund(jobId, abi.encode(imageId, rulesHash, referenceHash)). */
export function fundTx(d: Deployment, jobId: bigint, imageId: Hex, rulesHash: Hex, referenceHash: Hex): TxRequest {
  const optParams = fundOptParams(imageId, rulesHash, referenceHash);
  return request(d, d.core, encodeFunctionData({ abi: coreAbi, functionName: "fund", args: [requireJobId(jobId), optParams] }), "fund");
}

/**
 * The Solver's submit: core.submit(jobId, SHA256(envelope), abi.encode(envelope, seal, keyCommitment)).
 * It goes to the core, not the hook. Send it with an explicit gas limit (`submitGasLimit`; `sendTx`
 * does that), because a seal with broken proof bytes burns all the gas it is given.
 */
export function submitTx(d: Deployment, jobId: bigint, envelope: Uint8Array, seal: Hex, keyCommitment: Hex): TxRequest {
  if (!(envelope instanceof Uint8Array)) throw new ArcError("bad_input", "envelope must be a Uint8Array");
  if (envelope.length > d.maxEnvelopeBytes) {
    throw new ArcError("bad_input", `envelope is ${envelope.length} bytes, MAX_ENVELOPE_BYTES is ${d.maxEnvelopeBytes}`);
  }
  if (requireBytes(seal, "seal").length === 2) throw new ArcError("bad_input", "seal is empty");
  const optParams = submitOptParams(bytesToHex(envelope), seal, keyCommitment);
  return request(
    d,
    d.core,
    encodeFunctionData({ abi: coreAbi, functionName: "submit", args: [requireJobId(jobId), envelopeHash(envelope), optParams] }),
    "submit",
  );
}

/**
 * The Solver's release: hook.release(jobId, key). It goes to the hook, not the core. The key is
 * public in calldata as soon as the transaction is broadcast, so build this request only when you
 * are ready to send it, and never pass it to eth_call or eth_estimateGas (`sendTx` does not).
 */
export function releaseTx(d: Deployment, jobId: bigint, key: Hex): TxRequest {
  return request(
    d,
    d.hook,
    encodeFunctionData({ abi: hookAbi, functionName: "release", args: [requireJobId(jobId), requireBytes32(key, "key")] }),
    "release",
  );
}

/** core.claimRefund(jobId): anyone may send it once block.timestamp >= expiredAt, for a Funded or Submitted job. */
export function claimRefundTx(d: Deployment, jobId: bigint): TxRequest {
  return request(d, d.core, encodeFunctionData({ abi: coreAbi, functionName: "claimRefund", args: [requireJobId(jobId)] }), "claimRefund");
}

/** Default execution allowance on top of the calldata floor for `submit`. Also the most a bad seal can burn. */
export const SUBMIT_EXECUTION_ALLOWANCE = 1_000_000n;

/**
 * Gas limit for `submit`: Arc's calldata floor (21,000 + 40 per calldata byte, EIP-7623, counting
 * every byte as non-zero) plus an execution allowance. A valid submit executes in about 340,000 to
 * 390,000 gas with the real verifier (Nick's estimate, not yet measured on Arc).
 */
export function submitGasLimit(calldataBytes: number | bigint, executionAllowance: bigint = SUBMIT_EXECUTION_ALLOWANCE): bigint {
  const bytes = BigInt(calldataBytes);
  if (bytes < 0n || executionAllowance < 0n) throw new ArcError("bad_input", "calldataBytes and executionAllowance must not be negative");
  return 21_000n + 40n * bytes + executionAllowance;
}

/** Number of calldata bytes in a request (`data` is 0x hex). */
export function calldataBytes(req: Pick<TxRequest, "data">): number {
  return (req.data.length - 2) / 2;
}
