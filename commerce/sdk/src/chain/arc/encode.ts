// Context and ABI parameter encoders. Browser-safe. Byte layouts come from the SDK codec
// (../../codec); only the two ABI-encoded `optParams` blobs are built here.
import { encodeAbiParameters, getAddress, hexToBytes, isAddress, isAddressEqual, isHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { encodeContext } from "../../codec/context.ts";
import { keyCommitment as codecKeyCommitment } from "../../codec/crypto.ts";
import type { Deployment } from "./deployment.ts";
import { ArcError } from "./errors.ts";
import type { Job, Terms } from "./reads.ts";

const UINT256_LIMIT = 1n << 256n;

function badInput(what: string): never {
  throw new ArcError("bad_input", what);
}

export function requireBytes32(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !isHex(v, { strict: true }) || v.length !== 66) return badInput(`${what} must be 32 bytes of 0x hex`);
  return v;
}

export function requireBytes(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !isHex(v, { strict: true }) || v.length % 2 !== 0) return badInput(`${what} must be 0x hex with whole bytes`);
  return v;
}

export function requireUint(v: unknown, what: string, min = 0n): bigint {
  if (typeof v !== "bigint" || v < min || v >= UINT256_LIMIT) return badInput(`${what} must be a bigint in [${min}, 2^256)`);
  return v;
}

/**
 * A non-zero address, returned checksummed. All-lowercase and all-uppercase hex are accepted as they
 * are; mixed case must be a valid EIP-55 checksum (the rule of the SDK codec).
 */
export function requireAddress(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) return badInput(`${what} is not an address`);
  const body = v.slice(2);
  const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!singleCase && getAddress(v) !== v) return badInput(`${what} has an invalid EIP-55 checksum`);
  if (isAddressEqual(v, zeroAddress)) return badInput(`${what} is the zero address`);
  return getAddress(v);
}

/**
 * The 169-byte funded context for a job, from confirmed chain state: `readJob` and `readTerms`.
 * It equals `hook.contextOf(jobId)`: version 1, the chain ID, escrow = the core proxy address, the
 * job ID, and the provider, rules hash and reference hash the hook froze at fund.
 *
 * Throws ArcError("not_found") while the hook has no frozen terms for the job, and
 * ArcError("bad_input") when the job does not use this deployment's hook or the two reads disagree.
 */
export function contextForJob(d: Deployment, job: Job, terms: Terms): Uint8Array {
  if (!terms.frozen) throw new ArcError("not_found", `job ${job.id} has no frozen terms (it is not funded through the hook)`);
  if (!isAddressEqual(job.hook, d.hook)) badInput(`job ${job.id} uses hook ${job.hook}, not the SettlementHook ${d.hook}`);
  if (!isAddressEqual(job.provider, terms.provider)) badInput(`job ${job.id}: the core's provider differs from the hook's frozen provider`);
  return encodeContext({
    chainId: BigInt(d.chainId),
    escrow: d.core,
    jobId: job.id,
    provider: terms.provider,
    rulesHash: terms.rulesHash,
    referenceHash: terms.referenceHash,
  });
}

/** `optParams` of `core.fund`: exactly `abi.encode(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash)` (96 bytes). */
export function fundOptParams(imageId: Hex, rulesHash: Hex, referenceHash: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [requireBytes32(imageId, "imageId"), requireBytes32(rulesHash, "rulesHash"), requireBytes32(referenceHash, "referenceHash")],
  );
}

/**
 * `optParams` of `core.submit`: `abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment)`.
 * The `deliverable` argument of `submit` is SHA256(envelope) and is not part of this blob.
 */
export function submitOptParams(envelope: Hex, seal: Hex, keyCommitment: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }],
    [requireBytes(envelope, "envelope"), requireBytes(seal, "seal"), requireBytes32(keyCommitment, "keyCommitment")],
  );
}

/**
 * Checks a release key against the accepted commitment locally: the key is sent nowhere.
 * `context` is `contextForJob(...)`; `keyCommitment` is `readSubmission(...).keyCommitment`.
 */
export function releaseKeyMatches(context: Uint8Array, key: Hex, keyCommitment: Hex): boolean {
  return codecKeyCommitment(context, hexToBytes(requireBytes32(key, "key"))) === requireBytes32(keyCommitment, "keyCommitment").toLowerCase();
}
