import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  OPEN_CLAIM_ABI_STATUS,
  OPEN_CLAIM_INTERFACE_REVISION,
  encodeJournal,
  journalDigest,
  keyCommitment,
  openClaimContext,
  openClaimSignatureAbi,
} from "@ubc26/sdk";
import { ENGINE_FIXTURE } from "@ubc26/sdk/testing";

describe("open-claim public vector", () => {
  it("reproduces the published adapter/solver context and digests", () => {
    const bound = openClaimContext({
      chainId: ENGINE_FIXTURE.chainId,
      adapter: ENGINE_FIXTURE.escrow,
      jobId: ENGINE_FIXTURE.jobId,
      solver: ENGINE_FIXTURE.provider,
      rulesHash: ENGINE_FIXTURE.rulesHash,
      referenceHash: ENGINE_FIXTURE.referenceHash,
    });
    expect(Buffer.from(bound.bytes).toString("hex")).toBe(ENGINE_FIXTURE.context.slice(2));
    expect(bound.context.escrow).toBe(ENGINE_FIXTURE.fundedContext.escrow);
    expect(bound.context.provider).toBe(ENGINE_FIXTURE.fundedContext.provider);
    expect(keyCommitment(bound.bytes, hexToBytes(ENGINE_FIXTURE.key))).toBe(
      "0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d",
    );
    const journal = encodeJournal({
      context: bound.context,
      verdict: 1,
      envelopeHash: "0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6",
      keyCommitment: "0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d",
    });
    expect(journalDigest(journal)).toBe("0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e");
  });

  it("keeps the adapter ABI at the published signature checkpoint", () => {
    expect(OPEN_CLAIM_INTERFACE_REVISION).toBe("43b4fca");
    expect(OPEN_CLAIM_ABI_STATUS).toBe("signature-fixture");
    const entries = openClaimSignatureAbi as readonly { type: string; name?: string }[];
    expect(entries.some((item) => item.type === "event" || item.type === "error")).toBe(false);
    expect(openClaimSignatureAbi.map((item) => (item.type === "function" ? item.name : item.type))).toEqual([
      "register",
      "claim",
      "release",
      "contextOf",
      "expectedJournal",
      "core",
      "verifier",
      "usdc",
      "terms",
      "submissions",
      "released",
      "MAX_ENVELOPE_BYTES",
      "MIN_EXPIRY_MARGIN",
    ]);
  });
});
