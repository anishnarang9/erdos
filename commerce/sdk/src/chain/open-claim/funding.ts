import { decodeEventLog, encodeFunctionData, isAddressEqual, zeroAddress } from "viem";
import type { Address } from "viem";
import { arcCoreAbi, arcErc20Abi } from "../arc/abi.ts";
import { OpenClaimError } from "./errors.ts";
import { approvalOf, assertEvidence, assertUnsigned, deploymentOf, observationMatches, sameHash } from "./guards.ts";
import type { NormalizedApproval, NormalizedDeployment } from "./guards.ts";
import { openClaimSignatureAbi } from "./signature-abi.ts";
import type {
  OpenClaimCompiledImage,
  OpenClaimFundingPlan,
  OpenClaimFundingProgress,
  OpenClaimFundingStep,
  OpenClaimPlanInput,
  OpenClaimPrepareInput,
  OpenClaimReceipt,
  OpenClaimSignableTransaction,
} from "./types.ts";

const STEPS = ["createJob", "setBudget", "approveUsdc", "fund", "register"] as const;

interface CheckedFunding {
  deployment: NormalizedDeployment;
  approval: NormalizedApproval;
  progress: OpenClaimFundingProgress;
}

function assertCompiled(approval: NormalizedApproval, compiled: OpenClaimCompiledImage): void {
  if (compiled.revision !== approval.revision) {
    throw new OpenClaimError("revision_mismatch", "compiled image revision does not match the approval");
  }
  if (!sameHash(compiled.imageId, approval.imageId) || !sameHash(compiled.rulesHash, approval.rulesHash) ||
      !sameHash(compiled.referenceHash, approval.referenceHash)) {
    throw new OpenClaimError("image_mismatch", "compiled image, rules, or reference does not match the approval");
  }
}

function checkFundingInput(input: OpenClaimPrepareInput | OpenClaimPlanInput): CheckedFunding {
  assertUnsigned(input);
  assertEvidence(input.evidence);
  const deployment = deploymentOf(input.deployment);
  observationMatches(deployment, input.observation);
  const approval = approvalOf(input.approval, input.now, deployment);
  return { deployment, approval, progress: input.progress ?? {} };
}

function laterActivity(progress: OpenClaimFundingProgress, index: number): boolean {
  for (let cursor = index + 1; cursor < STEPS.length; cursor++) {
    const step = STEPS[cursor];
    if (step !== undefined && (progress[step]?.state ?? "absent") !== "absent") return true;
  }
  return false;
}

function sign(transaction: OpenClaimSignableTransaction, jobId: bigint | undefined): OpenClaimFundingPlan {
  return jobId === undefined ? { status: "sign", transaction } : { status: "sign", transaction, jobId };
}

function awaitReceipt(step: OpenClaimFundingStep, receipt: Extract<OpenClaimReceipt, { state: "pending" | "uncertain" }>): OpenClaimFundingPlan {
  return receipt.transactionHash === undefined
    ? { status: "awaiting_receipt", step, resend: false }
    : { status: "awaiting_receipt", step, transactionHash: receipt.transactionHash, resend: false };
}

