import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Hex } from "viem";
import { asciiBytes, concatBytes, sha256Hex } from "./bytes.ts";
import { CONTEXT_LENGTH, KEY_LENGTH, NONCE_LENGTH, TAG_KEY, TAG_LENGTH, TAG_REFERENCE } from "./constants.ts";
import { contextBytesOf } from "./context.ts";
import { CodecError } from "./errors.ts";
import type { FundedContext } from "./types.ts";

/** SHA256(envelope) */
export function envelopeHash(envelope: Uint8Array): Hex {
  return sha256Hex(envelope);
}

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTH) {
    throw new CodecError("bad_length", `key must be ${KEY_LENGTH} bytes`);
  }
}

/** SHA256(ASCII("UBC26/key/v1") ‖ context[169] ‖ key[32]) */
export function keyCommitment(context: Uint8Array | FundedContext, key: Uint8Array): Hex {
  const ctx = contextBytesOf(context);
  checkKey(key);
  return sha256Hex(concatBytes(asciiBytes(TAG_KEY), ctx, key));
}

/** SHA256(ASCII("UBC26/reference/v1") ‖ bundle) */
export function referenceHash(referenceBundle: Uint8Array): Hex {
  return sha256Hex(concatBytes(asciiBytes(TAG_REFERENCE), referenceBundle));
}

/** envelope = nonce[12] ‖ ciphertext ‖ tag[16]; ChaCha20-Poly1305 with AAD = context bytes. */
export function decryptEnvelope(
  envelope: Uint8Array,
  key: Uint8Array,
  context: Uint8Array | FundedContext,
): Uint8Array {
  if (!(envelope instanceof Uint8Array) || envelope.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new CodecError("bad_length", `envelope must be at least ${NONCE_LENGTH + TAG_LENGTH} bytes`);
  }
  checkKey(key);
  const ctx = contextBytesOf(context);
  if (ctx.length !== CONTEXT_LENGTH) throw new CodecError("bad_length", "context must be 169 bytes");
  const nonce = envelope.subarray(0, NONCE_LENGTH);
  const sealed = envelope.subarray(NONCE_LENGTH);
  try {
    return chacha20poly1305(key, nonce, ctx).decrypt(sealed);
  } catch {
    throw new CodecError("auth_failed", "envelope authentication failed");
  }
}

/** Test/fixture use only (exported via @ubc26/sdk/testing). Returns nonce ‖ ciphertext ‖ tag. */
export function encryptEnvelopeRaw(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  context: Uint8Array | FundedContext,
): Uint8Array {
  checkKey(key);
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_LENGTH) {
    throw new CodecError("bad_length", `nonce must be ${NONCE_LENGTH} bytes`);
  }
  const ctx = contextBytesOf(context);
  return concatBytes(nonce, chacha20poly1305(key, nonce, ctx).encrypt(plaintext));
}
