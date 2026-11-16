// One store for the whole demo. Live mode fills it from the API and chain; replay mode from a recording.
// Payment states come only from chain-confirmed data (job.chain, submission); solver events drive animation.
import { useSyncExternalStore } from "react";
import type { DraftRequest, DraftResponse, FundingTerms, JobView, Quote, Submission } from "./api";

export interface RunEvent {
  seq: number;
  type: string;
  at: string;
  chainJobId: string | null;
  data: Record<string, unknown>;
}

export interface OpView {
  opId: string;
  kind: "fund" | "refund";
  status: "pending" | "confirmed" | "failed";
  chainJobId: string | null;
  steps: { label: string; status: string; txHash?: string; at: string }[];
  error: string | null;
}

export type { Delivery } from "./chain";
import type { Delivery } from "./chain";

export interface DemoState {
  mode: "live" | "replay";
  /** Which run the stage shows: the main job or act two's tampered job. */
  focus: "main" | "act2";
  jobId: string | null;
  draftRequest: DraftRequest | null;
  draft: DraftResponse | null;
  drafting: boolean;
  job: JobView | null;
  quotes: Quote[];
  fundingTerms: FundingTerms | null;
  fundOp: OpView | null;
  refundOp: OpView | null;
  events: RunEvent[];
  submission: Submission | null;
  delivery: Delivery | null;
  error: string | null;
  muted: boolean;
  signer: "demo" | "wallet";
  captionIndex: number;
  recordedAt?: string;
  /** Replay only: playback speed and the run's real duration (ms), for the time-lapse label. */
  replaySpeed?: number;
  replayRealMs?: number;
  /** The funded job's expiredAt (unix seconds), read from the chain once the job is linked. */
  chainExpiredAt?: string;
}

export const initialState: DemoState = {
  mode: "live",
  focus: "main",
  jobId: null,
  draftRequest: null,
  draft: null,
  drafting: false,
  job: null,
  quotes: [],
  fundingTerms: null,
  fundOp: null,
  refundOp: null,
  events: [],
  submission: null,
  delivery: null,
  error: null,
  muted: false,
  signer: "demo",
  captionIndex: 0,
};

let state: DemoState = initialState;
const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<DemoState> | ((s: DemoState) => Partial<DemoState>)) {
    const p = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l();
  },
  reset(keep: Partial<DemoState> = {}) {
    state = { ...initialState, muted: state.muted, signer: state.signer, ...keep };
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useDemo<T>(select: (s: DemoState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(state));
}

export type Stage =
  | "request"
  | "drafting"
  | "clarify"
  | "unsupported"
  | "rules"
  | "approved"
  | "quoting"
  | "selected"
  | "funding"
  | "funded"
  | "proving"
  | "proved"
  | "rejected"
  | "submitted"
  | "paid"
  | "decrypted"
  | "refunded";

const lastEvent = (s: DemoState, type: string) => [...s.events].reverse().find((e) => e.type === type);

/** The single stage every animation keys off. Money stages need chain-confirmed data. */
export function stageOf(s: DemoState): Stage {
  if (s.delivery && s.delivery.files.length > 0) return "decrypted";
  const chain = s.job?.chain?.status;
  if (chain === "Expired" || s.refundOp?.status === "confirmed") return "refunded";
  if (chain === "Completed" || s.submission?.key) return "paid";
  if (s.submission?.submitTx || chain === "Submitted") return "submitted";
  const finished = lastEvent(s, "proof.finished");
  if (lastEvent(s, "submission.preflight_rejected") || finished?.data.verdict === 0) return "rejected";
  if (finished) return "proved";
  if (lastEvent(s, "proof.started")) return "proving";
  if (s.job?.state === "linked" || chain === "Funded") return "funded";
  if (s.fundOp?.status === "pending" || s.job?.state === "funding_pending") return "funding";
  if (s.job?.state === "selected") return "selected";
  if (s.job?.state === "compiled") return "quoting";
  if (s.job?.state === "approved") return "approved";
  if (s.job) return "rules";
  if (s.drafting) return "drafting";
  if (s.draft?.kind === "clarification") return "clarify";
  if (s.draft?.kind === "unsupported") return "unsupported";
  if (s.draft?.kind === "draft") return "rules";
  return "request";
}

export const STAGE_ORDER: Stage[] = ["request", "rules", "approved", "quoting", "selected", "funding", "funded", "proving", "proved", "submitted", "paid", "decrypted"];
