import {
  bytesToHex,
  decodeFunctionData,
  getAddress,
  hexToBytes,
  parseAbi,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  JobStatus,
  OPEN_CLAIM_ONE_USDC,
  OpenClaimError,
  decodeContext,
  discoverOpenClaimJob,
  encodeContext,
  encodeJournal,
  envelopeHash,
  journalDigest,
  judgeOpenClaimClaims,
  keyCommitment,
  openClaimClaimTransaction,
  openClaimContext,
  openClaimReleaseTransaction,
  recoverOpenClaimDelivery,
  verifyOpenClaimCandidate,
} from "@ubc26/sdk";
import type {
  OpenClaimCandidate,
  OpenClaimChainSnapshot,
  OpenClaimDeployment,
  PublishedOpenClaimJob,
} from "@ubc26/sdk";
import { ENGINE_FIXTURE, simulatedSeal } from "@ubc26/sdk/testing";

const buyer = getAddress("0x00000000000000000000000000000000000000b1");
const core = getAddress("0x00000000000000000000000000000000000000c0");
const verifier = getAddress("0x00000000000000000000000000000000000000e1");
const usdc = getAddress("0x00000000000000000000000000000000000000d0");
const adapter = ENGINE_FIXTURE.escrow;
const solverA = ENGINE_FIXTURE.provider;
const solverB = getAddress("0x3333333333333333333333333333333333333333");
const imageId = `0x${"ab".repeat(32)}` as Hex;
const now = 1_700_000_000n;
const expiry = now + 3_600n;
const registerTx = `0x${"12".repeat(32)}` as Hex;
const keyA = hexToBytes(ENGINE_FIXTURE.key);
const keyB = hexToBytes(`0x${"77".repeat(32)}`);
const releaseAbi = parseAbi(["function release(uint256 jobId, bytes32 key)"]);
const claimAbi = parseAbi(["function claim(uint256 jobId, bytes envelope, bytes seal, bytes32 keyCommitment)"]);

const deployment: OpenClaimDeployment = {
  mode: "open-claim",
  chainId: 5042002,
  core,
  adapter,
  verifier,
  usdc,
};

const published: PublishedOpenClaimJob = {
  mode: "open-claim",
  chainId: 5042002,
  core,
  adapter,
  verifier,
  usdc,
  jobId: ENGINE_FIXTURE.jobId,
  buyer,
  imageId,
  rulesHash: ENGINE_FIXTURE.rulesHash,
  referenceHash: ENGINE_FIXTURE.referenceHash,
  budget: OPEN_CLAIM_ONE_USDC,
  expiry,
  description: "open bounty",
  funded: true,
  registered: true,
  registerTx,
};

function candidateFor(
  solver: Address,
  key: Uint8Array,
  envelope: Uint8Array,
): OpenClaimCandidate {
  const bound = openClaimContext({
    chainId: ENGINE_FIXTURE.chainId,
    adapter,
    jobId: ENGINE_FIXTURE.jobId,
    solver,
    rulesHash: ENGINE_FIXTURE.rulesHash,
    referenceHash: ENGINE_FIXTURE.referenceHash,
  });
  const commitment = keyCommitment(bound.bytes, key);
  const digest = envelopeHash(envelope);
  const journal = encodeJournal({
    context: bound.context,
    verdict: 1,
    envelopeHash: digest,
    keyCommitment: commitment,
  });
  return {
    solver,
    caller: solver,
    envelope,
    seal: simulatedSeal(imageId, journalDigest(journal)),
    keyCommitment: commitment,
    imageId,
    context: bound.context,
    verdict: 1,
    journal,
  };
}

const candidateA = candidateFor(solverA, keyA, hexToBytes(ENGINE_FIXTURE.envelope));
const envelopeB = new Uint8Array(40).fill(0x99);
const candidateB = candidateFor(solverB, keyB, envelopeB);

function proofFor(candidate: OpenClaimCandidate, keyCommitmentHex: Hex = candidate.keyCommitment) {
  return {
    version: 1,
    context: bytesToHex(encodeContext(candidate.context)),
    imageId,
    verdict: 1,
    envelope: bytesToHex(candidate.envelope),
    keyCommitment: keyCommitmentHex,
    journal: bytesToHex(candidate.journal),
    seal: candidate.seal,
  };
}

