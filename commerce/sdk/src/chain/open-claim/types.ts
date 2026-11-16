import type { Address, Hex } from "viem";

export interface OpenClaimDeployment {
  /** Explicit mode. Any other value is rejected and is not routed to the selected-provider adapter. */
  mode: "open-claim";
  chainId: number;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
}

export interface OpenClaimApproval {
  revision: string;
  buyer: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  budget: bigint;
  /** Unix seconds. Must fit uint64 and leave the published 600 second margin. */
  expiry: bigint;
  description: string;
}

export interface OpenClaimCompiledImage {
  revision: string;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
}

export interface OpenClaimImageCompiler {
  compile(approval: OpenClaimApproval): Promise<OpenClaimCompiledImage>;
}

/** Caller-observed deployment facts. This module does not invent adapter addresses or bytecode pins. */
export interface OpenClaimObservation {
  chainId: number;
  token: Address;
  evaluatorFeeBP: bigint;
  platformFeeBP: bigint;
  adapterCode: "present" | "absent";
  adapterCore: Address;
  adapterVerifier: Address;
  adapterUsdc: Address;
  maxEnvelopeBytes: bigint;
  minExpiryMargin: bigint;
}

export interface OpenClaimLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export type OpenClaimReceipt =
  | { state: "absent" }
  | { state: "pending"; transactionHash: Hex }
  | { state: "uncertain"; transactionHash?: Hex; reason: string }
  | { state: "reverted"; transactionHash: Hex }
  | { state: "confirmed"; transactionHash: Hex; logs?: readonly OpenClaimLog[] };

export type OpenClaimFundingStep = "createJob" | "setBudget" | "approveUsdc" | "fund" | "register";

export interface OpenClaimFundingProgress {
  createJob?: OpenClaimReceipt;
  setBudget?: OpenClaimReceipt;
  approveUsdc?: OpenClaimReceipt;
  fund?: OpenClaimReceipt;
  register?: OpenClaimReceipt;
  /** Accepted only together with a confirmed createJob receipt. */
  jobId?: bigint;
}

export interface OpenClaimSignableTransaction {
  kind: OpenClaimFundingStep | "claim" | "release";
  to: Address;
  data: Hex;
  value: 0n;
  description: string;
}

/** `resend` is always false. A pending or uncertain receipt never produces a replacement transaction. */
export type OpenClaimFundingPlan =
  | { status: "sign"; transaction: OpenClaimSignableTransaction; jobId?: bigint }
  | { status: "awaiting_receipt"; step: OpenClaimFundingStep; transactionHash?: Hex; resend: false }
  | { status: "rejected_receipt"; step: OpenClaimFundingStep; transactionHash: Hex; resend: false }
  | { status: "register_confirmed"; jobId: bigint; registerTx: Hex };

export interface OpenClaimPrepareInput {
  deployment: OpenClaimDeployment;
  approval: OpenClaimApproval;
  compiler: OpenClaimImageCompiler;
  /** The JSON ABI is unpublished. Only the signature fixture may prepare calldata. */
  evidence: "signature-fixture";
  now: bigint;
  observation: OpenClaimObservation;
  progress?: OpenClaimFundingProgress;
}

export interface OpenClaimPlanInput extends Omit<OpenClaimPrepareInput, "compiler"> {
  compiled: OpenClaimCompiledImage;
}
