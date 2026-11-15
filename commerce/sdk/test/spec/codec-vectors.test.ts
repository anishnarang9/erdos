// CONTRACT.md §1 "Required vectors" (L82-106), cross-checked against ZKVM-IMPLEMENTATION §3.
import { describe, it, expect } from "vitest";
import {
  encodeContext,
  encodeBundle,
  envelopeHash,
  keyCommitment,
  encodeJournal,
  journalDigest,
  decryptEnvelope,
  referenceHash,
  decodeBundle,
  CONTEXT_LENGTH,
  JOURNAL_LENGTH,
  KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  MAX_BUNDLE_FILES,
  MAX_DELIVERY_BYTES,
  SEAL_SELECTOR,
  TAG_KEY,
  TAG_REFERENCE,
} from "../../src/index.ts";
import { encryptEnvelope, ENGINE_FIXTURE, simulatedSeal } from "../../src/testing/index.ts";
import {
  FIX,
  FIX_HEX,
  FIX_CONTEXT_HEX,
  FIX_CTX_OBJ,
  ascii,
  bytesOf,
  fixContextBytes,
  hexOf,
  refBundle,
  refEncrypt,
  refJournal,
  refKeyCommitment,
  refReferenceHash,
  refSimulatedSeal,
  sha256,
  sha256Hex,
} from "./helpers.ts";

const ok = ascii("ok");

describe("CONTRACT §1 Required vectors (L82-106): independent node:crypto computation matches literals", () => {
  it("L100 context literal = independently built 169 bytes", () => {
    const ctx = fixContextBytes();
    expect(ctx.length).toBe(169);
    expect(hexOf(ctx)).toBe(FIX_CONTEXT_HEX);
  });
  it("L101 bundle literal = independent encoding of a.txt='ok'", () => {
    expect(hexOf(refBundle([{ name: "a.txt", content: ok }]))).toBe(FIX_HEX.bundle);
  });
  it("L102 envelope literal = node:crypto chacha20-poly1305(bundle, key 55*32, nonce 66*12, aad context)", () => {
    const env = refEncrypt(bytesOf(FIX_HEX.bundle), FIX.key, FIX.nonce, fixContextBytes());
    expect(hexOf(env)).toBe(FIX_HEX.envelope);
  });
  it("L103 envelopeHash literal = sha256(envelope)", () => {
    expect(sha256Hex(bytesOf(FIX_HEX.envelope))).toBe(FIX_HEX.envelopeHash);
  });
  it("L104 keyCommitment literal = sha256('UBC26/key/v1'||context||key)", () => {
    expect(refKeyCommitment(fixContextBytes(), FIX.key)).toBe(FIX_HEX.keyCommitment);
  });
  it("L105 journalDigest literal = sha256(context||01||envHash||keyCommit)", () => {
    const j = refJournal(fixContextBytes(), 1, bytesOf(FIX_HEX.envelopeHash), bytesOf(FIX_HEX.keyCommitment));
    expect(j.length).toBe(234);
    expect(hexOf(sha256(j))).toBe(FIX_HEX.journalDigest);
  });
});

describe("CONTRACT §1 Required vectors (L82-106): SDK reproduces literals", () => {
  it("L55 encodeContext(fixture) = L100 context", () => {
    expect(hexOf(encodeContext(FIX_CTX_OBJ))).toBe(FIX_CONTEXT_HEX);
  });
  it("L57 encodeBundle([a.txt=ok]) = L101 bundle", () => {
    expect(hexOf(encodeBundle([{ name: "a.txt", content: ok }]))).toBe(FIX_HEX.bundle);
  });
  it("L78 testing.encryptEnvelope(bundle, key, nonce, context) = L102 envelope", () => {
    const env = encryptEnvelope(bytesOf(FIX_HEX.bundle), FIX.key, FIX.nonce, fixContextBytes());
    expect(hexOf(env)).toBe(FIX_HEX.envelope);
  });
  it("L65 decryptEnvelope(L102 envelope) = L101 bundle", () => {
    const pt = decryptEnvelope(bytesOf(FIX_HEX.envelope), FIX.key, fixContextBytes());
    expect(hexOf(pt)).toBe(FIX_HEX.bundle);
  });
  it("L59 envelopeHash(envelope) = L103", () => {
    expect(envelopeHash(bytesOf(FIX_HEX.envelope))).toBe(FIX_HEX.envelopeHash);
  });
  it("L60 keyCommitment(context bytes, key) = L104", () => {
    expect(keyCommitment(fixContextBytes(), FIX.key)).toBe(FIX_HEX.keyCommitment);
  });
  it("L60 keyCommitment(FundedContext object, key) = L104", () => {
    expect(keyCommitment(FIX_CTX_OBJ, FIX.key)).toBe(FIX_HEX.keyCommitment);
  });
  it("L62/L64 journalDigest(encodeJournal(fixture)) = L105", () => {
    const j = encodeJournal({
      context: FIX_CTX_OBJ,
      verdict: 1,
      envelopeHash: FIX_HEX.envelopeHash,
      keyCommitment: FIX_HEX.keyCommitment,
    });
    expect(j.length).toBe(234);
    expect(journalDigest(j)).toBe(FIX_HEX.journalDigest);
  });
});

