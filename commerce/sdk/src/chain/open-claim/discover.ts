import { isAddressEqual, zeroAddress } from "viem";
import { JobStatus } from "../types.ts";
import { OpenClaimError } from "./errors.ts";
import { addressOf, assertEvidence, assertUnsigned, bytes32, deploymentOf, sameHash } from "./guards.ts";
import type { OpenClaimDiscoveryInput, PublishedOpenClaimJob } from "./types.ts";

/** Publish a job only after the register receipt is confirmed and the snapshot matches the approval. */
export function discoverOpenClaimJob(input: OpenClaimDiscoveryInput): PublishedOpenClaimJob {
  assertUnsigned(input);
  assertEvidence(input.evidence);
  const deployment = deploymentOf(input.deployment);
  const receipt = input.registerReceipt;
  if (receipt.state === "pending" || receipt.state === "uncertain") {
    throw new OpenClaimError("awaiting_receipt", "registration receipt is not confirmed; no resend");
  }
  if (receipt.state === "reverted") {
    throw new OpenClaimError("rejected_receipt", "registration reverted; no resend");
  }
  if (receipt.state !== "confirmed") throw new OpenClaimError("not_registered", "registration receipt is required");

  const job = input.snapshot.job;
  if (job === null || job.id !== input.jobId || job.status !== JobStatus.Funded || input.snapshot.released ||
      input.snapshot.submission?.accepted === true) {
    throw new OpenClaimError("not_funded", "open bounty discovery requires a funded job with no accepted claim");
  }
  const terms = input.snapshot.terms;
  if (terms === null || terms.registered !== true) {
    throw new OpenClaimError("not_registered", "adapter terms are not registered");
  }
  if (input.snapshot.evaluatorFeeBP !== 0n || input.snapshot.platformFeeBP !== 0n) {
    throw new OpenClaimError("unsupported_deployment", "core fees must be zero");
  }
  if (!isAddressEqual(input.snapshot.token, deployment.usdc) ||
      !isAddressEqual(input.snapshot.wiring.core, deployment.core) ||
      !isAddressEqual(input.snapshot.wiring.verifier, deployment.verifier) ||
      !isAddressEqual(input.snapshot.wiring.usdc, deployment.usdc)) {
    throw new OpenClaimError("wrong_deployment", "snapshot wiring does not match the deployment");
  }
  const buyer = addressOf(input.approval.buyer, "unsupported_terms", "buyer");
  if (!isAddressEqual(job.client, buyer) || !isAddressEqual(job.provider, deployment.adapter) ||
      !isAddressEqual(job.evaluator, deployment.adapter) || !isAddressEqual(job.hook, zeroAddress)) {
    throw new OpenClaimError("wrong_deployment", "core job roles do not match the open-claim deployment");
  }
  if (typeof input.now !== "bigint" || input.approval.expiry <= input.now) {
    throw new OpenClaimError("unsupported_terms", "the bounty is expired");
  }
  if (job.budget !== input.approval.budget || job.expiredAt !== input.approval.expiry ||
      job.description !== input.approval.description || !isAddressEqual(terms.buyer, buyer) ||
      terms.budget !== input.approval.budget || terms.expiry !== input.approval.expiry) {
    throw new OpenClaimError("unsupported_terms", "registered terms do not match the approval");
  }
  const imageId = bytes32(input.approval.imageId, "imageId");
  const rulesHash = bytes32(input.approval.rulesHash, "rulesHash");
  const referenceHash = bytes32(input.approval.referenceHash, "referenceHash");
  if (!sameHash(terms.imageId, imageId) || !sameHash(terms.rulesHash, rulesHash) || !sameHash(terms.referenceHash, referenceHash)) {
    throw new OpenClaimError("image_mismatch", "registered commitments do not match the approval");
  }
  return {
    mode: "open-claim",
    chainId: deployment.chainId,
    core: deployment.core,
    adapter: deployment.adapter,
    verifier: deployment.verifier,
    usdc: deployment.usdc,
    jobId: input.jobId,
    buyer,
    imageId,
    rulesHash,
    referenceHash,
    budget: input.approval.budget,
    expiry: input.approval.expiry,
    description: input.approval.description,
    funded: true,
    registered: true,
    registerTx: receipt.transactionHash,
  };
}
