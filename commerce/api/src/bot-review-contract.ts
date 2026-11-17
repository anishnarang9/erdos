import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import { ApiError } from "./errors.ts";
import { checkHashable } from "./revision.ts";

// These are protocol limits, not provider token counts or a dollar guarantee.
export const BOT_REVIEW_MAX_INPUT_BYTES = 16_384;
export const BOT_REVIEW_MAX_RESULT_BYTES = 8_192;
const MAX_RULES = 64;
const HASH_DOMAIN = "UBC26/bot-review-input/v1";
const digest = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase());
const index = z.number().int().min(0).max(MAX_RULES - 1);
const indexes = z.array(index).max(MAX_RULES);
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
const reviewId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const inputSchema = z.strictObject({
  version: z.literal(1),
  request: text(4_096),
  revisionHash: digest,
  referenceDigest: digest,
  catalogDigest: digest,
  plan: z.object({ version: z.literal(1), rules: z.array(z.unknown()).min(1).max(MAX_RULES) }).passthrough(),
  exampleChecks: z.array(z.strictObject({ name: text(80), verdict: z.union([z.literal(0), z.literal(1)]) })).min(2).max(16),
});
const resultSchema = z.strictObject({
  version: z.literal(1),
  reviewId,
  inputHash: digest,
  decision: z.enum(["pass", "needs_changes", "clarify", "unsupported"]),
  coveredRuleIndices: indexes,
  findings: z.array(z.strictObject({
    kind: z.enum(["omission", "contradiction", "ambiguous", "unsupported"]),
    sourceQuote: text(512),
    ruleIndices: indexes,
    message: text(512),
  })).max(16),
  questions: z.array(text(512)).max(3),
});

export interface BotReviewSnapshot {
  readonly inputJson: string;
  readonly inputHash: string;
  readonly request: string;
  readonly ruleCount: number;
}
export type BotReviewResult = z.infer<typeof resultSchema>;

function invalid(kind: "input" | "result"): never {
  throw new ApiError("validation_failed", `Invalid Bot review ${kind}`);
}

/**
 * Captures server-owned input after native plan/example validation.
 * This checks the review protocol. It does not validate engine semantics.
 */
export function prepareBotReview(value: unknown): BotReviewSnapshot {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) return invalid("input");
  const data = parsed.data;
  if (!data.exampleChecks.some(item => item.verdict === 1)
    || !data.exampleChecks.some(item => item.verdict === 0)
    || new Set(data.exampleChecks.map(item => item.name)).size !== data.exampleChecks.length
    || checkHashable(data, "/review").length > 0) return invalid("input");
  let inputJson: string | undefined;
  try { inputJson = canonicalize(data); } catch { return invalid("input"); }
  if (inputJson === undefined) return invalid("input");
  if (Buffer.byteLength(inputJson, "utf8") > BOT_REVIEW_MAX_INPUT_BYTES) {
    throw new ApiError("payload_too_large", "Bot review input exceeds the size limit");
  }
  const inputHash = "0x" + createHash("sha256").update(HASH_DOMAIN).update(inputJson, "utf8").digest("hex");
  return Object.freeze({ inputJson, inputHash, request: data.request, ruleCount: data.plan.rules.length });
}

function validIndexes(values: number[], ruleCount: number): boolean {
  return values.every(value => value < ruleCount) && new Set(values).size === values.length;
}

/**
 * Checks result consistency against a persisted snapshot and expected review ID.
 * Transport authentication must precede this call. A result has no funding authority.
 * The durable caller must preserve one terminal result and reject conflicting replays.
 */
export function validateBotReviewResult(
  snapshot: BotReviewSnapshot,
  expectedReviewId: string,
  value: unknown,
): BotReviewResult {
  if (!reviewId.safeParse(expectedReviewId).success || typeof snapshot.inputJson !== "string"
    || Buffer.byteLength(snapshot.inputJson, "utf8") > BOT_REVIEW_MAX_INPUT_BYTES) return invalid("result");
  let captured: BotReviewSnapshot;
  try { captured = prepareBotReview(JSON.parse(snapshot.inputJson)); } catch { return invalid("result"); }
  if (captured.inputHash !== snapshot.inputHash || captured.inputJson !== snapshot.inputJson) return invalid("result");
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return invalid("result");
  const result = parsed.data;
  if (result.reviewId !== expectedReviewId || result.inputHash !== captured.inputHash
    || !validIndexes(result.coveredRuleIndices, captured.ruleCount)
    || checkHashable(result, "/result").length > 0) return invalid("result");
  for (const finding of result.findings) {
    if (!captured.request.includes(finding.sourceQuote)
      || !validIndexes(finding.ruleIndices, captured.ruleCount)) return invalid("result");
  }
  if (result.decision === "pass" && (result.findings.length > 0 || result.questions.length > 0
    || result.coveredRuleIndices.length !== captured.ruleCount)) return invalid("result");
  if (result.decision === "needs_changes" && result.findings.length === 0) return invalid("result");
  if (result.decision === "clarify" && result.questions.length === 0) return invalid("result");
  if (result.decision === "unsupported" && !result.findings.some(item => item.kind === "unsupported")) return invalid("result");
  let resultJson: string | undefined;
  try { resultJson = canonicalize(result); } catch { return invalid("result"); }
  if (resultJson === undefined || Buffer.byteLength(resultJson, "utf8") > BOT_REVIEW_MAX_RESULT_BYTES) return invalid("result");
  return result;
}
