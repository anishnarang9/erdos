// Byte encoders for the settlement wire formats. They must stay byte-identical to
// SETTLEMENT-IMPLEMENTATION.md Section 7 and ZKVM-IMPLEMENTATION.md Section 3, and to
// contracts/src/SettlementCodec.sol:
//
//   context       = 0x01 || chainId[32] || escrow[20] || jobId[32] || provider[20]
//                   || rulesHash[32] || referenceHash[32]                         (169 bytes)
//   journal       = context || verdict[1] || envelopeHash[32] || keyCommitment[32] (234 bytes)
//   journalDigest = SHA256(journal)
//   keyCommitment = SHA256("UBC26/key/v1" || context || key[32])
import {
  concat,
  encodeAbiParameters,
  hexToBytes,
  isAddress,
  isHex,
  numberToHex,
  sha256,
  size,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const CONTEXT_VERSION = "0x01" as const;
export const CONTEXT_LENGTH = 169;
export const JOURNAL_LENGTH = 234;
export const VERDICT_PASS = 1;
export const KEY_DOMAIN = "UBC26/key/v1";

export interface ContextFields {
  /** Chain where the core runs (5042002 on Arc Testnet). */
  chainId: bigint | number;
  /** The core proxy address (`escrow`). */
  escrow: Address;
  jobId: bigint | number;
  /** The funded Solver (ERC-8183 `provider`). */
  provider: Address;
  rulesHash: Hex;
  referenceHash: Hex;
}

function requireBytes(name: string, value: Hex, length: number): void {
  if (!isHex(value, { strict: true }) || size(value) !== length) {
    throw new Error(`${name} must be ${length} bytes of 0x-prefixed hex, got ${String(value)}`);
  }
}

function requireAddress(name: string, value: Address): void {
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is not an address: ${String(value)}`);
}

function uint256Bytes(name: string, value: bigint | number): Hex {
  const v = BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new Error(`${name} out of uint256 range`);
  return numberToHex(v, { size: 32 });
}

/** The 169-byte funded context. */
export function buildContext(f: ContextFields): Hex {
  requireAddress("escrow", f.escrow);
  requireAddress("provider", f.provider);
  requireBytes("rulesHash", f.rulesHash, 32);
  requireBytes("referenceHash", f.referenceHash, 32);
  const ctx = concat([
    CONTEXT_VERSION,
    uint256Bytes("chainId", f.chainId),
    f.escrow,
    uint256Bytes("jobId", f.jobId),
    f.provider,
    f.rulesHash,
    f.referenceHash,
  ]);
  if (size(ctx) !== CONTEXT_LENGTH) throw new Error("context length bug");
  return ctx;
}

/** The 234-byte journal. `verdict` is 1 for a pass; the hook only accepts verdict 1. */
export function buildJournal(context: Hex, verdict: number, envelopeHash: Hex, keyCommitment: Hex): Hex {
  requireBytes("context", context, CONTEXT_LENGTH);
  requireBytes("envelopeHash", envelopeHash, 32);
  requireBytes("keyCommitment", keyCommitment, 32);
  if (!Number.isInteger(verdict) || verdict < 0 || verdict > 255) throw new Error("verdict must be one byte");
  const journal = concat([context, numberToHex(verdict, { size: 1 }), envelopeHash, keyCommitment]);
  if (size(journal) !== JOURNAL_LENGTH) throw new Error("journal length bug");
  return journal;
}

/** SHA-256 of the journal: the `journalDigest` the verifier checks the seal against. */
export function journalDigest(journal: Hex): Hex {
  requireBytes("journal", journal, JOURNAL_LENGTH);
  return sha256(journal);
}

/** SHA-256 of the envelope: the `deliverable` argument of `submit`. */
export function envelopeHash(envelope: Hex): Hex {
  if (!isHex(envelope, { strict: true })) throw new Error("envelope must be 0x-prefixed hex");
  return sha256(envelope);
}

/** `SHA256("UBC26/key/v1" || context || key)`. Commits the Solver to the envelope key. */
export function keyCommitment(context: Hex, key: Hex): Hex {
  requireBytes("context", context, CONTEXT_LENGTH);
  requireBytes("key", key, 32);
  return sha256(concat([stringToHex(KEY_DOMAIN), context, key]));
}

/** `optParams` for `core.fund`: exactly `abi.encode(bytes32, bytes32, bytes32)` (96 bytes). */
export function fundOptParams(imageId: Hex, rulesHash: Hex, referenceHash: Hex): Hex {
  requireBytes("imageId", imageId, 32);
  requireBytes("rulesHash", rulesHash, 32);
  requireBytes("referenceHash", referenceHash, 32);
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [imageId, rulesHash, referenceHash],
  );
}

/**
 * `optParams` for `core.submit`: `abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment)`.
 * The `deliverable` argument of `submit` is `envelopeHash(envelope)`, not part of this blob.
 * `seal` is the 260-byte Groth16 seal (4-byte selector 0xe71e6620 plus 256 bytes).
 */
export function submitOptParams(envelope: Hex, seal: Hex, commitment: Hex): Hex {
  if (!isHex(envelope, { strict: true })) throw new Error("envelope must be 0x-prefixed hex");
  if (!isHex(seal, { strict: true })) throw new Error("seal must be 0x-prefixed hex");
  requireBytes("keyCommitment", commitment, 32);
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }],
    [envelope, seal, commitment],
  );
}

/** Convenience for tests and tooling: raw bytes of a hex string. */
export function toBytes(hex: Hex): Uint8Array {
  return hexToBytes(hex);
}
