// CONTRACT.md §1 parseProofJson (L66-74) and testing.simulatedSeal (L79); ZKVM §3 step 4.
import { describe, it, expect } from "vitest";
import { parseProofJson, CodecError } from "../../src/index.ts";
import { simulatedSeal } from "../../src/testing/index.ts";
import {
  FIX,
  FIX_CTX_OBJ,
  FIX_HEX,
  bytesOf,
  fixContextBytes,
  hexOf,
  rand,
  refEncrypt,
  refJournal,
  refKeyCommitment,
  refSimulatedSeal,
  sha256,
} from "./helpers.ts";

type ProofJson = Record<string, unknown>;

function build(verdict: 0 | 1 = 1, imageId = rand(32)): ProofJson {
  const ctx = fixContextBytes();
  const envelope = bytesOf(FIX_HEX.envelope);
  const kc = bytesOf(refKeyCommitment(ctx, FIX.key));
  const journal = refJournal(ctx, verdict, sha256(envelope), kc);
  return {
    version: 1,
    context: hexOf(ctx),
    imageId: hexOf(imageId),
    verdict,
    envelope: hexOf(envelope),
    keyCommitment: hexOf(kc),
    journal: hexOf(journal),
    seal: refSimulatedSeal(imageId, sha256(journal)),
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CodecError);
    return (e as CodecError).code;
  }
  return undefined;
}

const upper = (h: unknown) => `0x${String(h).slice(2).toUpperCase()}`;

describe("CONTRACT §1 testing.simulatedSeal (L79)", () => {
  it("L79 = 0xe71e6620 || sha256(imageId||journalDigest), 36 bytes, lowercase", () => {
    for (let i = 0; i < 10; i++) {
      const img = rand(32);
      const jd = rand(32);
      const s = simulatedSeal(hexOf(img), hexOf(jd));
      expect(s).toBe(refSimulatedSeal(img, jd));
      expect(s).toMatch(/^0xe71e6620[0-9a-f]{64}$/);
    }
  });
});

describe("CONTRACT §1 parseProofJson accepts (L68-74)", () => {
  it("L68-74 valid object yields a complete ProofPackage (L32-33)", () => {
    const img = rand(32);
    const pj = build(1, img);
    const p = parseProofJson(pj);
    const journal = bytesOf(pj.journal as string);
    expect(p.version).toBe(1);
    expect(p.verdict).toBe(1);
    expect(p.context).toEqual(FIX_CTX_OBJ);
    expect(hexOf(p.contextBytes)).toBe(hexOf(fixContextBytes()));
    expect(p.imageId).toBe(hexOf(img));
    expect(hexOf(p.envelope)).toBe(FIX_HEX.envelope);
    expect(p.envelopeHash).toBe(FIX_HEX.envelopeHash);
    expect(p.keyCommitment).toBe(FIX_HEX.keyCommitment);
    expect(hexOf(p.journal)).toBe(hexOf(journal));
    expect(p.journalDigest).toBe(hexOf(sha256(journal)));
    expect(p.journalDigest).toBe(FIX_HEX.journalDigest);
    expect(p.seal.toLowerCase()).toBe((pj.seal as string).toLowerCase());
  });
  it("L68 JSON string input is accepted and equals object input", () => {
    const pj = build();
    expect(parseProofJson(JSON.stringify(pj))).toEqual(parseProofJson(pj));
  });
  it("L70 upper-case hex in every byte field is accepted; outputs lowercase hashes (L49)", () => {
    const pj = build();
    const up: ProofJson = { ...pj };
    for (const k of ["context", "imageId", "envelope", "keyCommitment", "journal", "seal"]) up[k] = upper(pj[k]);
    const p = parseProofJson(up);
    expect(p.imageId).toBe((pj.imageId as string).toLowerCase());
    expect(p.keyCommitment).toBe(FIX_HEX.keyCommitment);
    expect(p.envelopeHash).toBe(FIX_HEX.envelopeHash);
    expect(p.journalDigest).toBe(FIX_HEX.journalDigest);
  });
  it("L71 verdict as string \"1\" and version as string \"1\" are accepted", () => {
    const p = parseProofJson({ ...build(), verdict: "1", version: "1" });
    expect(p.verdict).toBe(1);
    expect(p.version).toBe(1);
  });
  it("L71 verdict 0 package (with matching verdict-0 journal) is accepted", () => {
    const p = parseProofJson(build(0));
    expect(p.verdict).toBe(0);
    expect(hexOf(p.journal.slice(169, 170))).toBe("0x00");
  });
  it("L74 only the selector is checked: arbitrary seal bytes after 0xe71e6620 are accepted", () => {
    const pj = build();
    expect(() => parseProofJson({ ...pj, seal: `0xe71e6620${"ab".repeat(256)}` })).not.toThrow();
  });
  it("L69 extra unknown fields are ignored", () => {
    expect(() => parseProofJson({ ...build(), extra: "x" })).not.toThrow();
  });
});

