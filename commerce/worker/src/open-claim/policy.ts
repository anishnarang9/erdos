import { decodeFunctionData, encodeFunctionData, hexToBytes, isAddressEqual, size, type Address, type Hex } from "viem";
import { keyCommitment } from "@ubc26/sdk";
import { ARC_MIN_FEE } from "../policy.ts";
import { OPEN_CLAIM_CLAIM_SELECTOR, OPEN_CLAIM_MAX_ENVELOPE_BYTES, OPEN_CLAIM_RELEASE_SELECTOR, openClaimClaimReleaseAbi } from "./fixture.ts";
import type { OpenClaimRestrictedTx } from "./types.ts";

const abi = openClaimClaimReleaseAbi;

export class OpenClaimPolicyError extends Error {
  constructor(readonly rule: string, message: string) {
    super(message);
    this.name = "OpenClaimPolicyError";
  }
}

export interface OpenClaimPolicyConfig {
  chainId: number;
  adapter: Address;
  solver: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
}

export type OpenClaimAuthorization =
  | { kind: "claim"; jobId: bigint; envelope: Hex; seal: Hex; keyCommitment: Hex; gas: bigint; caller: Address }
  | { kind: "release"; jobId: bigint; key: Hex; keyCommitment: Hex; context: Uint8Array; gas: bigint; caller: Address; winner: Address };

export type OpenClaimTx = OpenClaimRestrictedTx;

function deny(rule: string): never {
  throw new OpenClaimPolicyError(rule, `transaction denied: ${rule}`);
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Adapter-only claim/release policy. Selected-provider submit/release stays on checkPolicy. */
export function checkOpenClaimPolicy(config: OpenClaimPolicyConfig, tx: OpenClaimTx, authorized: OpenClaimAuthorization): void {
  if (config.chainId !== 5042002 || tx.chainId !== config.chainId) deny("chain");
  if (tx.value !== 0n) deny("value");
  if (!isAddressEqual(tx.to, config.adapter)) deny("to");
  if (!isAddressEqual(tx.from, config.solver) || !isAddressEqual(authorized.caller, config.solver) || !isAddressEqual(tx.from, authorized.caller)) deny("caller");
  if (tx.gas !== authorized.gas || tx.gas <= 0n || tx.gas > config.maxGas) deny("gas");
  if (config.maxFeePerGas < ARC_MIN_FEE || tx.maxFeePerGas < ARC_MIN_FEE || tx.maxFeePerGas > config.maxFeePerGas) deny("fee");
  if (tx.maxPriorityFeePerGas < 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas) deny("fee");
  const selector = tx.data.slice(0, 10).toLowerCase();
  const expected = authorized.kind === "claim" ? OPEN_CLAIM_CLAIM_SELECTOR : OPEN_CLAIM_RELEASE_SELECTOR;
  if (selector !== expected) deny("selector");
  if (authorized.kind === "release" && !isAddressEqual(authorized.winner, config.solver)) deny("winner");
  if (authorized.jobId <= 0n) deny("authorization");
  try {
    const decoded = decodeFunctionData({ abi, data: tx.data });
    if (decoded.functionName === "claim") {
      if (authorized.kind !== "claim") deny("selector");
      const [jobId, envelope, seal, commitment] = decoded.args;
      const canonical = encodeFunctionData({ abi, functionName: "claim", args: [jobId, envelope, seal, commitment] });
      if (!same(canonical, tx.data)) deny("calldata");
      if (jobId !== authorized.jobId || !same(envelope, authorized.envelope) || !same(seal, authorized.seal) || !same(commitment, authorized.keyCommitment)) deny("authorization");
      if (size(envelope) < 1 || size(envelope) > OPEN_CLAIM_MAX_ENVELOPE_BYTES || !seal.toLowerCase().startsWith("0xe71e6620") || size(seal) <= 4) deny("authorization");
    } else {
      if (authorized.kind !== "release") deny("selector");
      const [jobId, key] = decoded.args;
      const canonical = encodeFunctionData({ abi, functionName: "release", args: [jobId, key] });
      if (!same(canonical, tx.data)) deny("calldata");
      const preimage = keyCommitment(authorized.context, hexToBytes(key));
      if (jobId !== authorized.jobId || !same(key, authorized.key) || !same(preimage, authorized.keyCommitment) || size(key) !== 32) deny("authorization");
    }
  } catch (error) {
    if (error instanceof OpenClaimPolicyError) throw error;
    deny("calldata");
  }
}
