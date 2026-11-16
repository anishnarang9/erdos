import type { Address, Hex } from "viem";

export enum JobStatus {
  Open = 0,
  Funded = 1,
  Submitted = 2,
  Completed = 3,
  Rejected = 4,
  Expired = 5,
}

export interface ChainConfig {
  chainId: number;
  core: Address;
  hook: Address;
  usdc: Address;
  /** `release` refuses when latest.timestamp + releaseMarginSec >= expiredAt. Default 120. */
  releaseMarginSec?: number;
}

export interface JobView {
  client: Address;
  provider: Address;
  evaluator: Address;
  hook: Address;
  budget: bigint;
  expiredAt: bigint;
  status: JobStatus;
  description: string;
}

export interface FrozenTerms {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  provider: Address;
  budget: bigint;
  expiredAt: bigint;
}

/** error = decoded custom error name, or "unknown" */
export type PreflightResult = { ok: true } | { ok: false; error: string };

export interface DecodedEvent {
  name: string;
  contract: "core" | "hook" | "usdc";
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export interface WriteOptions {
  /** Explicit gas limit. Skips estimation, so a reverting tx is still mined. */
  gas?: bigint;
  /** Return the hash instead of throwing when the receipt status is `reverted`. */
  allowRevert?: boolean;
}

export interface SubmissionInput {
  jobId: bigint;
  envelope: Uint8Array | Hex;
  seal: Hex;
  keyCommitment: Hex;
}

export interface SubmittedEnvelope {
  jobId: bigint;
  envelopeHash: Hex;
  envelope: Uint8Array;
  seal: Hex;
  keyCommitment: Hex;
}
