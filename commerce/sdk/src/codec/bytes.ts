// Small, browser-safe byte helpers shared by the codec.
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import type { Hex } from "viem";
import { CodecError } from "./errors.ts";
import type { CodecErrorCode } from "./errors.ts";

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_CHARS = "0123456789abcdef";

export function toHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 15]!;
  return out as Hex;
}

export function isStrictHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_RE.test(value);
}

/** Parses 0x hex (either case). Throws CodecError(code) on invalid hex. */
export function fromHex(value: string, code: CodecErrorCode = "bad_hex", what = "value"): Uint8Array {
  if (!HEX_RE.test(value)) throw new CodecError(code, `${what} is not 0x-prefixed even-length hex`);
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Parses a fixed-size hex value; wrong hex or wrong size both give `code`. */
export function fixedHex(value: unknown, size: number, code: CodecErrorCode, what: string): Uint8Array {
  if (typeof value !== "string") throw new CodecError(code, `${what} must be a hex string`);
  const bytes = fromHex(value, code, what);
  if (bytes.length !== size) throw new CodecError(code, `${what} must be ${size} bytes`);
  return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha256Hex(data: Uint8Array): Hex {
  return toHex(sha256(data));
}

export function uintToBytes(value: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let v = value;
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToUint(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Lexicographic compare of byte strings. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