describe("CONTRACT §1 parseProofJson rejects (L68-74)", () => {
  for (const field of ["version", "context", "imageId", "verdict", "envelope", "keyCommitment", "journal", "seal"]) {
    it(`L69 bad_field: missing ${field}`, () => {
      const pj = build();
      delete pj[field];
      expect(codeOf(() => parseProofJson(pj))).toBe("bad_field");
    });
  }
  it("L69 bad_field: mistyped byte field (context is a number)", () => {
    expect(codeOf(() => parseProofJson({ ...build(), context: 5 }))).toBe("bad_field");
  });
  it("L69 bad_field: mistyped verdict (boolean true)", () => {
    expect(codeOf(() => parseProofJson({ ...build(), verdict: true }))).toBe("bad_field");
  });
  it("L70 bad_hex: non-hex characters in envelope", () => {
    expect(codeOf(() => parseProofJson({ ...build(), envelope: "0xzz" }))).toBe("bad_hex");
  });
  it("L70 bad_hex: odd-length hex in imageId", () => {
    expect(codeOf(() => parseProofJson({ ...build(), imageId: `0x${"a".repeat(63)}` }))).toBe("bad_hex");
  });
  it("L71 bad_field: version 2 (number) and \"2\" (string)", () => {
    expect(codeOf(() => parseProofJson({ ...build(), version: 2 }))).toBe("bad_field");
    expect(codeOf(() => parseProofJson({ ...build(), version: "2" }))).toBe("bad_field");
  });
  it("L71 bad_field: verdict 2 / \"2\" / -1", () => {
    for (const v of [2, "2", -1]) expect(codeOf(() => parseProofJson({ ...build(), verdict: v })), String(v)).toBe("bad_field");
  });
  it("L72/R1 context of 168 and 170 bytes -> bad_length", () => {
    const pj = build();
    expect(codeOf(() => parseProofJson({ ...pj, context: (pj.context as string).slice(0, -2) }))).toBe("bad_length");
    expect(codeOf(() => parseProofJson({ ...pj, context: `${pj.context as string}00` }))).toBe("bad_length");
  });
  it("L72/R1 imageId of 31 bytes and keyCommitment of 33 bytes -> bad_length", () => {
    const pj = build();
    expect(codeOf(() => parseProofJson({ ...pj, imageId: `0x${"11".repeat(31)}` }))).toBe("bad_length");
    expect(codeOf(() => parseProofJson({ ...pj, keyCommitment: `${pj.keyCommitment as string}00` }))).toBe("bad_length");
  });
  it("R2 context version byte 02 -> bad_version", () => {
    const pj = build();
    const ctx = bytesOf(pj.context as string);
    ctx[0] = 2;
    expect(codeOf(() => parseProofJson({ ...pj, context: hexOf(ctx) }))).toBe("bad_version");
  });
  it("R2 missing 0x prefix -> bad_hex", () => {
    const pj = build();
    expect(codeOf(() => parseProofJson({ ...pj, envelope: (pj.envelope as string).slice(2) }))).toBe("bad_hex");
    expect(codeOf(() => parseProofJson({ ...pj, seal: (pj.seal as string).slice(2) }))).toBe("bad_hex");
  });
  it("R2 a field set to null -> bad_field", () => {
    expect(codeOf(() => parseProofJson({ ...build(), journal: null }))).toBe("bad_field");
    expect(codeOf(() => parseProofJson({ ...build(), verdict: null }))).toBe("bad_field");
  });
  it("R1 no envelope size limit: a 20000-byte envelope with a matching journal is accepted", () => {
    const img = rand(32);
    const ctx = fixContextBytes();
    const envelope = refEncrypt(rand(20000 - 28), FIX.key, rand(12), ctx);
    const kc = bytesOf(refKeyCommitment(ctx, FIX.key));
    const journal = refJournal(ctx, 1, sha256(envelope), kc);
    const p = parseProofJson({
      version: 1, context: hexOf(ctx), imageId: hexOf(img), verdict: 1, envelope: hexOf(envelope),
      keyCommitment: hexOf(kc), journal: hexOf(journal), seal: refSimulatedSeal(img, sha256(journal)),
    });
    expect(p.envelope.length).toBe(20000);
  });
  it("R2 several violations: first in settled order wins (bad_hex before version; mismatch before selector)", () => {
    expect(codeOf(() => parseProofJson({ ...build(), version: 2, envelope: "0xzz" }))).toBe("bad_hex");
    const pj = build();
    const j = bytesOf(pj.journal as string);
    j[200]! ^= 1;
    expect(codeOf(() => parseProofJson({ ...pj, journal: hexOf(j), seal: "0xdeadbeef" }))).toBe("mismatch");
    expect(codeOf(() => parseProofJson({ ...build(), version: 2, imageId: "0x11" }))).toBe("bad_field");
  });
  it("L73 mismatch: journal byte tampered (envelopeHash region)", () => {
    const pj = build();
    const j = bytesOf(pj.journal as string);
    j[200]! ^= 1;
    expect(codeOf(() => parseProofJson({ ...pj, journal: hexOf(j) }))).toBe("mismatch");
  });
  it("L73 mismatch: journal verdict byte differs from verdict field", () => {
    const pj = build(1);
    expect(codeOf(() => parseProofJson({ ...pj, verdict: 0 }))).toBe("mismatch");
  });
  it("L73 mismatch: envelope swapped for another valid envelope", () => {
    const pj = build();
    const other = refEncrypt(rand(40), FIX.key, rand(12), fixContextBytes());
    expect(codeOf(() => parseProofJson({ ...pj, envelope: hexOf(other) }))).toBe("mismatch");
  });
  it("L73 mismatch: keyCommitment field changed", () => {
    expect(codeOf(() => parseProofJson({ ...build(), keyCommitment: hexOf(rand(32)) }))).toBe("mismatch");
  });
  it("L73 mismatch: context field changed (jobId 8) but journal still has jobId 7", () => {
    const pj = build();
    const ctx = bytesOf(pj.context as string);
    ctx[84] = 8;
    expect(codeOf(() => parseProofJson({ ...pj, context: hexOf(ctx) }))).toBe("mismatch");
  });
  it("L73 mismatch: journal truncated to 233 bytes (length differs)", () => {
    const pj = build();
    expect(codeOf(() => parseProofJson({ ...pj, journal: (pj.journal as string).slice(0, -2) }))).toBe("mismatch");
    expect(codeOf(() => parseProofJson({ ...pj, journal: `${pj.journal as string}00` }))).toBe("mismatch");
  });
  it("L74 bad_selector: seal starts with 0xdeadbeef", () => {
    const pj = build();
    const seal = `0xdeadbeef${(pj.seal as string).slice(10)}`;
    expect(codeOf(() => parseProofJson({ ...pj, seal }))).toBe("bad_selector");
  });
  it("L74 bad_selector: seal shorter than the selector (0xe71e66) or empty (0x)", () => {
    expect(codeOf(() => parseProofJson({ ...build(), seal: "0xe71e66" }))).toBe("bad_selector");
    expect(codeOf(() => parseProofJson({ ...build(), seal: "0x" }))).toBe("bad_selector");
  });
  it("L68/R1 non-object input (null, 42, array, true) and invalid JSON text -> bad_field", () => {
    for (const v of [null, 42, [], true, "not json", "{", "42", "null"]) {
      expect(codeOf(() => parseProofJson(v)), JSON.stringify(v)).toBe("bad_field");
    }
  });
});