describe("CONTRACT §1 Constants (L41-47)", () => {
  it("L44-46 constant values", () => {
    expect(CONTEXT_LENGTH).toBe(169);
    expect(JOURNAL_LENGTH).toBe(234);
    expect(KEY_LENGTH).toBe(32);
    expect(NONCE_LENGTH).toBe(12);
    expect(TAG_LENGTH).toBe(16);
    expect(MAX_BUNDLE_FILES).toBe(16);
    expect(MAX_DELIVERY_BYTES).toBe(16384);
    expect(SEAL_SELECTOR).toBe("0xe71e6620");
    expect(TAG_KEY).toBe("UBC26/key/v1");
    expect(TAG_REFERENCE).toBe("UBC26/reference/v1");
  });
});

// Literals below were computed once with node:crypto (see helpers.ts reference functions) and pasted in.
const V_REFHASH_EMPTY = "0xaa21c0b6ffa196eb88cb407d47551d6695f2624a81c57e499efae120cf687d95";
const V_BUNDLE2 = "0x0100020005422e62696e0000000200ff0005612e747874000000026869";
const V_SEAL_77 = "0xe71e662036589332b14a125732ef6772332fbdf74df60330eda04b19cfbb8799d5d5ae41";

describe("Extra hard-coded vectors (round 2)", () => {
  it("referenceHash(010000) literal; helper agrees", () => {
    expect(refReferenceHash(bytesOf("0x010000"))).toBe(V_REFHASH_EMPTY);
    expect(referenceHash(bytesOf("0x010000"))).toBe(V_REFHASH_EMPTY);
  });
  it("two-file bundle (a.txt='hi', B.bin=00ff) literal, 'B.bin' sorts before 'a.txt'", () => {
    const files = [
      { name: "a.txt", content: ascii("hi") },
      { name: "B.bin", content: new Uint8Array([0, 255]) },
    ];
    expect(hexOf(refBundle(files))).toBe(V_BUNDLE2);
    expect(hexOf(encodeBundle(files))).toBe(V_BUNDLE2);
    expect(decodeBundle(bytesOf(V_BUNDLE2)).map((f) => f.name)).toEqual(["B.bin", "a.txt"]);
  });
  it("simulatedSeal(77*32, fixture journalDigest) literal", () => {
    const img = `0x${"77".repeat(32)}` as const;
    expect(refSimulatedSeal(bytesOf(img), bytesOf(FIX_HEX.journalDigest))).toBe(V_SEAL_77);
    expect(simulatedSeal(img, FIX_HEX.journalDigest)).toBe(V_SEAL_77);
  });
});

describe("Settled round 1: ENGINE_FIXTURE shape", () => {
  it("flat hex values, chainId/jobId bigints, fundedContext and files", () => {
    const fx = ENGINE_FIXTURE as unknown as Record<string, unknown>;
    expect(fx.chainId).toBe(5042002n);
    expect(fx.jobId).toBe(7n);
    expect(fx.fundedContext).toEqual(FIX_CTX_OBJ);
    const files = fx.files as { name: string; content: Uint8Array }[];
    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(hexOf(files[0]!.content)).toBe(hexOf(ok));
    expect(fx.verdict).toBe(1); // settled: verdict is the number 1, not hex
    for (const [k, v] of Object.entries(fx)) {
      if (["chainId", "jobId", "verdict", "fundedContext", "files"].includes(k)) continue;
      expect(typeof v, k).toBe("string");
      expect(v as string, k).toMatch(/^0x[0-9a-f]*$/);
    }
  });
});

describe("CONTRACT §1 Testing helpers ENGINE_FIXTURE (L80)", () => {
  function strings(v: unknown, out: string[] = []): string[] {
    if (typeof v === "string") out.push(v.toLowerCase().replace(/^0x/, ""));
    else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
    return out;
  }
  it("L80 ENGINE_FIXTURE contains every required input and expected value as hex", () => {
    const all = strings(ENGINE_FIXTURE);
    const need = [
      FIX_CONTEXT_HEX,
      FIX_HEX.bundle,
      FIX_HEX.envelope,
      FIX_HEX.envelopeHash,
      FIX_HEX.keyCommitment,
      FIX_HEX.journalDigest,
      hexOf(FIX.key),
      hexOf(FIX.nonce),
    ].map((h) => h.slice(2));
    for (const h of need) expect(all, `ENGINE_FIXTURE missing ${h.slice(0, 16)}...`).toContain(h);
  });
});
