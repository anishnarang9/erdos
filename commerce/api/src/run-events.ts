// Run events for the demo UI (ui-intent.md Decisions, Codex product-plan §6.2). The worker appends one JSON line
// per event to <eventsDir>/<runId>.jsonl; the API serves them read-only. Only allowlisted, public fields are
// written: never a release key before release, plaintext, a path, a token or a private key.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RunEventType =
  | "quote.created"
  | "solver.started"
  | "proof.started"
  | "proof.finished"
  | "proof.failed"
  | "submission.preflight_rejected"
  | "submission.broadcast"
  | "submission.confirmed"
  | "release.broadcast"
  | "release.confirmed"
  | "run.abandoned"
  | "run.failed";

/** Allowlisted data fields per event type. Anything else is dropped before writing. */
const ALLOWED: Record<RunEventType, readonly string[]> = {
  "quote.created": ["quoteId", "price", "provider", "validUntil"],
  "solver.started": ["solver", "provider", "chainJobId"],
  "proof.started": ["imageId", "proveBudgetSec"],
  "proof.finished": ["verdict", "proveMillis", "userCycles", "sealBytes", "envelopeHash", "keyCommitment"],
  "proof.failed": ["code", "message"],
  "submission.preflight_rejected": ["reason"],
  "submission.broadcast": ["txHash"],
  "submission.confirmed": ["txHash", "envelopeHash", "keyCommitment"],
  "release.broadcast": ["txHash"],
  "release.confirmed": ["txHash"],
  "run.abandoned": ["reason"],
  "run.failed": ["code", "message"],
};

export interface RunEvent {
  runId: string;
  seq: number;
  source: "worker" | "engine" | "chain";
  type: RunEventType;
  at: string;
  jobId: string;
  chainJobId: string | null;
  data: Record<string, unknown>;
}

export type Emit = (type: RunEventType, data?: Record<string, unknown>) => void;

const SAFE_RUN_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** Appends events for one run. seq continues from the existing file, so a restarted worker never reuses one. */
export function runEventLog(dir: string, runId: string, ids: { jobId: string; chainJobId?: bigint | null }): Emit {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`unsafe run id ${runId}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  let seq = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  return (type, data = {}) => {
    const allowed = ALLOWED[type];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      const v = data[k];
      if (v !== undefined) clean[k] = typeof v === "bigint" ? v.toString() : v;
    }
    const e: RunEvent = {
      runId,
      seq: ++seq,
      source: type.startsWith("proof.") ? "engine" : type.endsWith(".confirmed") ? "chain" : "worker",
      type,
      at: new Date().toISOString(),
      jobId: ids.jobId,
      chainJobId: ids.chainJobId === undefined || ids.chainJobId === null ? null : ids.chainJobId.toString(),
      data: clean,
    };
    appendFileSync(file, JSON.stringify(e) + "\n");
  };
}

/** Reads a run's events after `after` (exclusive). Skips a torn last line (a write in progress). */
export function readRunEvents(dir: string, runId: string, after = 0): RunEvent[] {
  if (!SAFE_RUN_ID.test(runId)) return [];
  const file = join(dir, `${runId}.jsonl`);
  if (!existsSync(file)) return [];
  const out: RunEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as RunEvent;
      if (e.seq > after) out.push(e);
    } catch {
      // incomplete trailing line
    }
  }
  return out;
}
