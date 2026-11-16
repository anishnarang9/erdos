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
  /** The exported contract ABI must match the reviewed adapter source. */
  evidence: "exported-abi";
  now: bigint;
  observation: OpenClaimObservation;
  progress?: OpenClaimFundingProgress;
}

export interface OpenClaimPlanInput extends Omit<OpenClaimPrepareInput, "compiler"> {
  compiled: OpenClaimCompiledImage;
}

export interface OpenClaimChainSnapshot {
  /** Every field in this snapshot was read at this block. */
  blockNumber?: bigint;
  job: {
    id: bigint;
    client: Address;
    provider: Address;
    evaluator: Address;
    hook: Address;
    budget: bigint;
    expiredAt: bigint;
    status: number;
    description: string;
  } | null;
  terms: {
    buyer: Address;
    imageId: Hex;
    rulesHash: Hex;
    referenceHash: Hex;
    budget: bigint;
    expiry: bigint;
    registered: boolean;
  } | null;
  submission: {
    solver: Address;
    envelopeHash: Hex;
    keyCommitment: Hex;
    accepted: boolean;
  } | null;
  released: boolean;
  token: Address;
  evaluatorFeeBP: bigint;
  platformFeeBP: bigint;
  wiring: { core: Address; verifier: Address; usdc: Address };
}

/** Read-only chain boundary for deployment checks and funded job snapshots. */
export interface OpenClaimChainPort {
  observe(deployment: OpenClaimDeployment): Promise<OpenClaimObservation>;
  snapshot(deployment: OpenClaimDeployment, jobId: bigint): Promise<OpenClaimChainSnapshot>;
}

export interface OpenClaimDiscoveryInput {
  deployment: OpenClaimDeployment;
  approval: OpenClaimApproval;
  evidence: "exported-abi";
  now: bigint;
  jobId: bigint;
  registerReceipt: OpenClaimReceipt;
  snapshot: OpenClaimChainSnapshot;
}

export interface PublishedOpenClaimJob {
  mode: "open-claim";
  chainId: number;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
  jobId: bigint;
  buyer: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  budget: bigint;
  expiry: bigint;
  description: string;
  funded: true;
  registered: true;
  registerTx: Hex;
}

export interface OpenClaimCandidate {
  solver: Address;
  caller: Address;
  envelope: Uint8Array;
  seal: Hex;
  keyCommitment: Hex;
  imageId: Hex;
  context: {
    chainId: bigint;
    escrow: Address;
    jobId: bigint;
    provider: Address;
    rulesHash: Hex;
    referenceHash: Hex;
  };
  verdict: 0 | 1;
  journal: Uint8Array;
}

export interface VerifiedOpenClaim {
  solver: Address;
  jobId: bigint;
  envelope: Uint8Array;
  envelopeHash: Hex;
  keyCommitment: Hex;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  contextBytes: Uint8Array;
  journalDigest: Hex;
  seal: Hex;
}

export interface OpenClaimClaimJudgment {
  winner: VerifiedOpenClaim;
  losers: readonly VerifiedOpenClaim[];
}

export interface OpenClaimAcceptedClaim {
  solver: Address;
  envelopeHash: Hex;
  keyCommitment: Hex;
}

export interface OpenClaimReleaseEvidence {
  jobId: bigint;
  solver: Address;
  caller: Address;
  payout: Address;
  amount: bigint;
  ciphertextDigest: Hex;
  keyCommitment: Hex;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  released: boolean;
  coreStatus: number;
}
