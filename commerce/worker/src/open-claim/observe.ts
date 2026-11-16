import { isAddressEqual, type Address, type Hex } from "viem";
import type { OpenClaimLog } from "./types.ts";

export type OpenClaimWinnerObservation =
  | { kind: "won"; envelopeHash: Hex; keyCommitment: Hex }
  | { kind: "lost"; solver: Address }
  | { kind: "unidentified" };

/**
 * The winning solver is the adapter's ClaimAccepted.solver.
 * Core JobSubmitted and PaymentReleased name the adapter as provider and are not the solver.
 */
export function observeClaimOutcome(input: { adapter: Address; self: Address; logs: readonly OpenClaimLog[] }): OpenClaimWinnerObservation {
  for (const log of input.logs) {
    if ((log.name === "JobSubmitted" || log.name === "PaymentReleased") && log.args.provider && !isAddressEqual(log.args.provider, input.adapter)) {
      return { kind: "unidentified" };
    }
  }
  const accepted = input.logs.filter((log) => log.name === "ClaimAccepted" && isAddressEqual(log.address, input.adapter));
  if (accepted.length !== 1) return { kind: "unidentified" };
  const event = accepted[0]!;
  const solver = event.args.solver;
  const envelopeHash = event.args.envelopeHash;
  const commitment = event.args.keyCommitment;
  if (!solver || !envelopeHash || !commitment) return { kind: "unidentified" };
  if (isAddressEqual(solver, input.adapter)) return { kind: "unidentified" };
  if (isAddressEqual(solver, input.self)) return { kind: "won", envelopeHash, keyCommitment: commitment };
  return { kind: "lost", solver };
}

/** Release is confirmed only by the adapter key event plus a token transfer to the solver for the full bounty. */
export function observeReleasePayout(input: {
  adapter: Address;
  self: Address;
  usdc: Address;
  budget: bigint;
  key: Hex;
  envelopeHash: Hex;
  logs: readonly OpenClaimLog[];
}): boolean {
  for (const log of input.logs) {
    if (log.name === "PaymentReleased" && (!log.args.provider || !isAddressEqual(log.args.provider, input.adapter))) return false;
  }
  const released = input.logs.filter((log) => log.name === "KeyReleased" && isAddressEqual(log.address, input.adapter));
  if (released.length !== 1) return false;
  const event = released[0]!;
  if (!event.args.solver || !isAddressEqual(event.args.solver, input.self)) return false;
  if (!event.args.key || event.args.key.toLowerCase() !== input.key.toLowerCase()) return false;
  if (!event.args.envelopeHash || event.args.envelopeHash.toLowerCase() !== input.envelopeHash.toLowerCase()) return false;
  if (event.args.amount !== input.budget) return false;
  return input.logs.some((log) => log.name === "Transfer" && isAddressEqual(log.address, input.usdc) && !!log.args.to && isAddressEqual(log.args.to, input.self) && log.args.value === input.budget);
}
