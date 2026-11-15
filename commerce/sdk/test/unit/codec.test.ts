import { bytesToHex, hexToBytes } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CodecError,
  CONTEXT_LENGTH,
  decodeBundle,
  decodeContext,
  decodeJournal,
  decryptEnvelope,
  encodeBundle,
  encodeContext,
  encodeJournal,
  envelopeHash,
  journalDigest,
  JOURNAL_LENGTH,
  keyCommitment,
  parseProofJson,
  referenceHash,
} from "../../src/index.ts";
import type { CodecErrorCode } from "../../src/index.ts";
import { encryptEnvelope, ENGINE_FIXTURE as F, simulatedSeal } from "../../src/testing/index.ts";

const b = (h: string): Uint8Array => hexToBytes(h as Hex);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function expectCode(fn: () => unknown, code: CodecErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected CodecError(${code})`).toBeInstanceOf(CodecError);
  expect((caught as CodecError).code).toBe(code);
}

describe("engine fixture vectors", () => {
  it("context", () => {
    const ctx = encodeContext(F.fundedContext);
    expect(ctx.length).toBe(CONTEXT_LENGTH);
    expect(bytesToHex(ctx)).toBe(F.context);
    const dec = decodeContext(ctx);
    expect(dec.chainId).toBe(5042002n);
    expect(dec.jobId).toBe(7n);
    expect(dec.escrow).toBe("0x1111111111111111111111111111111111111111");
    expect(dec.rulesHash).toBe(F.rulesHash);
  });

  it("bundle", () => {
    expect(bytesToHex(encodeBundle([{ name: "a.txt", content: enc("ok") }]))).toBe(F.bundle);
    const files = decodeBundle(b(F.bundle));
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("a.txt");
    expect(new TextDecoder().decode(files[0]!.content)).toBe("ok");
  });

  it("envelope, hashes, journal", () => {
    const ctx = encodeContext(F.fundedContext);
    const env = encryptEnvelope(b(F.bundle), b(F.key), b(F.nonce), ctx);
    expect(bytesToHex(env)).toBe(F.envelope);
    expect(envelopeHash(env)).toBe(F.envelopeHash);
    expect(keyCommitment(ctx, b(F.key))).toBe(F.keyCommitment);
    expect(keyCommitment(F.fundedContext, b(F.key))).toBe(F.keyCommitment);
    const journal = encodeJournal({
      context: F.fundedContext,
      verdict: 1,
      envelopeHash: F.envelopeHash,
      keyCommitment: F.keyCommitment,
    });
    expect(journal.length).toBe(JOURNAL_LENGTH);
    expect(bytesToHex(journal)).toBe(F.journal);
    expect(journalDigest(journal)).toBe(F.journalDigest);
    expect(decodeJournal(journal).verdict).toBe(1);
    expect(bytesToHex(decryptEnvelope(env, b(F.key), ctx))).toBe(F.bundle);
  });

  it("referenceHash of empty bundle is tagged sha256", () => {
    expect(bytesToHex(encodeBundle([]))).toBe("0x010000");
    expect(referenceHash(b("0x010000"))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(referenceHash(b("0x010000"))).not.toBe(envelopeHash(b("0x010000")));
  });
});

describe("bundle edge cases", () => {
  const f = (name: string, c = ""): { name: string; content: Uint8Array } => ({ name, content: enc(c) });

  it("sorts by name bytes regardless of input order", () => {
    const one = encodeBundle([f("b"), f("B"), f("a"), f("_")]);
    const two = encodeBundle([f("_"), f("a"), f("B"), f("b")]);
    expect(one).toEqual(two);
    expect(decodeBundle(one).map((x) => x.name)).toEqual(["B", "_", "a", "b"]);
  });

  it("round-trips 16 files and binary content", () => {
    const files = Array.from({ length: 16 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}`, content: Uint8Array.of(i, 0, 255) }));
    expect(decodeBundle(encodeBundle(files))).toEqual(files);
  });

  it("encode errors", () => {
    for (const bad of ["", ".", "..", "a/b", "a b", "é", "x".repeat(129)]) expectCode(() => encodeBundle([f(bad)]), "bad_name");
    expect(() => encodeBundle([f("x".repeat(128))])).not.toThrow();
    expectCode(() => encodeBundle([f("a"), f("a")]), "duplicate_name");
    expectCode(() => encodeBundle(Array.from({ length: 17 }, (_, i) => f(`n${i}`))), "too_many_files");
  });

  it("decode errors", () => {
    expectCode(() => decodeBundle(b("0x020000")), "bad_version");
    expectCode(() => decodeBundle(new Uint8Array()), "bad_length");
    expectCode(() => decodeBundle(b("0x0100")), "bad_length");
    expectCode(() => decodeBundle(b(F.bundle).slice(0, -1)), "bad_length");
    expectCode(() => decodeBundle(b("0x010001")), "bad_length");
    expectCode(() => decodeBundle(b(`${F.bundle}00`)), "trailing_bytes");
    expectCode(() => decodeBundle(b("0x010011")), "too_many_files");
    // name "a/b"
    expectCode(() => decodeBundle(b("0x0100010003612f6200000000")), "bad_name");
    // name ".."
    expectCode(() => decodeBundle(b("0x01000100022e2e00000000")), "bad_name");
    // "b" then "a"
    expectCode(() => decodeBundle(b("0x01000200016200000000000161" + "00000000")), "unsorted");
    // "a" then "a"
    expectCode(() => decodeBundle(b("0x01000200016100000000000161" + "00000000")), "duplicate_name");
  });
});

