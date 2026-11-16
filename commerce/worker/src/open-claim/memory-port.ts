// In-memory model of the published open-claim state machine.
// This is a local fixture. It is not a deployed adapter and it does not read a live chain.
import { decodeFunctionData, isAddressEqual, sha256, type Address, type Hex } from "viem";
import { encodeContext } from "@ubc26/sdk";
import { observedOpenClaimDeployment, type OpenClaimDeploymentReport, type OpenClaimDeploymentWitness } from "./deployment.ts";
import { OPEN_CLAIM_CLAIM_SELECTOR, OPEN_CLAIM_RELEASE_SELECTOR, openClaimClaimReleaseAbi } from "./fixture.ts";
import type {
  OpenClaimAdapterPort,
  OpenClaimChainReceipt,
  OpenClaimFundedJob,
  OpenClaimLog,
  OpenClaimRestrictedTx,
  OpenClaimSigner,
  OpenClaimSnapshot,
} from "./types.ts";

const abi = openClaimClaimReleaseAbi;

export interface OpenClaimMemoryControl {
  claimIdentity?: "self" | "other" | "core-event-only";
  otherSolver?: Address;
  existingWinner?: Address;
  receipt?: "ok" | "missing" | "throw";
  send?: "ok" | "throw-after-record";
  deployment?: Partial<OpenClaimDeploymentReport>;
}

export interface OpenClaimMemoryPort extends OpenClaimAdapterPort {
  broadcasts: OpenClaimRestrictedTx[];
  claims: number;
  releases: number;
}

interface Submission {
  solver: Address;
  envelopeHash: Hex;
  keyCommitment: Hex;
  accepted: true;
}

