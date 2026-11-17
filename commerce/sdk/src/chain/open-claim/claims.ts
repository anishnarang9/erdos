import { bytesToHex, encodeFunctionData, isAddressEqual } from "viem";
import type { Address, Hex } from "viem";
import { decryptEnvelope, keyCommitment } from "../../codec/crypto.ts";
import { encodeContext } from "../../codec/context.ts";
import { CodecError } from "../../codec/errors.ts";
import { parseProofJson } from "../../codec/proof.ts";
import { JobStatus } from "../types.ts";
import { OpenClaimError } from "./errors.ts";
import { addressOf, assertEvidence, bytes32, deploymentOf, sameHash } from "./guards.ts";
import type { NormalizedDeployment } from "./guards.ts";
import { OPEN_CLAIM_MAX_ENVELOPE_BYTES, OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC, openClaimSignatureAbi } from "./signature-abi.ts";
import type {
  OpenClaimAcceptedClaim,
  OpenClaimCandidate,
  OpenClaimClaimJudgment,
  OpenClaimDeployment,
  OpenClaimReleaseEvidence,
  OpenClaimSignableTransaction,
  PublishedOpenClaimJob,
  VerifiedOpenClaim,
} from "./types.ts";

function assertPublished(deployment: NormalizedDeployment, published: PublishedOpenClaimJob): void {
  if (published.mode !== "open-claim" || published.funded !== true || published.registered !== true ||
      published.chainId !== deployment.chainId || !isAddressEqual(published.core, deployment.core) ||
      !isAddressEqual(published.adapter, deployment.adapter) || !isAddressEqual(published.verifier, deployment.verifier) ||
      !isAddressEqual(published.usdc, deployment.usdc)) {
    throw new OpenClaimError("wrong_deployment", "published job does not match the open-claim deployment");
  }
}

function commitmentOf(context: Uint8Array, key: Uint8Array): Hex {
  try {
    return keyCommitment(context, key);
  } catch {
    throw new OpenClaimError("wrong_key", "release key does not match the winning commitment");
  }
}

/** Check one candidate. The context provider must be that solver, and the escrow must be the adapter. */
export function verifyOpenClaimCandidate(input: {
  deployment: OpenClaimDeployment;
  published: PublishedOpenClaimJob;
  candidate: OpenClaimCandidate;
}): VerifiedOpenClaim {
  const deployment = deploymentOf(input.deployment);
  assertPublished(deployment, input.published);
  const solver = addressOf(input.candidate.solver, "wrong_caller", "solver");
  const caller = addressOf(input.candidate.caller, "wrong_caller", "caller");
  if (!isAddressEqual(caller, solver)) {
    throw new OpenClaimError("wrong_caller", "the claim caller must be the solver");
  }
  if (isAddressEqual(solver, deployment.adapter) || isAddressEqual(solver, deployment.core)) {
    throw new OpenClaimError("wrong_context", "the solver cannot be the adapter or the core");
  }
  if (!isAddressEqual(input.candidate.context.provider, solver) || isAddressEqual(input.candidate.context.provider, deployment.adapter)) {
    throw new OpenClaimError("wrong_context", "the proof provider must be the claiming solver");
  }
  if (!isAddressEqual(input.candidate.context.escrow, deployment.adapter) || isAddressEqual(input.candidate.context.escrow, deployment.core)) {
    throw new OpenClaimError("wrong_context", "the proof escrow must be the adapter");
  }
  if (input.candidate.context.chainId !== BigInt(deployment.chainId) || input.candidate.context.jobId !== input.published.jobId) {
    throw new OpenClaimError("wrong_context", "the proof context does not match the published job");
  }
  if (input.candidate.verdict !== 1) throw new OpenClaimError("wrong_context", "open-claim requires a verdict 1 receipt");
  if (!(input.candidate.envelope instanceof Uint8Array) || input.candidate.envelope.length > OPEN_CLAIM_MAX_ENVELOPE_BYTES) {
    throw new OpenClaimError("unsupported_terms", "envelope exceeds the published cap");
  }
  const imageId = bytes32(input.candidate.imageId, "imageId");
  if (!sameHash(imageId, input.published.imageId) ||
      !sameHash(input.candidate.context.rulesHash, input.published.rulesHash) ||
      !sameHash(input.candidate.context.referenceHash, input.published.referenceHash)) {
    throw new OpenClaimError("image_mismatch", "candidate commitments do not match the published job");
  }
  const contextBytes = encodeContext(input.candidate.context);
  const proof = parseProofJson({
    version: 1,
    context: bytesToHex(contextBytes),
    imageId,
    verdict: input.candidate.verdict,
    envelope: bytesToHex(input.candidate.envelope),
    keyCommitment: input.candidate.keyCommitment,
    journal: bytesToHex(input.candidate.journal),
    seal: input.candidate.seal,
  });
  if (!isAddressEqual(proof.context.provider, solver) || !isAddressEqual(proof.context.escrow, deployment.adapter)) {
    throw new OpenClaimError("wrong_context", "parsed proof context does not bind the solver and adapter");
  }
  return {
    solver,
    jobId: input.published.jobId,
    envelope: proof.envelope,
    envelopeHash: proof.envelopeHash,
    keyCommitment: proof.keyCommitment,
    imageId: proof.imageId,
    rulesHash: proof.context.rulesHash,
    referenceHash: proof.context.referenceHash,
    contextBytes: proof.contextBytes,
    journalDigest: proof.journalDigest,
    seal: proof.seal,
  };
}

