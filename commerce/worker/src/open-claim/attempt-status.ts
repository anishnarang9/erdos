import { object, requireSprint } from "../sprint-authorization.ts";
import { OPEN_CLAIM_PHASES, type OpenClaimPhase } from "./types.ts";
export const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const address = (value: unknown): string => {
  requireSprint(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)); return value.toLowerCase();
};
const phase = (value: unknown): OpenClaimPhase => {
  requireSprint(OPEN_CLAIM_PHASES.includes(value as OpenClaimPhase)); return value as OpenClaimPhase;
};
export interface PublicAttemptStatus {
  attemptId: string;
  job: { chainId: 5042002; core: string; adapter: string; jobId: string };
  solver: string;
  phase: OpenClaimPhase;
  paymentConfirmed: boolean;
  nextCursor: number;
  events: { attemptId: string; cursor: number; at: string; phase: OpenClaimPhase }[];
  winner?: string;
  claimTx?: string;
  releaseTx?: string;
}
/** A local progress report. Confirmed chain state remains authoritative for payment and winner. */
export function attemptStatus(value: unknown, afterCursor = 0): PublicAttemptStatus {
  const state = object(value), binding = object(state.binding);
  requireSprint(state.version === 1 && state.mode === "open-claim" && typeof state.attemptId === "string" && ATTEMPT_ID.test(state.attemptId));
  requireSprint(binding.chainId === 5042002 && typeof state.jobId === "string" && /^[1-9][0-9]{0,77}$/.test(state.jobId));
  requireSprint(typeof state.paymentConfirmed === "boolean" && Array.isArray(state.log) && state.log.length <= 10_000 &&
    Number.isSafeInteger(afterCursor) && afterCursor >= 0 && afterCursor <= state.log.length);
  const id = state.attemptId;
  const events = state.log.map((item: unknown, index: number) => {
    const entry = object(item);
    requireSprint(typeof entry.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.at) && Number.isFinite(Date.parse(entry.at)));
    return { attemptId: id, cursor: index + 1, at: entry.at, phase: phase(entry.event) };
  }).slice(afterCursor);
  const status: PublicAttemptStatus = { attemptId: id,
    job: { chainId: 5042002, core: address(binding.core), adapter: address(binding.adapter), jobId: state.jobId },
    solver: address(binding.solver), phase: phase(state.phase), paymentConfirmed: state.paymentConfirmed, nextCursor: state.log.length, events };
  if (state.winner !== undefined) status.winner = address(state.winner);
  for (const field of ["claimTx", "releaseTx"] as const) {
    if (state[field] !== undefined) { requireSprint(typeof state[field] === "string" && /^0x[0-9a-fA-F]{64}$/.test(state[field])); status[field] = state[field].toLowerCase(); }
  }
  return status;
}
