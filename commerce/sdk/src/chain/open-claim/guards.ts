import { getAddress, isAddress, isAddressEqual, zeroAddress, zeroHash } from "viem";
import type { Address, Hex } from "viem";
import { OpenClaimError } from "./errors.ts";
import type { OpenClaimErrorCode } from "./errors.ts";
import { OPEN_CLAIM_MAX_ENVELOPE_BYTES, OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC } from "./signature-abi.ts";
import type { OpenClaimApproval, OpenClaimDeployment, OpenClaimObservation } from "./types.ts";

const SIGNER_KEYS = ["wallet", "privateKey", "account", "sign", "broadcast", "signer"] as const;
const U64 = 1n << 64n;
const U256 = 1n << 256n;

export interface NormalizedDeployment {
  chainId: number;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
}

export interface NormalizedApproval extends OpenClaimApproval {
  buyer: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
}

export function assertUnsigned(input: object): void {
  const record = input as Record<string, unknown>;
  for (const key of SIGNER_KEYS) {
    if (record[key] != null) {
      throw new OpenClaimError("unsafe_signer", "open-claim client returns unsigned transactions and does not sign");
    }
  }
}

export function assertEvidence(evidence: string): void {
  if (evidence !== "exported-abi") {
    throw new OpenClaimError("abi_mismatch", "exported OpenClaimAdapter ABI evidence is required");
  }
}

export function addressOf(value: string, code: OpenClaimErrorCode, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new OpenClaimError(code, `${field} is not an address`);
  const out = getAddress(value);
  if (out === zeroAddress) throw new OpenClaimError(code, `${field} is the zero address`);
  return out;
}

export function bytes32(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new OpenClaimError("unsupported_terms", `${field} must be 32 bytes`);
  const lower = value.toLowerCase() as Hex;
  if (lower === zeroHash) throw new OpenClaimError("unsupported_terms", `${field} must be nonzero`);
  return lower;
}

export function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function deploymentOf(input: OpenClaimDeployment): NormalizedDeployment {
  if (input.mode !== "open-claim") {
    throw new OpenClaimError("unsupported_deployment", "open-claim requires explicit mode open-claim");
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new OpenClaimError("unsupported_deployment", "chain id is unsupported");
  }
  const core = addressOf(input.core, "unsupported_deployment", "core");
  const adapter = addressOf(input.adapter, "unsupported_deployment", "adapter");
  const verifier = addressOf(input.verifier, "unsupported_deployment", "verifier");
  const usdc = addressOf(input.usdc, "unsupported_deployment", "usdc");
  const pins = [core, adapter, verifier, usdc];
  if (new Set(pins.map((pin) => pin.toLowerCase())).size !== pins.length) {
    throw new OpenClaimError("unsupported_deployment", "core, adapter, verifier, and usdc must be distinct");
  }
  return { chainId: input.chainId, core, adapter, verifier, usdc };
}

export function observationMatches(deployment: NormalizedDeployment, observation: OpenClaimObservation | undefined): void {
  if (observation == null) throw new OpenClaimError("unsupported_deployment", "deployment observation is required");
  if (observation.chainId !== deployment.chainId) {
    throw new OpenClaimError("unsupported_deployment", "observed chain id does not match the deployment");
  }
  if (observation.adapterCode !== "present") {
    throw new OpenClaimError("unsupported_deployment", "adapter code was not observed");
  }
  if (observation.evaluatorFeeBP !== 0n || observation.platformFeeBP !== 0n) {
    throw new OpenClaimError("unsupported_deployment", "core fees must be zero");
  }
  if (observation.maxEnvelopeBytes !== BigInt(OPEN_CLAIM_MAX_ENVELOPE_BYTES)) {
    throw new OpenClaimError("unsupported_deployment", "adapter envelope cap does not match the published checkpoint");
  }
  if (observation.minExpiryMargin !== BigInt(OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC)) {
    throw new OpenClaimError("unsupported_deployment", "adapter expiry margin does not match the published checkpoint");
  }
  const token = addressOf(observation.token, "unsupported_deployment", "token");
  const adapterCore = addressOf(observation.adapterCore, "unsupported_deployment", "adapter core");
  const adapterVerifier = addressOf(observation.adapterVerifier, "unsupported_deployment", "adapter verifier");
  const adapterUsdc = addressOf(observation.adapterUsdc, "unsupported_deployment", "adapter usdc");
  if (!isAddressEqual(token, deployment.usdc) || !isAddressEqual(adapterCore, deployment.core) ||
      !isAddressEqual(adapterVerifier, deployment.verifier) || !isAddressEqual(adapterUsdc, deployment.usdc)) {
    throw new OpenClaimError("unsupported_deployment", "observed wiring does not match the deployment pins");
  }
}

export function approvalOf(input: OpenClaimApproval, now: bigint, deployment: NormalizedDeployment): NormalizedApproval {
  if (typeof input.revision !== "string" || input.revision.length === 0) {
    throw new OpenClaimError("unsupported_terms", "approval revision is required");
  }
  if (typeof input.description !== "string" || input.description.length === 0) {
    throw new OpenClaimError("unsupported_terms", "job description is required");
  }
  if (typeof now !== "bigint" || typeof input.budget !== "bigint" || typeof input.expiry !== "bigint") {
    throw new OpenClaimError("unsupported_terms", "budget, expiry, and time must be bigints");
  }
  if (input.budget <= 0n || input.budget >= U256) throw new OpenClaimError("unsupported_terms", "budget is unsupported");
  if (input.expiry < 0n || input.expiry >= U64) throw new OpenClaimError("unsupported_terms", "expiry must fit uint64");
  if (input.expiry < now + BigInt(OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC)) {
    throw new OpenClaimError("unsupported_terms", "expiry does not leave the 600 second margin");
  }
  const buyer = addressOf(input.buyer, "unsupported_terms", "buyer");
  if ([deployment.core, deployment.adapter, deployment.verifier, deployment.usdc].some((pin) => isAddressEqual(pin, buyer))) {
    throw new OpenClaimError("unsupported_terms", "buyer must be distinct from the deployment pins");
  }
  return {
    revision: input.revision,
    buyer,
    imageId: bytes32(input.imageId, "imageId"),
    rulesHash: bytes32(input.rulesHash, "rulesHash"),
    referenceHash: bytes32(input.referenceHash, "referenceHash"),
    budget: input.budget,
    expiry: input.expiry,
    description: input.description,
  };
}