export function createOpenClaimMemoryPort(input: {
  job: OpenClaimFundedJob;
  witness: OpenClaimDeploymentWitness;
  signer: OpenClaimSigner;
  now: bigint;
  control?: OpenClaimMemoryControl;
}): OpenClaimMemoryPort {
  const control = input.control ?? {};
  const job = input.job;
  let submission: Submission | null = input.control?.existingWinner
    ? { solver: input.control.existingWinner, envelopeHash: `0x${"12".repeat(32)}` as Hex, keyCommitment: `0x${"13".repeat(32)}` as Hex, accepted: true }
    : null;
  let released = false;
  let status: OpenClaimSnapshot["job"]["status"] = submission ? "Submitted" : "Funded";
  const receipts = new Map<Hex, OpenClaimChainReceipt>();
  const pending = new Set<Hex>();
  const broadcasts: OpenClaimRestrictedTx[] = [];
  let claims = 0;
  let releases = 0;
  let sequence = 0;

  function context(): Uint8Array {
    return encodeContext({
      chainId: BigInt(job.chainId),
      escrow: job.adapter,
      jobId: job.jobId,
      provider: job.solver,
      rulesHash: job.rulesHash,
      referenceHash: job.referenceHash,
    });
  }

  function snapshot(): OpenClaimSnapshot {
    return {
      blockNumber: 1n,
      timestamp: input.now,
      job: {
        provider: job.adapter,
        evaluator: job.adapter,
        hook: "0x0000000000000000000000000000000000000000",
        budget: job.budget,
        expiredAt: job.expiry,
        status,
      },
      terms: {
        buyer: job.buyer,
        imageId: job.imageId,
        rulesHash: job.rulesHash,
        referenceHash: job.referenceHash,
        budget: job.budget,
        expiry: job.expiry,
        registered: true,
      },
      submission: submission ? { ...submission } : null,
      released,
      context: context(),
      token: job.usdc,
      platformFeeBP: 0n,
      evaluatorFeeBP: 0n,
    };
  }

  const port: OpenClaimMemoryPort = {
    broadcasts,
    get claims() { return claims; },
    get releases() { return releases; },
    async verifyDeployment(jobId) {
      if (jobId !== job.jobId) throw new Error("job mismatch");
      return observedOpenClaimDeployment(input.witness, control.deployment);
    },
    async snapshot(jobId) {
      if (jobId !== job.jobId) throw new Error("job mismatch");
      return snapshot();
    },
    signer() { return input.signer; },
    async broadcast(tx) {
      if (tx.value !== 0n || tx.chainId !== job.chainId) throw new Error("restricted transaction");
      if (!isAddressEqual(tx.to, job.adapter) || !isAddressEqual(tx.from, job.solver)) throw new Error("restricted transaction");
      const selector = tx.data.slice(0, 10).toLowerCase();
      if (selector !== OPEN_CLAIM_CLAIM_SELECTOR && selector !== OPEN_CLAIM_RELEASE_SELECTOR) throw new Error("restricted transaction");
      if (tx.gas <= 0n) throw new Error("restricted transaction");
      broadcasts.push(tx);
      if (selector === OPEN_CLAIM_CLAIM_SELECTOR) claims += 1;
      else releases += 1;
      if (control.send === "throw-after-record") throw new Error("send failed");
      sequence += 1;
      const prefix = selector === OPEN_CLAIM_CLAIM_SELECTOR ? "aa" : "bb";
      const hash = `0x${prefix}${"11".repeat(30)}${sequence.toString(16).padStart(2, "0")}` as Hex;
      if (control.receipt === "missing" || control.receipt === "throw") {
        pending.add(hash);
        return hash;
      }
      receipts.set(hash, receiptFor(tx, selector));
      return hash;
    },
    async receipt(hash) {
      if (control.receipt === "throw") throw new Error("receipt rpc failed");
      if (pending.has(hash)) return null;
      return receipts.get(hash) ?? null;
    },
  };
  return port;

  function receiptFor(tx: OpenClaimRestrictedTx, selector: string): OpenClaimChainReceipt {
    const decoded = decodeFunctionData({ abi, data: tx.data });
    if (decoded.functionName === "claim" && selector === OPEN_CLAIM_CLAIM_SELECTOR) {
      const [jobId, envelope, , commitment] = decoded.args;
      const envelopeHash = sha256(envelope);
      if (control.claimIdentity === "other") {
        const solver = control.otherSolver ?? job.buyer;
        submission = { solver, envelopeHash: `0x${"12".repeat(32)}` as Hex, keyCommitment: `0x${"13".repeat(32)}` as Hex, accepted: true };
        status = "Submitted";
        return { status: "success", logs: [claimEvent(jobId, solver, submission.envelopeHash, submission.keyCommitment), coreEvent("JobSubmitted", jobId), coreEvent("PaymentReleased", jobId)] };
      }
      if (control.claimIdentity === "core-event-only") {
        return { status: "success", logs: [coreEvent("JobSubmitted", jobId), coreEvent("PaymentReleased", jobId)] };
      }
      submission = { solver: job.solver, envelopeHash, keyCommitment: commitment, accepted: true };
      status = "Submitted";
      return { status: "success", logs: [claimEvent(jobId, job.solver, envelopeHash, commitment), coreEvent("JobSubmitted", jobId)] };
    }
    const [jobId, key] = decoded.functionName === "release" ? decoded.args : [job.jobId, "0x" as Hex];
    released = true;
    status = "Completed";
    const envelopeHash = submission?.envelopeHash ?? `0x${"00".repeat(32)}` as Hex;
    const logs: OpenClaimLog[] = [
      { address: job.adapter, name: "KeyReleased", args: { jobId, solver: job.solver, key, envelopeHash, amount: job.budget } },
      { address: job.usdc, name: "Transfer", args: { from: job.adapter, to: job.solver, value: job.budget } },
      { address: job.core, name: "PaymentReleased", args: { jobId, provider: job.adapter, amount: job.budget } },
    ];
    return { status: "success", logs };
  }

  function claimEvent(jobId: bigint, solver: Address, envelopeHash: Hex, keyCommitment: Hex): OpenClaimLog {
    return { address: job.adapter, name: "ClaimAccepted", args: { jobId, solver, envelopeHash, keyCommitment } };
  }

  function coreEvent(name: "JobSubmitted" | "PaymentReleased", jobId: bigint): OpenClaimLog {
    return { address: job.core, name, args: { jobId, provider: job.adapter, amount: job.budget } };
  }
}