describe("context and journal errors", () => {
  it("encodeContext bad_field", () => {
    expectCode(() => encodeContext({ ...F.fundedContext, chainId: -1n }), "bad_field");
    expectCode(() => encodeContext({ ...F.fundedContext, jobId: 1n << 256n }), "bad_field");
    expectCode(() => encodeContext({ ...F.fundedContext, escrow: "0x1234" }), "bad_field");
    expectCode(() => encodeContext({ ...F.fundedContext, provider: "0xzz22222222222222222222222222222222222222" }), "bad_field");
    expectCode(() => encodeContext({ ...F.fundedContext, rulesHash: "0x33" }), "bad_field");
    expectCode(() => encodeContext({ ...F.fundedContext, referenceHash: `0x${"4".repeat(63)}g` }), "bad_field");
    expect(bytesToHex(encodeContext({ ...F.fundedContext, chainId: (1n << 256n) - 1n }).subarray(1, 33))).toBe(`0x${"ff".repeat(32)}`);
  });

  it("decodeContext", () => {
    expectCode(() => decodeContext(new Uint8Array(168)), "bad_length");
    const ctx = encodeContext(F.fundedContext);
    ctx[0] = 2;
    expectCode(() => decodeContext(ctx), "bad_version");
  });

  it("journal", () => {
    const j = b(F.journal);
    expectCode(() => decodeJournal(j.slice(1)), "bad_length");
    const v = j.slice();
    v[0] = 0;
    expectCode(() => decodeJournal(v), "bad_version");
    const bad = j.slice();
    bad[169] = 2;
    expectCode(() => decodeJournal(bad), "bad_field");
    expectCode(() => journalDigest(j.slice(0, 200)), "bad_length");
    expectCode(
      () => encodeJournal({ context: F.fundedContext, verdict: 2 as 1, envelopeHash: F.envelopeHash, keyCommitment: F.keyCommitment }),
      "bad_field",
    );
    expectCode(() => encodeJournal({ context: F.fundedContext, verdict: 1, envelopeHash: "0x00", keyCommitment: F.keyCommitment }), "bad_field");
  });

  it("keyCommitment and decrypt lengths, auth_failed", () => {
    const ctx = b(F.context);
    expectCode(() => keyCommitment(ctx.slice(1), b(F.key)), "bad_length");
    expectCode(() => keyCommitment(ctx, b(F.key).slice(1)), "bad_length");
    expectCode(() => decryptEnvelope(new Uint8Array(27), b(F.key), ctx), "bad_length");
    expectCode(() => decryptEnvelope(b(F.envelope), new Uint8Array(31), ctx), "bad_length");
    expectCode(() => decryptEnvelope(b(F.envelope), b(F.key), ctx.slice(1)), "bad_length");
    expectCode(() => decryptEnvelope(b(F.envelope), new Uint8Array(32), ctx), "auth_failed");
    const otherCtx = encodeContext({ ...F.fundedContext, jobId: 8n });
    expectCode(() => decryptEnvelope(b(F.envelope), b(F.key), otherCtx), "auth_failed");
    // empty plaintext envelope is exactly 28 bytes
    const empty = encryptEnvelope(new Uint8Array(), b(F.key), b(F.nonce), ctx);
    expect(empty.length).toBe(28);
    expect(decryptEnvelope(empty, b(F.key), ctx).length).toBe(0);
  });
});

