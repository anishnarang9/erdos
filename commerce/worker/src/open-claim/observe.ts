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
export function observeClaimOutcome(input: { adapter: Address; core: Address; self: Address; jobId: bigint; logs: readonly OpenClaimLog[] }): OpenClaimWinnerObservation {
  const submitted = input.logs.filter(log => log.name === "JobSubmitted" && isAddressEqual(log.address, input.core));
  if (submitted.length !== 1 || submitted[0]!.args.jobId !== input.jobId ||
      !submitted[0]!.args.provider || !isAddressEqual(submitted[0]!.args.provider, input.adapter)) {
    return { kind: "unidentified" };
  }
  for (const log of input.logs) {
    if (log.name === "PaymentReleased" &&
        (log.args.jobId !== input.jobId || !log.args.provider || !isAddressEqual(log.args.provider, input.adapter))) {
      return { kind: "unidentified" };
    }
  }
  const accepted = input.logs.filter((log) => log.name === "ClaimAccepted" && isAddressEqual(log.address, input.adapter));
  if (accepted.length !== 1) return { kind: "unidentified" };
  const event = accepted[0]!;
  if (event.args.jobId !== input.jobId) return { kind: "unidentified" };
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
  core: Address;
  self: Address;
  jobId: bigint;
  usdc: Address;
  budget: bigint;
  key: Hex;
  envelopeHash: Hex;
  logs: readonly OpenClaimLog[];
}): boolean {
  const paid = input.logs.filter(log => log.name === "PaymentReleased" && isAddressEqual(log.address, input.core));
  if (paid.length !== 1 || paid[0]!.args.jobId !== input.jobId ||
      !paid[0]!.args.provider || !isAddressEqual(paid[0]!.args.provider, input.adapter) ||
      paid[0]!.args.amount !== input.budget) return false;
  const released = input.logs.filter((log) => log.name === "KeyReleased" && isAddressEqual(log.address, input.adapter));
  if (released.length !== 1) return false;
  const event = released[0]!;
  if (event.args.jobId !== input.jobId) return false;
  if (!event.args.solver || !isAddressEqual(event.args.solver, input.self)) return false;
  if (!event.args.key || event.args.key.toLowerCase() !== input.key.toLowerCase()) return false;
  if (!event.args.envelopeHash || event.args.envelopeHash.toLowerCase() !== input.envelopeHash.toLowerCase()) return false;
  if (event.args.amount !== input.budget) return false;
  const coreToAdapter = input.logs.some(log => log.name === "Transfer" && isAddressEqual(log.address, input.usdc) &&
    !!log.args.from && isAddressEqual(log.args.from, input.core) && !!log.args.to &&
    isAddressEqual(log.args.to, input.adapter) && log.args.value === input.budget);
  const adapterToSolver = input.logs.some(log => log.name === "Transfer" && isAddressEqual(log.address, input.usdc) &&
    !!log.args.from && isAddressEqual(log.args.from, input.adapter) && !!log.args.to &&
    isAddressEqual(log.args.to, input.self) && log.args.value === input.budget);
  return coreToAdapter && adapterToSolver;
}
