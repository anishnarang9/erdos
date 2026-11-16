// CONTRACT.md §1 decryptEnvelope (L65) and testing.encryptEnvelope (L78).
import { describe, it, expect } from "vitest";
import { decryptEnvelope, encodeContext, decodeBundle, CodecError } from "../../src/index.ts";
import { encryptEnvelope } from "../../src/testing/index.ts";
import { FIX, FIX_CTX_OBJ, FIX_HEX, bytesOf, cat, fixContextBytes, hexOf, rand, refEncrypt } from "./helpers.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CodecError);
    return (e as CodecError).code;
  }
  return undefined;
}

const env = () => bytesOf(FIX_HEX.envelope);

describe("CONTRACT §1 decryptEnvelope (L65)", () => {
  it("L65 fixture envelope decrypts to the fixture bundle (a.txt = ok)", () => {
    const pt = decryptEnvelope(env(), FIX.key, fixContextBytes());
    expect(hexOf(pt)).toBe(FIX_HEX.bundle);
    const files = decodeBundle(pt);
    expect(files.map((x) => x.name)).toEqual(["a.txt"]);
    expect(Buffer.from(files[0]!.content).toString("ascii")).toBe("ok");
  });

  it("L65 auth_failed on any single flipped bit in nonce, ciphertext or tag", () => {
    const base = env();
    for (const idx of [0, 11, 12, 13, base.length - 17, base.length - 16, base.length - 1]) {
      const e = new Uint8Array(base);
      e[idx]! ^= 0x01;
      expect(codeOf(() => decryptEnvelope(e, FIX.key, fixContextBytes())), `idx=${idx}`).toBe("auth_failed");
    }
  });

  it("L65 auth_failed with wrong key", () => {
    const k = new Uint8Array(FIX.key);
    k[31]! ^= 0x80;
    expect(codeOf(() => decryptEnvelope(env(), k, fixContextBytes()))).toBe("auth_failed");
  });

  it("L65 auth_failed with wrong AAD (context with jobId 8 instead of 7)", () => {
    const other = encodeContext({ ...FIX_CTX_OBJ, jobId: 8n });
    expect(codeOf(() => decryptEnvelope(env(), FIX.key, other))).toBe("auth_failed");
  });

  it("L65 auth_failed with wrong AAD (context with different chainId)", () => {
    const other = encodeContext({ ...FIX_CTX_OBJ, chainId: 31337n });
    expect(codeOf(() => decryptEnvelope(env(), FIX.key, other))).toBe("auth_failed");
  });

  it("L65 bad_length: envelope 27 bytes; 28 bytes (empty plaintext) is length-ok", () => {
    expect(codeOf(() => decryptEnvelope(rand(27), FIX.key, fixContextBytes()))).toBe("bad_length");
    expect(codeOf(() => decryptEnvelope(new Uint8Array(0), FIX.key, fixContextBytes()))).toBe("bad_length");
    // 28 random bytes: well-formed length, so the only possible failure is authentication.
    expect(codeOf(() => decryptEnvelope(rand(28), FIX.key, fixContextBytes()))).toBe("auth_failed");
  });

  it("L65 28-byte envelope of an empty plaintext decrypts to empty", () => {
    const e = refEncrypt(new Uint8Array(0), FIX.key, FIX.nonce, fixContextBytes());
    expect(e.length).toBe(28);
    expect(decryptEnvelope(e, FIX.key, fixContextBytes()).length).toBe(0);
  });

  it("L65 bad_length: key 31 / 33 bytes", () => {
    expect(codeOf(() => decryptEnvelope(env(), FIX.key.slice(0, 31), fixContextBytes()))).toBe("bad_length");
    expect(codeOf(() => decryptEnvelope(env(), cat(FIX.key, new Uint8Array([0])), fixContextBytes()))).toBe("bad_length");
  });

  it("L65 bad_length: context 168 / 170 bytes", () => {
    expect(codeOf(() => decryptEnvelope(env(), FIX.key, fixContextBytes().slice(0, 168)))).toBe("bad_length");
    expect(codeOf(() => decryptEnvelope(env(), FIX.key, cat(fixContextBytes(), new Uint8Array([0]))))).toBe("bad_length");
  });

  it("L65 decrypts envelopes produced independently by node:crypto (50 random cases)", () => {
    for (let i = 0; i < 50; i++) {
      const pt = rand(Math.floor(Math.random() * 2048));
      const key = rand(32);
      const nonce = rand(12);
      const ctx = cat(new Uint8Array([1]), rand(168));
      const e = refEncrypt(pt, key, nonce, ctx);
      expect(hexOf(decryptEnvelope(e, key, ctx))).toBe(hexOf(pt));
    }
  });
});

describe("CONTRACT §1 testing.encryptEnvelope (L78)", () => {
  it("L78 returns nonce||ciphertext||tag equal to node:crypto output (50 random cases)", () => {
    for (let i = 0; i < 50; i++) {
      const pt = rand(Math.floor(Math.random() * 2048));
      const key = rand(32);
      const nonce = rand(12);
      const ctx = cat(new Uint8Array([1]), rand(168));
      const got = encryptEnvelope(pt, key, nonce, ctx);
      expect(got.length).toBe(12 + pt.length + 16);
      expect(hexOf(got.slice(0, 12))).toBe(hexOf(nonce));
      expect(hexOf(got)).toBe(hexOf(refEncrypt(pt, key, nonce, ctx)));
    }
  });
  it("L78 fixture inputs reproduce the fixture envelope", () => {
    expect(hexOf(encryptEnvelope(bytesOf(FIX_HEX.bundle), FIX.key, FIX.nonce, fixContextBytes()))).toBe(FIX_HEX.envelope);
  });
});
