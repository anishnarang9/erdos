import { getAddress, isAddress, isAddressEqual } from "viem";
import type { Address, Hex } from "viem";
import { encodeContext } from "../../codec/context.ts";
import type { FundedContext } from "../../codec/types.ts";
import { OpenClaimError } from "./errors.ts";

export interface OpenClaimContextInput {
  chainId: bigint;
  /** Escrow domain. This is the adapter, never the ERC-8183 core. */
  adapter: Address;
  jobId: bigint;
  /** Proof provider and payout identity. This is the solver, never the adapter. */
  solver: Address;
  rulesHash: Hex;
  referenceHash: Hex;
}

/** Version-1 context with the adapter as escrow and the actual solver as provider. */
export function openClaimContext(input: OpenClaimContextInput): { context: FundedContext; bytes: Uint8Array } {
  if (!isAddress(input.adapter) || !isAddress(input.solver)) {
    throw new OpenClaimError("wrong_context", "adapter and solver must be addresses");
  }
  const adapter = getAddress(input.adapter);
  const solver = getAddress(input.solver);
  if (isAddressEqual(adapter, solver)) {
    throw new OpenClaimError("wrong_context", "the proof provider must be the solver, not the adapter");
  }
  const context: FundedContext = {
    chainId: input.chainId,
    escrow: adapter,
    jobId: input.jobId,
    provider: solver,
    rulesHash: input.rulesHash,
    referenceHash: input.referenceHash,
  };
  return { context, bytes: encodeContext(context) };
}
