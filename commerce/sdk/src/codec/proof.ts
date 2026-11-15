import type { Hex } from "viem";
import { equalBytes, fromHex, sha256Hex, toHex } from "./bytes.ts";
import { CONTEXT_LENGTH, SEAL_SELECTOR } from "./constants.ts";
import { decodeContext } from "./context.ts";
import { CodecError } from "./errors.ts";
import { encodeJournal } from "./journal.ts";
import type { ProofPackage } from "./types.ts";

const REQUIRED = ["version", "context", "imageId", "verdict", "envelope", "keyCommitment", "journal", "seal"] as const;

function smallInt(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new CodecError("bad_field", `${field} must be an integer`);
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  throw new CodecError("bad_field", `${field} must be a number or decimal string`);
}

function hexField(obj: Record<string, unknown>, field: string): Uint8Array {
  const value = obj[field];
  if (typeof value !== "string") throw new CodecError("bad_field", `${field} must be a hex string`);
  return fromHex(value, "bad_hex", field);
}

function sized(bytes: Uint8Array, size: number, field: string): Uint8Array {
  if (bytes.length !== size) throw new CodecError("bad_length", `${field} must be ${size} bytes`);
  return bytes;
}

/**
 * Parses and checks an engine `proof.json` (object or JSON string).
 * Order of checks: presence/type → hex → version/verdict → sizes → context → journal → seal selector.
 */
export function parseProofJson(json: unknown): ProofPackage {
  let raw: unknown = json;
  if (typeof json === "string") {
    try {
      raw = JSON.parse(json);
    } catch {
      throw new CodecError("bad_field", "proof is not valid JSON");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CodecError("bad_field", "proof must be an object");
  }
  const obj = raw as Record<string, unknown>;
  for (const field of REQUIRED) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      throw new CodecError("bad_field", `missing field ${field}`);
    }
  }

  const version = smallInt(obj.version, "version");
  const verdict = smallInt(obj.verdict, "verdict");
  const contextBytes = hexField(obj, "context");
  const imageIdBytes = hexField(obj, "imageId");
  const envelope = hexField(obj, "envelope");
  const keyCommitmentBytes = hexField(obj, "keyCommitment");
  const journal = hexField(obj, "journal");
  const sealBytes = hexField(obj, "seal");

  if (version !== 1) throw new CodecError("bad_field", "version must be 1");
  if (verdict !== 0 && verdict !== 1) throw new CodecError("bad_field", "verdict must be 0 or 1");

  sized(contextBytes, CONTEXT_LENGTH, "context");
  sized(imageIdBytes, 32, "imageId");
  sized(keyCommitmentBytes, 32, "keyCommitment");

  const context = decodeContext(contextBytes);
  const envHash = sha256Hex(envelope);
  const keyCommitment = toHex(keyCommitmentBytes);
  const expected = encodeJournal({ context, verdict, envelopeHash: envHash, keyCommitment });
  if (!equalBytes(expected, journal)) throw new CodecError("mismatch", "journal does not match proof fields");

  const seal = toHex(sealBytes);
  if (!seal.startsWith(SEAL_SELECTOR)) throw new CodecError("bad_selector", `seal must start with ${SEAL_SELECTOR}`);

  return {
    version: 1,
    context,
    contextBytes,
    imageId: toHex(imageIdBytes),
    verdict,
    envelope,
    envelopeHash: envHash,
    keyCommitment,
    journal,
    journalDigest: sha256Hex(journal) as Hex,
    seal,
  };
}
