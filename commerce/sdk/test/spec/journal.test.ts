// CONTRACT.md §1 envelopeHash / keyCommitment / referenceHash / journal (L59-64).
import { describe, it, expect } from "vitest";
import {
  envelopeHash,
  keyCommitment,
  referenceHash,
  encodeJournal,
  decodeJournal,
  journalDigest,
  decodeContext,
  CodecError,
} from "../../src/index.ts";
import {
  FIX,
  FIX_CTX_OBJ,
  FIX_HEX,
  ascii,
  bytesOf,
  cat,
  fixContextBytes,
  hexOf,
  rand,
  refJournal,
  refKeyCommitment,
  refReferenceHash,
  sha256Hex,
} from "./helpers.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CodecError);
    return (e as CodecError).code;
  }
  return undefined;
}

const LOWER32 = /^0x[0-9a-f]{64}$/;

describe("CONTRACT §1 envelopeHash (L59)", () => {
  it("L59 = sha256(envelope), lowercase, random inputs incl. empty", () => {
    for (const n of [0, 1, 28, 100, 16384]) {
      const e = rand(n);
      const h = envelopeHash(e);
      expect(h).toMatch(LOWER32);
      expect(h).toBe(sha256Hex(e));
    }
  });
});

describe("CONTRACT §1 keyCommitment (L60)", () => {
  it("L60 = sha256('UBC26/key/v1'||context||key) for random context bytes and keys", () => {
    for (let i = 0; i < 10; i++) {
      const ctx = cat(new Uint8Array([1]), rand(168));
      const key = rand(32);
      const h = keyCommitment(ctx, key);
      expect(h).toMatch(LOWER32);
      expect(h).toBe(refKeyCommitment(ctx, key));
    }
  });
  it("L60 FundedContext object and its bytes give the same commitment", () => {
    const ctxBytes = cat(new Uint8Array([1]), rand(168));
    const obj = decodeContext(ctxBytes);
    const key = rand(32);
    expect(keyCommitment(obj, key)).toBe(refKeyCommitment(ctxBytes, key));
  });
  it("L60 bad_length: context 168 / 170 bytes", () => {
    expect(codeOf(() => keyCommitment(fixContextBytes().slice(0, 168), FIX.key))).toBe("bad_length");
    expect(codeOf(() => keyCommitment(cat(fixContextBytes(), new Uint8Array([0])), FIX.key))).toBe("bad_length");
  });
  it("L60 bad_length: key 31 / 33 / 0 bytes", () => {
    for (const n of [31, 33, 0]) expect(codeOf(() => keyCommitment(fixContextBytes(), rand(n))), `n=${n}`).toBe("bad_length");
  });
});

describe("CONTRACT §1 referenceHash (L61)", () => {
  it("L61 = sha256('UBC26/reference/v1'||bundle); empty bundle 010000", () => {
    const empty = new Uint8Array([1, 0, 0]);
    expect(referenceHash(empty)).toBe(refReferenceHash(empty));
    expect(referenceHash(empty)).toMatch(LOWER32);
    const b = bytesOf(FIX_HEX.bundle);
    expect(referenceHash(b)).toBe(sha256Hex(ascii("UBC26/reference/v1"), b));
  });
  it("L61 is domain separated from plain sha256", () => {
    const b = bytesOf(FIX_HEX.bundle);
    expect(referenceHash(b)).not.toBe(sha256Hex(b));
  });
});

