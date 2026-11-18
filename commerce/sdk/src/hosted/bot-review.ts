export type HostedBotDecision = "pass" | "needs_changes" | "clarify" | "unsupported";
export interface HostedBotResult {
  version: 1; reviewId: string; inputHash: string; decision: HostedBotDecision;
  coveredRuleIndices: number[];
  findings: { kind: "omission" | "contradiction" | "ambiguous" | "unsupported"; sourceQuote: string; ruleIndices: number[]; message: string }[];
  questions: string[];
}
export interface HostedBotReview {
  reviewId: string; jobId: string; revisionId: string; revisionHash: string; inputHash: string;
  status: "queued" | "dispatching" | "waiting" | "uncertain" | "expired" | "completed";
  decision: HostedBotDecision | null; result: HostedBotResult | null; resultHash: string | null;
  createdAt: number; expiresAt: number; completedAt: number | null;
}
export interface HostedBotReviewInput { revisionHash: string; request?: string; examples: unknown[] }
const invalid = (): never => { throw new Error("Invalid Bot review response"); };
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(key => !fields.includes(key))) return invalid();
  return v;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) return invalid(); return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid(); return value;
}
function indexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => integer(item) > 63) || new Set(value).size !== value.length) return invalid();
  return value as number[];
}
function decision(value: unknown): HostedBotDecision {
  if (typeof value !== "string" || !["pass", "needs_changes", "clarify", "unsupported"].includes(value)) return invalid(); return value as HostedBotDecision;
}
function result(value: unknown, reviewId: string, inputHash: string): HostedBotResult {
  const v = record(value, ["version", "reviewId", "inputHash", "decision", "coveredRuleIndices", "findings", "questions"]);
  if (v.version !== 1 || v.reviewId !== reviewId || v.inputHash !== inputHash || !Array.isArray(v.findings) || v.findings.length > 16
    || !Array.isArray(v.questions) || v.questions.length > 3) return invalid();
  const findings = v.findings.map(raw => {
    const item = record(raw, ["kind", "sourceQuote", "ruleIndices", "message"]);
    if (typeof item.kind !== "string" || !["omission", "contradiction", "ambiguous", "unsupported"].includes(item.kind)) return invalid();
    return { kind: item.kind as HostedBotResult["findings"][number]["kind"], sourceQuote: text(item.sourceQuote, 512),
      ruleIndices: indexes(item.ruleIndices), message: text(item.message, 512) };
  });
  const questions = v.questions.map(item => text(item, 512)), selected = decision(v.decision);
  if ((selected === "pass" && (findings.length || questions.length)) || (selected === "needs_changes" && !findings.length)
    || (selected === "clarify" && !questions.length) || (selected === "unsupported" && !findings.some(item => item.kind === "unsupported"))) return invalid();
  return { version: 1, reviewId, inputHash, decision: selected, coveredRuleIndices: indexes(v.coveredRuleIndices), findings, questions };
}

/** Parses a review receipt. A pass remains separate from buyer approval and funding. */
export function hostedBotReview(value: unknown, jobId: string, reviewId?: string, revisionHash?: string): HostedBotReview {
  const v = record(value, ["reviewId", "jobId", "revisionId", "revisionHash", "inputHash", "status", "decision", "result", "resultHash", "createdAt", "expiresAt", "completedAt"]);
  if (v.jobId !== jobId || (reviewId !== undefined && v.reviewId !== reviewId) || (revisionHash !== undefined && v.revisionHash !== revisionHash)
    || typeof v.status !== "string" || !["queued", "dispatching", "waiting", "uncertain", "expired", "completed"].includes(v.status)) return invalid();
  const id = text(v.reviewId), inputHash = hash(v.inputHash), createdAt = integer(v.createdAt), expiresAt = integer(v.expiresAt);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || expiresAt <= createdAt) return invalid();
  const terminal = v.status === "completed", parsedResult = terminal ? result(v.result, id, inputHash) : null;
  if (terminal ? v.decision !== parsedResult!.decision : (v.decision !== null || v.result !== null || v.resultHash !== null || v.completedAt !== null)) return invalid();
  const completedAt = terminal ? integer(v.completedAt) : null;
  if (completedAt !== null && (completedAt < createdAt || completedAt >= expiresAt)) return invalid();
  return { reviewId: id, jobId, revisionId: text(v.revisionId), revisionHash: hash(v.revisionHash), inputHash,
    status: v.status as HostedBotReview["status"], decision: parsedResult?.decision ?? null, result: parsedResult,
    resultHash: terminal ? hash(v.resultHash) : null, createdAt, expiresAt, completedAt };
}