function jobIdFromCreate(
  receipt: Extract<OpenClaimReceipt, { state: "confirmed" }>,
  checked: CheckedFunding,
): bigint {
  const found: bigint[] = [];
  for (const log of receipt.logs ?? []) {
    if (!isAddressEqual(log.address, checked.deployment.core) || log.topics.length === 0) continue;
    const topic = log.topics[0];
    if (topic === undefined) continue;
    let decoded: { eventName: string; args?: unknown };
    try {
      decoded = decodeEventLog({
        abi: arcCoreAbi,
        data: log.data,
        topics: [topic, ...log.topics.slice(1)],
        strict: true,
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== "JobCreated" || decoded.args == null || typeof decoded.args !== "object") continue;
    const args = decoded.args as {
      jobId?: bigint;
      client?: Address;
      provider?: Address;
      evaluator?: Address;
      expiredAt?: bigint;
      hook?: Address;
    };
    if (typeof args.jobId !== "bigint" || args.jobId <= 0n || typeof args.expiredAt !== "bigint") continue;
    if (typeof args.client !== "string" || typeof args.provider !== "string" ||
        typeof args.evaluator !== "string" || typeof args.hook !== "string") continue;
    if (!isAddressEqual(args.client, checked.approval.buyer) ||
        !isAddressEqual(args.provider, checked.deployment.adapter) ||
        !isAddressEqual(args.evaluator, checked.deployment.adapter) ||
        !isAddressEqual(args.hook, zeroAddress) ||
        args.expiredAt !== checked.approval.expiry) {
      throw new OpenClaimError("rejected_receipt", "JobCreated does not match the approved open-claim terms");
    }
    found.push(args.jobId);
  }
  const jobId = found[0];
  if (found.length !== 1 || jobId === undefined) {
    throw new OpenClaimError("rejected_receipt", "confirmed createJob receipt must contain one JobCreated event");
  }
  return jobId;
}

function transactionFor(step: OpenClaimFundingStep, checked: CheckedFunding, jobId: bigint | undefined): OpenClaimSignableTransaction {
  const { deployment, approval } = checked;
  if (step === "createJob") {
    return {
      kind: step,
      to: deployment.core,
      value: 0n,
      description: "Create the open-claim job with the adapter as provider and evaluator and no hook.",
      data: encodeFunctionData({
        abi: arcCoreAbi,
        functionName: "createJob",
        args: [deployment.adapter, deployment.adapter, approval.expiry, approval.description, zeroAddress],
      }),
    };
  }
  if (jobId === undefined) throw new OpenClaimError("rejected_receipt", "job id is not confirmed");
  if (step === "setBudget") {
    return {
      kind: step,
      to: deployment.core,
      value: 0n,
      description: "Set the core budget to the exact approved amount.",
      data: encodeFunctionData({ abi: arcCoreAbi, functionName: "setBudget", args: [jobId, approval.budget, "0x"] }),
    };
  }
  if (step === "approveUsdc") {
    return {
      kind: step,
      to: deployment.usdc,
      value: 0n,
      description: "Approve the core for the exact bounty amount.",
      data: encodeFunctionData({ abi: arcErc20Abi, functionName: "approve", args: [deployment.core, approval.budget] }),
    };
  }
  if (step === "fund") {
    return {
      kind: step,
      to: deployment.core,
      value: 0n,
      description: "Fund the core job. This core takes no expected-budget argument.",
      data: encodeFunctionData({ abi: arcCoreAbi, functionName: "fund", args: [jobId, "0x"] }),
    };
  }
  return {
    kind: "register",
    to: deployment.adapter,
    value: 0n,
    description: "Register the approved image, rules, reference, budget, and expiry on the adapter.",
    data: encodeFunctionData({
      abi: openClaimSignatureAbi,
      functionName: "register",
      args: [jobId, approval.imageId, approval.rulesHash, approval.referenceHash, approval.budget, approval.expiry],
    }),
  };
}

function nextTransaction(checked: CheckedFunding): OpenClaimFundingPlan {
  const { progress } = checked;
  if (progress.jobId !== undefined && progress.createJob?.state !== "confirmed") {
    throw new OpenClaimError("inconsistent_progress", "job id requires a confirmed createJob receipt");
  }
  let jobId = progress.jobId;
  for (let index = 0; index < STEPS.length; index++) {
    const step = STEPS[index]!;
    const receipt = progress[step] ?? { state: "absent" as const };
    if (receipt.state !== "confirmed" && laterActivity(progress, index)) {
      throw new OpenClaimError("inconsistent_progress", "a later funding receipt is present without this confirmed receipt");
    }
    if (receipt.state === "absent") return sign(transactionFor(step, checked, jobId), jobId);
    if (receipt.state === "pending" || receipt.state === "uncertain") return awaitReceipt(step, receipt);
    if (receipt.state === "reverted") {
      return { status: "rejected_receipt", step, transactionHash: receipt.transactionHash, resend: false };
    }
    if (step === "createJob") {
      const found = jobIdFromCreate(receipt, checked);
      if (jobId !== undefined && jobId !== found) {
        throw new OpenClaimError("rejected_receipt", "supplied job id does not match JobCreated");
      }
      jobId = found;
    }
  }
  const register = progress.register;
  if (register?.state !== "confirmed" || jobId === undefined) {
    throw new OpenClaimError("inconsistent_progress", "registration is not confirmed");
  }
  return { status: "register_confirmed", jobId, registerTx: register.transactionHash };
}

/** Synchronous planner for a caller that already compiled and checked the image. */
export function planOpenClaimFunding(input: OpenClaimPlanInput): OpenClaimFundingPlan {
  const checked = checkFundingInput(input);
  assertCompiled(checked.approval, input.compiled);
  return nextTransaction(checked);
}

/** Buyer entry: reject bad pins and terms, compile the approved revision, then return at most one unsigned transaction. */
export async function prepareOpenClaimFunding(input: OpenClaimPrepareInput): Promise<OpenClaimFundingPlan> {
  const checked = checkFundingInput(input);
  const compiled = await input.compiler.compile(input.approval);
  assertCompiled(checked.approval, compiled);
  return nextTransaction(checked);
}