describe("parseProofJson", () => {
  const imageId = `0x${"ab".repeat(32)}` as Hex;
  const good = {
    version: 1,
    context: F.context,
    imageId,
    verdict: 1,
    envelope: F.envelope,
    keyCommitment: F.keyCommitment,
    journal: F.journal,
    seal: simulatedSeal(imageId, F.journalDigest),
  };

  it("accepts a good proof as object or string, with string numbers and upper-case hex", () => {
    const p = parseProofJson(good);
    expect(p.version).toBe(1);
    expect(p.verdict).toBe(1);
    expect(p.envelopeHash).toBe(F.envelopeHash);
    expect(p.journalDigest).toBe(F.journalDigest);
    expect(p.context.jobId).toBe(7n);
    expect(bytesToHex(p.contextBytes)).toBe(F.context);
    const p2 = parseProofJson(
      JSON.stringify({ ...good, version: "1", verdict: "1", envelope: `0x${F.envelope.slice(2).toUpperCase()}`, imageId: `0x${"AB".repeat(32)}` }),
    );
    expect(p2.imageId).toBe(imageId);
    expect(bytesToHex(p2.envelope)).toBe(F.envelope);
  });

  it("rejects bad inputs with the right codes", () => {
    for (const k of Object.keys(good)) {
      const copy: Record<string, unknown> = { ...good };
      delete copy[k];
      expectCode(() => parseProofJson(copy), "bad_field");
    }
    expectCode(() => parseProofJson("not json"), "bad_field");
    expectCode(() => parseProofJson(null), "bad_field");
    expectCode(() => parseProofJson({ ...good, version: 2 }), "bad_field");
    expectCode(() => parseProofJson({ ...good, version: true }), "bad_field");
    expectCode(() => parseProofJson({ ...good, verdict: 2 }), "bad_field");
    expectCode(() => parseProofJson({ ...good, verdict: "x" }), "bad_field");
    expectCode(() => parseProofJson({ ...good, envelope: 5 }), "bad_field");
    expectCode(() => parseProofJson({ ...good, envelope: "abcd" }), "bad_hex");
    expectCode(() => parseProofJson({ ...good, seal: "0xabc" }), "bad_hex");
    expectCode(() => parseProofJson({ ...good, journal: "0xzz" }), "bad_hex");
    expectCode(() => parseProofJson({ ...good, context: "0x01" }), "bad_length");
    expectCode(() => parseProofJson({ ...good, imageId: "0x01" }), "bad_length");
    expectCode(() => parseProofJson({ ...good, keyCommitment: "0x01" }), "bad_length");
    expectCode(() => parseProofJson({ ...good, verdict: 0 }), "mismatch");
    expectCode(() => parseProofJson({ ...good, envelope: `${F.envelope}00` }), "mismatch");
    expectCode(() => parseProofJson({ ...good, seal: `0xdeadbeef${"00".repeat(32)}` }), "bad_selector");
  });
});

describe("round-2 codec rulings", () => {
  it("encodeContext: lower/upper-case addresses ok, mixed case needs a valid EIP-55 checksum", () => {
    const good = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(() => encodeContext({ ...F.fundedContext, escrow: good })).not.toThrow();
    expect(() => encodeContext({ ...F.fundedContext, escrow: good.toLowerCase() as Hex })).not.toThrow();
    expect(() => encodeContext({ ...F.fundedContext, escrow: `0x${good.slice(2).toUpperCase()}` as Hex })).not.toThrow();
    expectCode(() => encodeContext({ ...F.fundedContext, escrow: "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }), "bad_field");
    expectCode(() => keyCommitment({ ...F.fundedContext, provider: "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, b(F.key)), "bad_field");
  });

  it("decodeBundle: truncation is reported before name validation; names before trailing bytes", () => {
    // count 1, nameLen 2, name "a/" (invalid), then truncated before u32 len -> bad_length, not bad_name
    expectCode(() => decodeBundle(b("0x0100010002612f")), "bad_length");
    // count 17 and truncated -> too_many_files first
    expectCode(() => decodeBundle(b("0x010011")), "too_many_files");
    // invalid name + trailing byte -> bad_name first
    expectCode(() => decodeBundle(b("0x0100010002612f0000000000")), "bad_name");
  });

  it("parseProofJson: settled order and new cases", () => {
    const imageId = `0x${"ab".repeat(32)}` as Hex;
    const good = { version: 1, context: F.context, imageId, verdict: 1, envelope: F.envelope, keyCommitment: F.keyCommitment, journal: F.journal, seal: simulatedSeal(imageId, F.journalDigest) };
    expectCode(() => parseProofJson({ ...good, seal: 5, envelope: "0xzz" }), "bad_field"); // type before hex
    expectCode(() => parseProofJson({ ...good, envelope: "0xzz", version: 2 }), "bad_hex"); // hex before version
    expectCode(() => parseProofJson({ ...good, version: 2, context: "0x01" }), "bad_field"); // version before sizes
    expectCode(() => parseProofJson({ ...good, context: "0x01", journal: "0x00" }), "bad_length"); // sizes before journal
    expectCode(() => parseProofJson({ ...good, journal: "0x00", seal: "0xdeadbeef" }), "mismatch"); // journal before selector
    expectCode(() => parseProofJson({ ...good, journal: F.journal.slice(0, -2) }), "mismatch");
    expectCode(() => parseProofJson({ ...good, context: `0x02${F.context.slice(4)}` }), "bad_version");
    expectCode(() => parseProofJson({ ...good, seal: null }), "bad_field");
    expectCode(() => parseProofJson({ ...good, envelope: F.envelope.slice(2) }), "bad_hex");
    expectCode(() => parseProofJson([]), "bad_field");
  });
});