function evidenceFor(candidate: OpenClaimCandidate, payout: Address = candidate.solver) {
  return {
    jobId: ENGINE_FIXTURE.jobId,
    solver: candidate.solver,
    caller: candidate.solver,
    payout,
    amount: OPEN_CLAIM_ONE_USDC,
    ciphertextDigest: envelopeHash(candidate.envelope),
    keyCommitment: candidate.keyCommitment,
    imageId,
    rulesHash: ENGINE_FIXTURE.rulesHash,
    referenceHash: ENGINE_FIXTURE.referenceHash,
    released: true,
    coreStatus: JobStatus.Completed,
  };
}

function snapshot(overrides: Partial<OpenClaimChainSnapshot> = {}): OpenClaimChainSnapshot {
  return {
    job: {
      id: ENGINE_FIXTURE.jobId,
      client: buyer,
      provider: adapter,
      evaluator: adapter,
      hook: zeroAddress,
      budget: OPEN_CLAIM_ONE_USDC,
      expiredAt: expiry,
      status: JobStatus.Funded,
      description: "open bounty",
    },
    terms: {
      buyer,
      imageId,
      rulesHash: ENGINE_FIXTURE.rulesHash,
      referenceHash: ENGINE_FIXTURE.referenceHash,
      budget: OPEN_CLAIM_ONE_USDC,
      expiry,
      registered: true,
    },
    submission: null,
    released: false,
    token: usdc,
    evaluatorFeeBP: 0n,
    platformFeeBP: 0n,
    wiring: { core, verifier, usdc },
    ...overrides,
  };
}

