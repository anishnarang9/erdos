import type { Address, Hex } from "viem";
import type { BundleFile } from "@ubc26/sdk";
import type { EngineRunner } from "../engine.ts";
import type { SolveInput, Solver } from "../solvers/index.ts";
import type { OpenClaimDeploymentReport, OpenClaimDeploymentWitness } from "./deployment.ts";

export interface OpenClaimFundedJob {
  /** Explicit mode. Any other value is rejected and is not routed to selected-provider settlement. */
  mode: "open-claim";
  chainId: 5042002;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
  jobId: bigint;
  buyer: Address;
  /** Actual solver payout. This is context.provider, never the adapter. */
  solver: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  budget: bigint;
  expiry: bigint;
}

export interface OpenClaimWorkerApproval {
  revision: string;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  budget: bigint;
  expiry: bigint;
  chainId: 5042002;
  adapter: Address;
  jobId: bigint;
}

export interface OpenClaimSigner {
  account: Address;
  chainId: number;
  /** Real release-key RPC simulation is refused. Only an explicit true passes the gate. */
  noKeyRpcSimulation: boolean;
}

export type OpenClaimLogName = "ClaimAccepted" | "KeyReleased" | "JobSubmitted" | "PaymentReleased" | "Transfer" | "TermsRegistered";

export interface OpenClaimLog {
  address: Address;
  name: OpenClaimLogName;
  args: {
    jobId?: bigint;
    solver?: Address;
    provider?: Address;
    buyer?: Address;
    envelopeHash?: Hex;
    keyCommitment?: Hex;
    key?: Hex;
    amount?: bigint;
    from?: Address;
    to?: Address;
    value?: bigint;
  };
}

export interface OpenClaimChainReceipt {
  status: "success" | "reverted";
  logs: OpenClaimLog[];
}

export interface OpenClaimSnapshot {
  blockNumber: bigint;
  timestamp: bigint;
  job: {
    provider: Address;
    evaluator: Address;
    hook: Address;
    budget: bigint;
    expiredAt: bigint;
    status: "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";
  };
  terms: {
    buyer: Address;
    imageId: Hex;
    rulesHash: Hex;
    referenceHash: Hex;
    budget: bigint;
    expiry: bigint;
    registered: boolean;
  };
  submission: {
    solver: Address;
    envelopeHash: Hex;
    keyCommitment: Hex;
    accepted: boolean;
  } | null;
  released: boolean;
  /** contextOf(jobId, solver) for this attempt's solver. Escrow is the adapter. */
  context: Uint8Array;
  token: Address;
  platformFeeBP: bigint;
  evaluatorFeeBP: bigint;
}

/** Explicit adapter port. A memory fixture is not chain evidence and is not the unpublished JSON ABI. */
export interface OpenClaimAdapterPort {
  verifyDeployment(jobId: bigint): Promise<OpenClaimDeploymentReport>;
  snapshot(jobId: bigint): Promise<OpenClaimSnapshot>;
  signer(): OpenClaimSigner;
  broadcast(tx: OpenClaimRestrictedTx): Promise<Hex>;
  /** Null means the hash is still unknown. Throwing is also unresolved. Neither result may be retried as a new send. */
  receipt(hash: Hex): Promise<OpenClaimChainReceipt | null>;
}

export interface OpenClaimRestrictedTx {
  chainId: number;
  to: Address;
  from: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface OpenClaimRunOptions {
  job: OpenClaimFundedJob;
  approval: OpenClaimWorkerApproval;
  witness: OpenClaimDeploymentWitness;
  signer: OpenClaimSigner;
  port: OpenClaimAdapterPort;
  runner: EngineRunner;
  solver: Solver | ((input: SolveInput) => Promise<BundleFile[]>);
  packageDir: string;
  references: BundleFile[];
  attemptDir: string;
  proveBudgetSec: number;
  releaseMarginSec?: number;
  maxGas: bigint;
  maxFeePerGas: bigint;
  claimGas: bigint;
  releaseGas: bigint;
  maxPriorityFeePerGas?: bigint;
}

export const OPEN_CLAIM_PHASES = [
  "preparing",
  "proving",
  "proved",
  "rejected",
  "claim_broadcasting",
  "claim_sent",
  "claimed",
  "lost",
  "release_broadcasting",
  "release_sent",
  "released",
  "abandoned",
] as const;

export type OpenClaimPhase = typeof OPEN_CLAIM_PHASES[number];

export interface OpenClaimState {
  version: 1;
  mode: "open-claim";
  interfaceRevision: string;
  abiStatus: "exported-json";
  phase: OpenClaimPhase;
  jobId: string;
  binding: {
    chainId: number;
    core: string;
    adapter: string;
    verifier: string;
    usdc: string;
    solver: string;
    buyer: string;
    imageId: string;
    rulesHash: string;
    referenceHash: string;
    budget: string;
    expiry: string;
    revision: string;
  };
  context?: Hex;
  verdict?: 0 | 1;
  envelopeHash?: Hex;
  keyCommitment?: Hex;
  claimTx?: Hex;
  releaseTx?: Hex;
  winner?: string;
  paymentConfirmed: boolean;
  releaseDisclosure?: "potentially_public";
  abandonReason?: string;
  log: { at: string; event: string; detail?: string }[];
}