/** The first verified candidate wins until a chain-accepted claim reserves the bounty. */
export function judgeOpenClaimClaims(input: {
  deployment: OpenClaimDeployment;
  published: PublishedOpenClaimJob;
  candidates: readonly OpenClaimCandidate[];
  accepted?: OpenClaimAcceptedClaim | null;
}): OpenClaimClaimJudgment {
  if (input.candidates.length === 0) throw new OpenClaimError("unsupported_terms", "at least one candidate is required");
  const verified: VerifiedOpenClaim[] = [];
  let firstInvalid: OpenClaimError | undefined;
  for (const candidate of input.candidates) {
    try {
      verified.push(verifyOpenClaimCandidate({
        deployment: input.deployment,
        published: input.published,
        candidate,
      }));
    } catch (error) {
      if (!(error instanceof OpenClaimError)) throw error;
      firstInvalid ??= error;
    }
  }
  if (verified.length === 0 && firstInvalid) throw firstInvalid;
  let winner = verified[0];
  if (winner === undefined) throw new OpenClaimError("unsupported_terms", "at least one candidate is required");
  if (input.accepted != null) {
    const accepted = input.accepted;
    const match = verified.find((item) => isAddressEqual(item.solver, accepted.solver) &&
      sameHash(item.envelopeHash, accepted.envelopeHash) && sameHash(item.keyCommitment, accepted.keyCommitment));
    if (match === undefined) {
      throw new OpenClaimError("wrong_context", "accepted submission does not match a verified candidate");
    }
    winner = match;
  }
  return { winner, losers: verified.filter((item) => item !== winner) };
}

export function openClaimClaimTransaction(input: {
  deployment: OpenClaimDeployment;
  evidence: "exported-abi";
  verified: VerifiedOpenClaim;
}): OpenClaimSignableTransaction {
  assertEvidence(input.evidence);
  const deployment = deploymentOf(input.deployment);
  if (isAddressEqual(input.verified.solver, deployment.adapter)) {
    throw new OpenClaimError("wrong_context", "the solver cannot be the adapter");
  }
  return {
    kind: "claim",
    to: deployment.adapter,
    value: 0n,
    description: "Submit the solver claim. The release key is not part of this transaction.",
    data: encodeFunctionData({
      abi: openClaimSignatureAbi,
      functionName: "claim",
      args: [input.verified.jobId, bytesToHex(input.verified.envelope), input.verified.seal, input.verified.keyCommitment],
    }),
  };
}

/** Build release calldata only for the winning solver. A loser throws before any key bytes are encoded. */
export function openClaimReleaseTransaction(input: {
  deployment: OpenClaimDeployment;
  evidence: "exported-abi";
  judgment: OpenClaimClaimJudgment;
  caller: Address;
  key: Uint8Array;
  accepted: OpenClaimAcceptedClaim;
  released: boolean;
  now: bigint;
  expiry: bigint;
}): OpenClaimSignableTransaction {
  assertEvidence(input.evidence);
  const deployment = deploymentOf(input.deployment);
  const caller = addressOf(input.caller, "wrong_caller", "caller");
  if (input.judgment.losers.some((loser) => isAddressEqual(loser.solver, caller)) ||
      !isAddressEqual(caller, input.judgment.winner.solver)) {
    throw new OpenClaimError("losing_claim", "a losing solver cannot release its key");
  }
  if (input.released) throw new OpenClaimError("unsupported_terms", "the bounty is already released");
  if (typeof input.now !== "bigint" || typeof input.expiry !== "bigint" ||
      input.expiry <= input.now + BigInt(OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC)) {
    throw new OpenClaimError("unsupported_terms", "release is inside the deadline margin");
  }
  if (!isAddressEqual(input.accepted.solver, input.judgment.winner.solver) ||
      !sameHash(input.accepted.envelopeHash, input.judgment.winner.envelopeHash) ||
      !sameHash(input.accepted.keyCommitment, input.judgment.winner.keyCommitment)) {
    throw new OpenClaimError("losing_claim", "release requires the accepted winning claim");
  }
  const commitment = commitmentOf(input.judgment.winner.contextBytes, input.key);
  if (!sameHash(commitment, input.judgment.winner.keyCommitment)) {
    throw new OpenClaimError("wrong_key", "release key does not match the winning commitment");
  }
  return {
    kind: "release",
    to: deployment.adapter,
    value: 0n,
    description: "Release the winning solver key.",
    data: encodeFunctionData({
      abi: openClaimSignatureAbi,
      functionName: "release",
      args: [input.judgment.winner.jobId, bytesToHex(input.key)],
    }),
  };
}