describe("open-claim claim evidence and recovery", () => {
  it("publishes only a confirmed registered funded job", () => {
    expect(discoverOpenClaimJob({
      deployment,
      approval: {
        revision: "rev-1",
        buyer,
        imageId,
        rulesHash: ENGINE_FIXTURE.rulesHash,
        referenceHash: ENGINE_FIXTURE.referenceHash,
        budget: OPEN_CLAIM_ONE_USDC,
        expiry,
        description: "open bounty",
      },
      evidence: "exported-abi",
      now,
      jobId: ENGINE_FIXTURE.jobId,
      registerReceipt: { state: "confirmed", transactionHash: registerTx },
      snapshot: snapshot(),
    })).toMatchObject({ jobId: ENGINE_FIXTURE.jobId, funded: true, registered: true, registerTx });

    expect(() => discoverOpenClaimJob({
      deployment,
      approval: {
        revision: "rev-1",
        buyer,
        imageId,
        rulesHash: ENGINE_FIXTURE.rulesHash,
        referenceHash: ENGINE_FIXTURE.referenceHash,
        budget: OPEN_CLAIM_ONE_USDC,
        expiry,
        description: "open bounty",
      },
      evidence: "exported-abi",
      now,
      jobId: ENGINE_FIXTURE.jobId,
      registerReceipt: { state: "pending", transactionHash: registerTx },
      snapshot: snapshot(),
    })).toThrow(expect.objectContaining({ code: "awaiting_receipt" }));
  });

  it("accepts the first verified solver and keeps the losing key off the release path", () => {
    const judgment = judgeOpenClaimClaims({ deployment, published, candidates: [candidateA, candidateB] });
    expect(judgment.winner.solver).toBe(solverA);
    expect(judgment.losers.map((loser) => loser.solver)).toEqual([solverB]);

    const reserved = judgeOpenClaimClaims({
      deployment,
      published,
      candidates: [candidateA, candidateB],
      accepted: {
        solver: solverB,
        envelopeHash: envelopeHash(envelopeB),
        keyCommitment: candidateB.keyCommitment,
      },
    });
    expect(reserved.winner.solver).toBe(solverB);
    expect(reserved.losers.map((loser) => loser.solver)).toEqual([solverA]);

    expect(() => openClaimReleaseTransaction({
      deployment,
      evidence: "exported-abi",
      judgment,
      caller: solverB,
      key: keyB,
      accepted: {
        solver: solverA,
        envelopeHash: ENGINE_FIXTURE.envelopeHash,
        keyCommitment: ENGINE_FIXTURE.keyCommitment,
      },
      released: false,
      now,
      expiry,
    })).toThrow(expect.objectContaining({ code: "losing_claim" }));

    try {
      openClaimReleaseTransaction({
        deployment,
        evidence: "exported-abi",
        judgment,
        caller: solverB,
        key: keyB,
        accepted: {
          solver: solverA,
          envelopeHash: ENGINE_FIXTURE.envelopeHash,
          keyCommitment: ENGINE_FIXTURE.keyCommitment,
        },
        released: false,
        now,
        expiry,
      });
      throw new Error("loser release returned");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenClaimError);
      expect(String((error as Error).message).toLowerCase()).not.toContain("77".repeat(32));
      expect(error).not.toHaveProperty("data");
    }

    const release = openClaimReleaseTransaction({
      deployment,
      evidence: "exported-abi",
      judgment,
      caller: solverA,
      key: keyA,
      accepted: {
        solver: solverA,
        envelopeHash: ENGINE_FIXTURE.envelopeHash,
        keyCommitment: ENGINE_FIXTURE.keyCommitment,
      },
      released: false,
      now,
      expiry,
    });
    expect(decodeFunctionData({ abi: releaseAbi, data: release.data }).args).toEqual([
      ENGINE_FIXTURE.jobId,
      ENGINE_FIXTURE.key,
    ]);
    const claim = openClaimClaimTransaction({ deployment, evidence: "exported-abi", verified: judgment.winner });
    expect(claim.data.toLowerCase().includes("55".repeat(32))).toBe(false);
    expect(decodeFunctionData({ abi: claimAbi, data: claim.data }).functionName).toBe("claim");
  });

  it("lets a later valid solver win after an invalid candidate", () => {
    const invalid = { ...candidateA, caller: adapter };
    const judgment = judgeOpenClaimClaims({ deployment, published, candidates: [invalid, candidateB] });
    expect(judgment.winner.solver).toBe(solverB);
    expect(judgment.losers).toEqual([]);
  });

  it("rejects the wrong caller, payout, context, and deployment", () => {
    expect(() => verifyOpenClaimCandidate({
      deployment,
      published,
      candidate: { ...candidateA, caller: adapter },
    })).toThrow(expect.objectContaining({ code: "wrong_caller" }));

    const selected = decodeContext(encodeContext({
      chainId: ENGINE_FIXTURE.chainId,
      escrow: core,
      jobId: ENGINE_FIXTURE.jobId,
      provider: solverA,
      rulesHash: ENGINE_FIXTURE.rulesHash,
      referenceHash: ENGINE_FIXTURE.referenceHash,
    }));
    const selectedCommitment = keyCommitment(encodeContext(selected), keyA);
    const selectedJournal = encodeJournal({
      context: selected,
      verdict: 1,
      envelopeHash: ENGINE_FIXTURE.envelopeHash,
      keyCommitment: selectedCommitment,
    });
    expect(() => verifyOpenClaimCandidate({
      deployment,
      published,
      candidate: {
        ...candidateA,
        context: selected,
        keyCommitment: selectedCommitment,
        journal: selectedJournal,
        seal: simulatedSeal(imageId, journalDigest(selectedJournal)),
      },
    })).toThrow(expect.objectContaining({ code: "wrong_context" }));

    expect(() => verifyOpenClaimCandidate({
      deployment: { ...deployment, chainId: 1 },
      published,
      candidate: candidateA,
    })).toThrow(expect.objectContaining({ code: "wrong_deployment" }));

    expect(() => recoverOpenClaimDelivery({
      deployment,
      published,
      proof: proofFor(candidateA),
      key: keyA,
      evidence: evidenceFor(candidateA, adapter),
    })).toThrow(expect.objectContaining({ code: "wrong_payout" }));
  });

  it("rejects a wrong key and a wrong ciphertext", () => {
    const wrongKey = Uint8Array.from(keyA, (byte, index) => index === 0 ? byte ^ 0xff : byte);
    expect(() => recoverOpenClaimDelivery({
      deployment,
      published,
      proof: proofFor(candidateA),
      key: wrongKey,
      evidence: evidenceFor(candidateA),
    })).toThrow(expect.objectContaining({ code: "wrong_key" }));

    const badEnvelope = Uint8Array.from(candidateA.envelope);
    badEnvelope[20] = (badEnvelope[20] ?? 0) ^ 0xff;
    const badCandidate = candidateFor(solverA, keyA, badEnvelope);
    expect(() => recoverOpenClaimDelivery({
      deployment,
      published,
      proof: proofFor(badCandidate),
      key: keyA,
      evidence: evidenceFor(badCandidate),
    })).toThrow(expect.objectContaining({ code: "wrong_ciphertext" }));
  });

  it("recovers the exact public-vector plaintext for the winning solver", () => {
    const plaintext = recoverOpenClaimDelivery({
      deployment,
      published,
      proof: proofFor(candidateA),
      key: keyA,
      evidence: evidenceFor(candidateA),
    });
    expect(plaintext).toEqual(hexToBytes(ENGINE_FIXTURE.plaintext));
    expect(bytesToHex(plaintext)).toBe(ENGINE_FIXTURE.plaintext);
  });
});
