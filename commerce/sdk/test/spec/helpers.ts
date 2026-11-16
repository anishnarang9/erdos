// Independent reference implementations for the spec suite (TESTER 1).
// Derived only from CONTRACT.md and ZKVM-IMPLEMENTATION.md §2-3, using node:crypto + Buffer.
// Never call the SDK from here to produce an expected value.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";

export const SELECTOR = "e71e6620";

export function hexOf(b: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(b).toString("hex")}`;
}

export function bytesOf(h: string): Uint8Array {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`bad test hex ${h}`);
  return new Uint8Array(Buffer.from(s, "hex"));
}

export function rep(byte: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}

export function cat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function sha256Hex(...parts: Uint8Array[]): `0x${string}` {
  return hexOf(sha256(...parts));
}

export function ascii(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "ascii"));
}

export function u256(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function u16be(n: number): Uint8Array {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return new Uint8Array(b);
}

export function u32be(n: number): Uint8Array {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return new Uint8Array(b);
}

export interface RefContext {
  chainId: bigint;
  escrow: Uint8Array; // 20
  jobId: bigint;
  provider: Uint8Array; // 20
  rulesHash: Uint8Array; // 32
  referenceHash: Uint8Array; // 32
}

export function refContextBytes(c: RefContext): Uint8Array {
  return cat(
    new Uint8Array([1]),
    u256(c.chainId),
    c.escrow,
    u256(c.jobId),
    c.provider,
    c.rulesHash,
    c.referenceHash,
  );
}

/** Bundle encoder per contract: sort by name BYTES (Buffer.compare), no validation. */
export function refBundle(files: { name: string; content: Uint8Array }[]): Uint8Array {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.name, "ascii"), Buffer.from(b.name, "ascii")));
  const parts: Uint8Array[] = [new Uint8Array([1]), u16be(sorted.length)];
  for (const f of sorted) {
    const n = ascii(f.name);
    parts.push(u16be(n.length), n, u32be(f.content.length), f.content);
  }
  return cat(...parts);
}

/** Raw bundle builder that keeps the given order (for malformed-input tests). */
export function rawBundle(records: { name: string; content: Uint8Array }[], count = records.length, version = 1): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([version]), u16be(count)];
  for (const f of records) {
    const n = ascii(f.name);
    parts.push(u16be(n.length), n, u32be(f.content.length), f.content);
  }
  return cat(...parts);
}

export function refKeyCommitment(context: Uint8Array, key: Uint8Array): `0x${string}` {
  return sha256Hex(ascii("UBC26/key/v1"), context, key);
}

export function refReferenceHash(bundle: Uint8Array): `0x${string}` {
  return sha256Hex(ascii("UBC26/reference/v1"), bundle);
}

export function refJournal(context: Uint8Array, verdict: number, envHash: Uint8Array, keyCommit: Uint8Array): Uint8Array {
  return cat(context, new Uint8Array([verdict]), envHash, keyCommit);
}

export function refEncrypt(plaintext: Uint8Array, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Uint8Array {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return cat(nonce, ct, c.getAuthTag());
}

export function refSimulatedSeal(imageId: Uint8Array, journalDigest: Uint8Array): `0x${string}` {
  return `0x${SELECTOR}${Buffer.from(sha256(imageId, journalDigest)).toString("hex")}`;
}

export function rand(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

/** Engine fixture (ZKVM-IMPLEMENTATION §3), as raw bytes. */
export const FIX = {
  chainId: 5042002n,
  jobId: 7n,
  escrow: rep(0x11, 20),
  provider: rep(0x22, 20),
  rulesHash: rep(0x33, 32),
  referenceHash: rep(0x44, 32),
  verdict: 1 as const,
  key: rep(0x55, 32),
  nonce: rep(0x66, 12),
} as const;

export const FIX_HEX = {
  bundle: "0x0100010005612e747874000000026f6b",
  envelope: "0x666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556",
  envelopeHash: "0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6",
  keyCommitment: "0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d",
  journalDigest: "0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e",
} as const;

export const FIX_CONTEXT_HEX =
  "0x01" +
  "00".repeat(29) +
  "4cef52" +
  "11".repeat(20) +
  "00".repeat(31) +
  "07" +
  "22".repeat(20) +
  "33".repeat(32) +
  "44".repeat(32);

export function fixContextBytes(): Uint8Array {
  return refContextBytes(FIX);
}

/** FundedContext-shaped object (checksummed addresses where they differ from lowercase). */
export const FIX_CTX_OBJ = {
  chainId: 5042002n,
  escrow: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  jobId: 7n,
  provider: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  rulesHash: `0x${"33".repeat(32)}` as `0x${string}`,
  referenceHash: `0x${"44".repeat(32)}` as `0x${string}`,
};

/** Asserts fn throws an error whose `code` equals `code` and whose name/class looks like CodecError. */
export function expectCode(fn: () => unknown, code: string, ErrClass?: abstract new (...a: never[]) => Error): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected throw with code ${code}`).toBeInstanceOf(Error);
  if (ErrClass) expect(thrown).toBeInstanceOf(ErrClass);
  expect((thrown as { code?: unknown }).code).toBe(code);
}

export function u8eq(a: Uint8Array, b: Uint8Array): void {
  expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
}