/** Decrypt the winning delivery after independent checks of payout, caller, context, and commitments. */
export function recoverOpenClaimDelivery(input: {
  deployment: OpenClaimDeployment;
  published: PublishedOpenClaimJob;
  proof: unknown;
  key: Uint8Array;
  evidence: OpenClaimReleaseEvidence;
}): Uint8Array {
  const deployment = deploymentOf(input.deployment);
  assertPublished(deployment, input.published);
  const solver = addressOf(input.evidence.solver, "wrong_caller", "solver");
  const caller = addressOf(input.evidence.caller, "wrong_caller", "caller");
  const payout = addressOf(input.evidence.payout, "wrong_payout", "payout");
  if (!isAddressEqual(caller, solver)) throw new OpenClaimError("wrong_caller", "release caller must be the winning solver");
  if (!isAddressEqual(payout, solver) || isAddressEqual(payout, deployment.adapter) || isAddressEqual(payout, deployment.core)) {
    throw new OpenClaimError("wrong_payout", "payout must be the winning solver");
  }
  if (input.evidence.amount !== input.published.budget) {
    throw new OpenClaimError("wrong_payout", "payout amount must be the full bounty");
  }
  if (input.evidence.jobId !== input.published.jobId) {
    throw new OpenClaimError("wrong_deployment", "release job id does not match the published job");
  }
  if (input.evidence.released !== true || input.evidence.coreStatus !== JobStatus.Completed) {
    throw new OpenClaimError("rejected_receipt", "release payout is not confirmed");
  }
  if (!sameHash(input.evidence.imageId, input.published.imageId) ||
      !sameHash(input.evidence.rulesHash, input.published.rulesHash) ||
      !sameHash(input.evidence.referenceHash, input.published.referenceHash)) {
    throw new OpenClaimError("image_mismatch", "release commitments do not match the published job");
  }
  const proof = parseProofJson(input.proof);
  if (proof.verdict !== 1 || proof.context.jobId !== input.published.jobId ||
      !isAddressEqual(proof.context.provider, solver) || isAddressEqual(proof.context.provider, deployment.adapter) ||
      !isAddressEqual(proof.context.escrow, deployment.adapter) || isAddressEqual(proof.context.escrow, deployment.core)) {
    throw new OpenClaimError("wrong_context", "proof context does not bind the winning solver and adapter");
  }
  if (proof.context.chainId !== BigInt(deployment.chainId)) {
    throw new OpenClaimError("wrong_deployment", "proof chain does not match the deployment");
  }
  if (!sameHash(proof.imageId, input.published.imageId) || !sameHash(proof.context.rulesHash, input.published.rulesHash) ||
      !sameHash(proof.context.referenceHash, input.published.referenceHash)) {
    throw new OpenClaimError("image_mismatch", "proof commitments do not match the published job");
  }
  if (!sameHash(proof.envelopeHash, input.evidence.ciphertextDigest)) {
    throw new OpenClaimError("wrong_ciphertext", "ciphertext digest does not match the proof envelope");
  }
  if (!sameHash(proof.keyCommitment, input.evidence.keyCommitment)) {
    throw new OpenClaimError("wrong_key", "key commitment does not match the release evidence");
  }
  const commitment = commitmentOf(proof.contextBytes, input.key);
  if (!sameHash(commitment, proof.keyCommitment)) {
    throw new OpenClaimError("wrong_key", "key does not open the winning commitment");
  }
  try {
    return decryptEnvelope(proof.envelope, input.key, proof.contextBytes);
  } catch (error) {
    if (error instanceof CodecError && error.code === "auth_failed") {
      throw new OpenClaimError("wrong_ciphertext", "envelope authentication failed");
    }
    throw error;
  }
}
