// CONTRACT.md §1 encodeContext / decodeContext (L55-56).
import { describe, it, expect } from "vitest";
import { encodeContext, decodeContext, CodecError } from "../../src/index.ts";
import { FIX_CONTEXT_HEX, FIX_CTX_OBJ, bytesOf, cat, hexOf, rand, refContextBytes, rep } from "./helpers.ts";

// EIP-55 spec test vector (mixed case checksum).
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const CHECKSUMMED2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const MAX = (1n << 256n) - 1n;

describe("CONTRACT §1 encodeContext (L55)", () => {
  it("L55 output is exactly 169 bytes with the documented layout", () => {
    const out = encodeContext(FIX_CTX_OBJ);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(169);
    expect(hexOf(out)).toBe(FIX_CONTEXT_HEX);
  });

  it("L55 layout with random fields matches independent encoder (20 cases)", () => {
    for (let i = 0; i < 20; i++) {
      const raw = {
        chainId: BigInt(hexOf(rand(8))),
        escrow: rand(20),
        jobId: BigInt(hexOf(rand(32))),
        provider: rand(20),
        rulesHash: rand(32),
        referenceHash: rand(32),
      };
      const ctx = {
        chainId: raw.chainId,
        escrow: hexOf(raw.escrow),
        jobId: raw.jobId,
        provider: hexOf(raw.provider),
        rulesHash: hexOf(raw.rulesHash),
        referenceHash: hexOf(raw.referenceHash),
      };
      expect(hexOf(encodeContext(ctx))).toBe(hexOf(refContextBytes(raw)));
    }
  });

  it("L55 boundary: chainId = jobId = 2^256-1 and 0 are accepted", () => {
    const hi = encodeContext({ ...FIX_CTX_OBJ, chainId: MAX, jobId: MAX });
    expect(hexOf(hi.slice(1, 33))).toBe(`0x${"ff".repeat(32)}`);
    expect(hexOf(hi.slice(53, 85))).toBe(`0x${"ff".repeat(32)}`);
    const lo = encodeContext({ ...FIX_CTX_OBJ, chainId: 0n, jobId: 0n });
    expect(hexOf(lo.slice(1, 33))).toBe(`0x${"00".repeat(32)}`);
  });

  it("L55 accepts checksummed and upper-case-hex hashes, encodes raw bytes", () => {
    const out = encodeContext({
      ...FIX_CTX_OBJ,
      escrow: CHECKSUMMED,
      rulesHash: `0x${"AB".repeat(32)}`,
    });
    expect(hexOf(out.slice(33, 53))).toBe(CHECKSUMMED.toLowerCase());
    expect(hexOf(out.slice(105, 137))).toBe(`0x${"ab".repeat(32)}`);
  });

  const bad: [string, Record<string, unknown>][] = [
    ["negative chainId", { chainId: -1n }],
    ["chainId = 2^256", { chainId: 1n << 256n }],
    ["negative jobId", { jobId: -1n }],
    ["jobId = 2^256", { jobId: 1n << 256n }],
    ["escrow too short", { escrow: "0x1234" }],
    ["escrow 21 bytes", { escrow: `0x${"11".repeat(21)}` }],
    ["escrow non-hex", { escrow: `0x${"zz".repeat(20)}` }],
    ["provider not an address", { provider: "hello" }],
    ["rulesHash 31 bytes", { rulesHash: `0x${"33".repeat(31)}` }],
    ["rulesHash 33 bytes", { rulesHash: `0x${"33".repeat(33)}` }],
    ["referenceHash 31 bytes", { referenceHash: `0x${"44".repeat(31)}` }],
    ["referenceHash non-hex", { referenceHash: `0x${"gg".repeat(32)}` }],
  ];
  for (const [label, patch] of bad) {
    it(`L55 bad_field: ${label}`, () => {
      let thrown: unknown;
      try {
        encodeContext({ ...FIX_CTX_OBJ, ...patch } as typeof FIX_CTX_OBJ);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(CodecError);
      expect((thrown as CodecError).code).toBe("bad_field");
    });
  }
});

describe("CONTRACT §1 decodeContext (L56)", () => {
  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(CodecError);
      return (e as CodecError).code;
    }
    return undefined;
  }

  it("L56 decodes the fixture context to the fixture fields", () => {
    const c = decodeContext(bytesOf(FIX_CONTEXT_HEX));
    expect(c).toEqual(FIX_CTX_OBJ);
    expect(typeof c.chainId).toBe("bigint");
    expect(typeof c.jobId).toBe("bigint");
  });

  it("L56 addresses are EIP-55 checksummed (spec vectors), hashes lowercase", () => {
    const raw = refContextBytes({
      chainId: 1n,
      escrow: bytesOf(CHECKSUMMED),
      jobId: 2n,
      provider: bytesOf(CHECKSUMMED2),
      rulesHash: rep(0xab, 32),
      referenceHash: rep(0xcd, 32),
    });
    const c = decodeContext(raw);
    expect(c.escrow).toBe(CHECKSUMMED);
    expect(c.provider).toBe(CHECKSUMMED2);
    expect(c.rulesHash).toBe(`0x${"ab".repeat(32)}`);
    expect(c.referenceHash).toBe(`0x${"cd".repeat(32)}`);
  });

  it("L56 round trip encode(decode(x)) == x for random contexts (20 cases)", () => {
    for (let i = 0; i < 20; i++) {
      const raw = cat(new Uint8Array([1]), rand(168));
      const c = decodeContext(raw);
      expect(c.rulesHash).toBe(c.rulesHash.toLowerCase());
      expect(c.referenceHash).toBe(c.referenceHash.toLowerCase());
      expect(hexOf(encodeContext(c))).toBe(hexOf(raw));
    }
  });

  it("L56 decode(encode(ctx)) normalises upper-case hash input to lowercase", () => {
    const c = decodeContext(encodeContext({ ...FIX_CTX_OBJ, rulesHash: `0x${"AB".repeat(32)}` }));
    expect(c.rulesHash).toBe(`0x${"ab".repeat(32)}`);
  });

  it("L56 bad_length for 168 bytes", () => {
    expect(codeOf(() => decodeContext(bytesOf(FIX_CONTEXT_HEX).slice(0, 168)))).toBe("bad_length");
  });
  it("L56 bad_length for 170 bytes", () => {
    expect(codeOf(() => decodeContext(cat(bytesOf(FIX_CONTEXT_HEX), new Uint8Array([0]))))).toBe("bad_length");
  });
  it("L56 bad_length for 0 bytes", () => {
    expect(codeOf(() => decodeContext(new Uint8Array(0)))).toBe("bad_length");
  });
  it("L56 bad_version when first byte is 0x02", () => {
    const b = bytesOf(FIX_CONTEXT_HEX);
    b[0] = 2;
    expect(codeOf(() => decodeContext(b))).toBe("bad_version");
  });
  it("L56 bad_version when first byte is 0x00", () => {
    const b = bytesOf(FIX_CONTEXT_HEX);
    b[0] = 0;
    expect(codeOf(() => decodeContext(b))).toBe("bad_version");
  });
});