describe("CONTRACT §1 encodeJournal / decodeJournal / journalDigest (L62-64)", () => {
  const fixJournal = () =>
    refJournal(fixContextBytes(), 1, bytesOf(FIX_HEX.envelopeHash), bytesOf(FIX_HEX.keyCommitment));

  it("L62 layout context||verdict||envelopeHash||keyCommitment, 234 bytes, verdict 0 and 1", () => {
    for (const v of [0, 1] as const) {
      const eh = rand(32);
      const kc = rand(32);
      const out = encodeJournal({ context: FIX_CTX_OBJ, verdict: v, envelopeHash: hexOf(eh), keyCommitment: hexOf(kc) });
      expect(out.length).toBe(234);
      expect(hexOf(out)).toBe(hexOf(refJournal(fixContextBytes(), v, eh, kc)));
    }
  });
  it("L62 accepts upper-case hash hex", () => {
    const out = encodeJournal({
      context: FIX_CTX_OBJ,
      verdict: 1,
      envelopeHash: `0x${FIX_HEX.envelopeHash.slice(2).toUpperCase()}`,
      keyCommitment: FIX_HEX.keyCommitment,
    });
    expect(hexOf(out)).toBe(hexOf(fixJournal()));
  });
  const badJ: [string, Record<string, unknown>][] = [
    ["verdict 2", { verdict: 2 }],
    ["verdict -1", { verdict: -1 }],
    ["envelopeHash 31 bytes", { envelopeHash: `0x${"aa".repeat(31)}` }],
    ["keyCommitment 33 bytes", { keyCommitment: `0x${"aa".repeat(33)}` }],
    ["keyCommitment non-hex", { keyCommitment: `0x${"zz".repeat(32)}` }],
    ["context with negative jobId", { context: { ...FIX_CTX_OBJ, jobId: -1n } }],
  ];
  for (const [label, patch] of badJ) {
    it(`L62 bad_field: ${label}`, () => {
      const j = { context: FIX_CTX_OBJ, verdict: 1, envelopeHash: FIX_HEX.envelopeHash, keyCommitment: FIX_HEX.keyCommitment, ...patch };
      expect(codeOf(() => encodeJournal(j as Parameters<typeof encodeJournal>[0]))).toBe("bad_field");
    });
  }

  it("L63 decodeJournal inverts the fixture journal", () => {
    const j = decodeJournal(fixJournal());
    expect(j).toEqual({
      context: FIX_CTX_OBJ,
      verdict: 1,
      envelopeHash: FIX_HEX.envelopeHash,
      keyCommitment: FIX_HEX.keyCommitment,
    });
  });
  it("L63 round trip on random journals; hashes come back lowercase", () => {
    for (let i = 0; i < 10; i++) {
      const raw = refJournal(cat(new Uint8Array([1]), rand(168)), i % 2, rand(32), rand(32));
      const j = decodeJournal(raw);
      expect(j.verdict).toBe(i % 2);
      expect(j.envelopeHash).toMatch(LOWER32);
      expect(j.keyCommitment).toMatch(LOWER32);
      expect(hexOf(encodeJournal(j))).toBe(hexOf(raw));
    }
  });
  it("L63 bad_length for 233 / 235 / 169 bytes", () => {
    const j = fixJournal();
    expect(codeOf(() => decodeJournal(j.slice(0, 233)))).toBe("bad_length");
    expect(codeOf(() => decodeJournal(cat(j, new Uint8Array([0]))))).toBe("bad_length");
    expect(codeOf(() => decodeJournal(fixContextBytes()))).toBe("bad_length");
  });
  it("L63 bad_version when the embedded context version byte is not 01", () => {
    const j = fixJournal();
    j[0] = 2;
    expect(codeOf(() => decodeJournal(j))).toBe("bad_version");
  });
  it("L63 bad_field when verdict byte is 2 / ff", () => {
    for (const v of [2, 0xff]) {
      const j = fixJournal();
      j[169] = v;
      expect(codeOf(() => decodeJournal(j)), `v=${v}`).toBe("bad_field");
    }
  });

  it("L64 journalDigest = sha256(journal) = fixture digest", () => {
    expect(journalDigest(fixJournal())).toBe(FIX_HEX.journalDigest);
    const r = rand(234);
    expect(journalDigest(r)).toBe(sha256Hex(r));
  });
  it("L64 journalDigest bad_length for 233 / 235 / 0", () => {
    for (const n of [233, 235, 0]) expect(codeOf(() => journalDigest(rand(n))), `n=${n}`).toBe("bad_length");
  });
});
