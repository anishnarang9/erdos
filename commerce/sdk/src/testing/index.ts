// Test-only helpers and SIMULATED fixtures (CONTRACT.md §1 "Testing helpers").
// Never import this module from production paths.
import type { Address, Hex } from "viem";
import { concatBytes, fixedHex, sha256Hex } from "../codec/bytes.ts";
import { SEAL_SELECTOR } from "../codec/constants.ts";
import { encryptEnvelopeRaw } from "../codec/crypto.ts";
import type { FundedContext } from "../codec/types.ts";

/** nonce ‖ ciphertext ‖ tag. The real envelope is produced inside the guest; this is for tests only. */
export function encryptEnvelope(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  context: Uint8Array | FundedContext,
): Uint8Array {
  return encryptEnvelopeRaw(plaintext, key, nonce, context);
}

/** SIMULATED: 0xe71e6620 ‖ SHA256(imageId[32] ‖ journalDigest[32]); accepted by MockRiscZeroVerifier. */
export function simulatedSeal(imageId: Hex, journalDigest: Hex): Hex {
  const img = fixedHex(imageId, 32, "bad_field", "imageId");
  const digest = fixedHex(journalDigest, 32, "bad_field", "journalDigest");
  return `${SEAL_SELECTOR}${sha256Hex(concatBytes(img, digest)).slice(2)}` as Hex;
}

const rep = (byte: string, n: number): string => byte.repeat(n);

const escrow = `0x${rep("11", 20)}` as Address;
const provider = `0x${rep("22", 20)}` as Address;
const rulesHash = `0x${rep("33", 32)}` as Hex;
const referenceHash = `0x${rep("44", 32)}` as Hex;
const envelopeHash = "0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6" as Hex;
const keyCommitment = "0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d" as Hex;
const context = `0x01${rep("00", 29)}4cef52${rep("11", 20)}${rep("00", 31)}07${rep("22", 20)}${rep("33", 32)}${rep("44", 32)}` as Hex;

/** Synthetic engine fixture from ZKVM-IMPLEMENTATION §3. Byte values are lowercase 0x hex. */
export const ENGINE_FIXTURE = {
  chainId: 5042002n,
  jobId: 7n,
  escrow,
  provider,
  rulesHash,
  referenceHash,
  verdict: 1 as const,
  key: `0x${rep("55", 32)}` as Hex,
  nonce: `0x${rep("66", 12)}` as Hex,
  fundedContext: { chainId: 5042002n, escrow, jobId: 7n, provider, rulesHash, referenceHash } satisfies FundedContext,
  files: [{ name: "a.txt", content: "0x6f6b" as Hex }],
  context,
  bundle: "0x0100010005612e747874000000026f6b" as Hex,
  plaintext: "0x0100010005612e747874000000026f6b" as Hex,
  envelope: "0x666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556" as Hex,
  envelopeHash,
  keyCommitment,
  journal: `${context}01${envelopeHash.slice(2)}${keyCommitment.slice(2)}` as Hex,
  journalDigest: "0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e" as Hex,
} as const;
