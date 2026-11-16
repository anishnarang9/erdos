import { decodeEventLog, encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, zeroHash } from "viem";
import type { Address, Hex } from "viem";
import { arcErc20Abi } from "../arc/abi.ts";
import { arcCoreAbi } from "../arc/abi.ts";
import { OpenClaimError } from "./errors.ts";
import { OPEN_CLAIM_MAX_ENVELOPE_BYTES, OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC, openClaimSignatureAbi } from "./signature-abi.ts";
import type {
  OpenClaimApproval,
  OpenClaimCompiledImage,
  OpenClaimDeployment,
  OpenClaimFundingPlan,
  OpenClaimFundingProgress,
  OpenClaimFundingStep,
  OpenClaimObservation,
  OpenClaimPlanInput,
  OpenClaimPrepareInput,
  OpenClaimReceipt,
  OpenClaimSignableTransaction,
} from "./types.ts";

const STEPS = ["createJob", "setBudget", "approveUsdc", "fund", "register"] as const;
const SIGNER_KEYS = ["wallet", "privateKey", "account", "sign", "broadcast", "signer"] as const;
const U64 = 1n << 64n;
const U256 = 1n << 256n;

interface NormalizedDeployment {
  chainId: number;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
}

interface NormalizedApproval extends OpenClaimApproval {
  buyer: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
}

interface CheckedFunding {
  deployment: NormalizedDeployment;
  approval: NormalizedApproval;
  progress: OpenClaimFundingProgress;
}

function assertUnsigned(input: object): void {
  const record = input as Record<string, unknown>;
  for (const key of SIGNER_KEYS) {
    if (record[key] != null) {
      throw new OpenClaimError("unsafe_signer", "open-claim funding returns unsigned transactions and does not sign");
    }
  }
}

function assertEvidence(evidence: string): void {
  if (evidence !== "signature-fixture") {
    throw new OpenClaimError("abi_unpublished", "OpenClaimAdapter JSON ABI is unpublished; refusing signable transactions");
  }
}

function addressOf(value: string, code: "unsupported_deployment" | "unsupported_terms", field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new OpenClaimError(code, `${field} is not an address`);
  }
  const out = getAddress(value);
  if (out === zeroAddress) throw new OpenClaimError(code, `${field} is the zero address`);
  return out;
}

function bytes32(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new OpenClaimError("unsupported_terms", `${field} must be 32 bytes`);
  }
  const lower = value.toLowerCase() as Hex;
  if (lower === zeroHash) throw new OpenClaimError("unsupported_terms", `${field} must be nonzero`);
  return lower;
}

function deploymentOf(input: OpenClaimDeployment): NormalizedDeployment {
  if (input.mode !== "open-claim") {
    throw new OpenClaimError("unsupported_deployment", "open-claim requires explicit mode open-claim");
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new OpenClaimError("unsupported_deployment", "chain id is unsupported");
  }
  const core = addressOf(input.core, "unsupported_deployment", "core");
  const adapter = addressOf(input.adapter, "unsupported_deployment", "adapter");
  const verifier = addressOf(input.verifier, "unsupported_deployment", "verifier");
  const usdc = addressOf(input.usdc, "unsupported_deployment", "usdc");
  const pins = [core, adapter, verifier, usdc];
  if (new Set(pins.map((pin) => pin.toLowerCase())).size !== pins.length) {
    throw new OpenClaimError("unsupported_deployment", "core, adapter, verifier, and usdc must be distinct");
  }
  return { chainId: input.chainId, core, adapter, verifier, usdc };
}

function observationMatches(deployment: NormalizedDeployment, observation: OpenClaimObservation | undefined): void {
  if (observation == null) throw new OpenClaimError("unsupported_deployment", "deployment observation is required");
  if (observation.chainId !== deployment.chainId) {
    throw new OpenClaimError("unsupported_deployment", "observed chain id does not match the deployment");
  }
  if (observation.adapterCode !== "present") {
    throw new OpenClaimError("unsupported_deployment", "adapter code was not observed");
  }
  if (observation.evaluatorFeeBP !== 0n || observation.platformFeeBP !== 0n) {
    throw new OpenClaimError("unsupported_deployment", "core fees must be zero");
  }
  if (observation.maxEnvelopeBytes !== BigInt(OPEN_CLAIM_MAX_ENVELOPE_BYTES)) {
    throw new OpenClaimError("unsupported_deployment", "adapter envelope cap does not match the published checkpoint");
  }
  if (observation.minExpiryMargin !== BigInt(OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC)) {
    throw new OpenClaimError("unsupported_deployment", "adapter expiry margin does not match the published checkpoint");
  }
  const token = addressOf(observation.token, "unsupported_deployment", "token");
  const adapterCore = addressOf(observation.adapterCore, "unsupported_deployment", "adapter core");
  const adapterVerifier = addressOf(observation.adapterVerifier, "unsupported_deployment", "adapter verifier");
  const adapterUsdc = addressOf(observation.adapterUsdc, "unsupported_deployment", "adapter usdc");
  if (!isAddressEqual(token, deployment.usdc) || !isAddressEqual(adapterCore, deployment.core) ||
      !isAddressEqual(adapterVerifier, deployment.verifier) || !isAddressEqual(adapterUsdc, deployment.usdc)) {
    throw new OpenClaimError("unsupported_deployment", "observed wiring does not match the deployment pins");
  }
}

function approvalOf(input: OpenClaimApproval, now: bigint, deployment: NormalizedDeployment): NormalizedApproval {
  if (typeof input.revision !== "string" || input.revision.length === 0) {
    throw new OpenClaimError("unsupported_terms", "approval revision is required");
  }
  if (typeof input.description !== "string" || input.description.length === 0) {
    throw new OpenClaimError("unsupported_terms", "job description is required");
  }
  if (typeof now !== "bigint" || typeof input.budget !== "bigint" || typeof input.expiry !== "bigint") {
    throw new OpenClaimError("unsupported_terms", "budget, expiry, and time must be bigints");
  }
  if (input.budget <= 0n || input.budget >= U256) throw new OpenClaimError("unsupported_terms", "budget is unsupported");
  if (input.expiry < 0n || input.expiry >= U64) throw new OpenClaimError("unsupported_terms", "expiry must fit uint64");
  if (input.expiry < now + BigInt(OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC)) {
    throw new OpenClaimError("unsupported_terms", "expiry does not leave the 600 second margin");
  }
  const buyer = addressOf(input.buyer, "unsupported_terms", "buyer");
  if ([deployment.core, deployment.adapter, deployment.verifier, deployment.usdc].some((pin) => isAddressEqual(pin, buyer))) {
    throw new OpenClaimError("unsupported_terms", "buyer must be distinct from the deployment pins");
  }
  return {
    revision: input.revision,
    buyer,
    imageId: bytes32(input.imageId, "imageId"),
    rulesHash: bytes32(input.rulesHash, "rulesHash"),
    referenceHash: bytes32(input.referenceHash, "referenceHash"),
    budget: input.budget,
    expiry: input.expiry,
    description: input.description,
  };
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
