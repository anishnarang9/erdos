import { getAddress, isAddress } from "viem";
import type { Address } from "viem";
import { bytesToUint, fixedHex, toHex, uintToBytes } from "./bytes.ts";
import { CONTEXT_LENGTH, CONTEXT_VERSION } from "./constants.ts";
import { CodecError } from "./errors.ts";
import type { FundedContext } from "./types.ts";

const U256_LIMIT = 1n << 256n;

function u256(value: unknown, what: string): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= U256_LIMIT) {
    throw new CodecError("bad_field", `${what} must be a bigint in [0, 2^256)`);
  }
  return uintToBytes(value, 32);
}

/** All-lowercase or all-uppercase hex is accepted as is; mixed case must be a valid EIP-55 checksum. */
function address(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new CodecError("bad_field", `${what} is not a valid address`);
  }
  const body = value.slice(2);
  const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!singleCase && getAddress(value) !== value) {
    throw new CodecError("bad_field", `${what} has an invalid EIP-55 checksum`);
  }
  return fixedHex(value, 20, "bad_field", what);
}

/** 0x01 ‖ chainId[32] ‖ escrow[20] ‖ jobId[32] ‖ provider[20] ‖ rulesHash[32] ‖ referenceHash[32] */
export function encodeContext(ctx: FundedContext): Uint8Array {
  if (typeof ctx !== "object" || ctx === null) throw new CodecError("bad_field", "context must be an object");
  const out = new Uint8Array(CONTEXT_LENGTH);
  out[0] = CONTEXT_VERSION;
  out.set(u256(ctx.chainId, "chainId"), 1);
  out.set(address(ctx.escrow, "escrow"), 33);
  out.set(u256(ctx.jobId, "jobId"), 53);
  out.set(address(ctx.provider, "provider"), 85);
  out.set(fixedHex(ctx.rulesHash, 32, "bad_field", "rulesHash"), 105);
  out.set(fixedHex(ctx.referenceHash, 32, "bad_field", "referenceHash"), 137);
  return out;
}

export function decodeContext(bytes: Uint8Array): FundedContext {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CONTEXT_LENGTH) {
    throw new CodecError("bad_length", `context must be ${CONTEXT_LENGTH} bytes`);
  }
  if (bytes[0] !== CONTEXT_VERSION) throw new CodecError("bad_version", "context version must be 0x01");
  return {
    chainId: bytesToUint(bytes.subarray(1, 33)),
    escrow: getAddress(toHex(bytes.subarray(33, 53))) as Address,
    jobId: bytesToUint(bytes.subarray(53, 85)),
    provider: getAddress(toHex(bytes.subarray(85, 105))) as Address,
    rulesHash: toHex(bytes.subarray(105, 137)),
    referenceHash: toHex(bytes.subarray(137, 169)),
  };
}

/** Accepts encoded bytes or a FundedContext; returns the 169 bytes. */
export function contextBytesOf(context: Uint8Array | FundedContext): Uint8Array {
  if (context instanceof Uint8Array) {
    if (context.length !== CONTEXT_LENGTH) throw new CodecError("bad_length", `context must be ${CONTEXT_LENGTH} bytes`);
    return context;
  }
  return encodeContext(context);
}
