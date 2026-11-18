import { describe, expect, it } from "vitest";
import {
  BOT_REVIEW_MAX_INPUT_BYTES,
  prepareBotReview,
  validateBotReviewResult,
} from "../../src/bot-review-contract.ts";

const REVIEW = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const digest = (byte: string) => "0x" + byte.repeat(64);
function input() {
  return {
    version: 1,
    request: "Refunds must be between zero and USD 75.00 inclusive. Approval must be true.",
    revisionHash: digest("a"), referenceDigest: digest("b"), catalogDigest: digest("c"),
    plan: { version: 1, deliverables: [], references: [], rules: [{ op: "literal", type: "bool", value: true }] },
    exampleChecks: [{ name: "within-budget", verdict: 1 }, { name: "too-large", verdict: 0 }],
  };
}
function pass(snapshot = prepareBotReview(input())) {
  return { version: 1, reviewId: REVIEW, inputHash: snapshot.inputHash,
    decision: "pass", coveredRuleIndices: [0], findings: [], questions: [] };
}
const rejected = (run: () => unknown) => expect(run).toThrow(/Invalid Bot review/);

describe("Bot review input snapshots", () => {
  it("hashes canonical complete input and preserves an immutable snapshot", () => {
    const original = input(), snapshot = prepareBotReview(original);
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(prepareBotReview(reordered).inputHash).toBe(snapshot.inputHash);
    expect(snapshot.inputHash).toMatch(/^0x[0-9a-f]{64}$/);
    original.request = "Changed after preparation";
    original.plan.rules[0]!.value = false;
    expect(JSON.parse(snapshot.inputJson).request).toContain("USD 75.00");
    expect(JSON.parse(snapshot.inputJson).plan.rules[0].value).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("binds brief, full rules, references, revision, catalog and example results", () => {
    const baseline = prepareBotReview(input()).inputHash;
    const variants = [
      { ...input(), request: input().request + " Extra policy." },
      { ...input(), revisionHash: digest("d") },
      { ...input(), referenceDigest: digest("d") },
      { ...input(), catalogDigest: digest("d") },
      { ...input(), plan: { ...input().plan, rules: [{ op: "literal", type: "bool", value: false }] } },
      { ...input(), exampleChecks: [{ name: "other", verdict: 1 }, { name: "too-large", verdict: 0 }] },
    ];
    for (const value of variants) expect(prepareBotReview(value).inputHash).not.toBe(baseline);
    expect(prepareBotReview({ ...input(), revisionHash: digest("a").toUpperCase().replace("0X", "0x") }).inputHash).toBe(baseline);
  });

  it("rejects extra fields, empty policy, missing example outcomes and invalid plans", () => {
    for (const value of [
      { ...input(), apiKey: "synthetic-do-not-reflect" },
      { ...input(), request: "   " }, { ...input(), referenceDigest: "broken" },
      { ...input(), exampleChecks: [{ name: "only-pass", verdict: 1 }] },
      { ...input(), exampleChecks: [{ name: "only-fail", verdict: 0 }] },
      { ...input(), plan: null }, { ...input(), plan: { version: 1, rules: [] } },
      { ...input(), plan: { version: 1, rules: Array.from({ length: 65 }, () => true) } },
    ]) rejected(() => prepareBotReview(value));
    const cyclic: Record<string, unknown> = { version: 1, rules: [true] }; cyclic.self = cyclic;
    rejected(() => prepareBotReview({ ...input(), plan: cyclic }));
  });

  it("bounds UTF-8 bytes across the complete payload without truncating it", () => {
    expect(Buffer.byteLength(prepareBotReview(input()).inputJson)).toBeLessThan(BOT_REVIEW_MAX_INPUT_BYTES);
    const value = { ...input(), plan: { ...input().plan, note: "界".repeat(6_000) } };
    expect(() => prepareBotReview(value)).toThrow("Bot review input exceeds the size limit");
  });
});

describe("Bot review results", () => {
  it("accepts a consistent pass bound to the expected review and immutable input", () => {
    const snapshot = prepareBotReview(input());
    expect(validateBotReviewResult(snapshot, REVIEW, pass(snapshot)).decision).toBe("pass");
  });

  it("rejects trigger acknowledgements, wrong identities and damaged snapshots", () => {
    const snapshot = prepareBotReview(input());
    for (const result of [{ accepted: true }, { status: 200 }, { ...pass(snapshot), reviewId: OTHER },
      { ...pass(snapshot), inputHash: digest("d") }, { ...pass(snapshot), fundingApproved: true },
      { ...pass(snapshot), costMicroUsd: 0 }]) rejected(() => validateBotReviewResult(snapshot, REVIEW, result));
    rejected(() => validateBotReviewResult({ ...snapshot, inputJson: snapshot.inputJson.replace("75.00", "99.00") }, REVIEW, pass(snapshot)));
  });

  it("rejects incomplete, duplicate and nonexistent rule coverage", () => {
    const snapshot = prepareBotReview(input());
    for (const coveredRuleIndices of [[], [0, 0], [1]]) {
      rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), coveredRuleIndices }));
    }
  });

  it("requires verbatim source quotes and valid finding rule indexes", () => {
    const snapshot = prepareBotReview(input());
    const finding = { kind: "contradiction", sourceQuote: "USD 75.00", ruleIndices: [0], message: "The proposed bound differs." };
    const result = { ...pass(snapshot), decision: "needs_changes", findings: [finding] };
    expect(validateBotReviewResult(snapshot, REVIEW, result).decision).toBe("needs_changes");
    for (const changed of [{ ...finding, sourceQuote: "Invented policy" }, { ...finding, ruleIndices: [1] },
      { ...finding, ruleIndices: [0, 0] }]) rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...result, findings: [changed] }));
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...result, findings: [] }));
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), findings: [finding] }));
  });

  it("requires actual questions or unsupported findings for those decisions", () => {
    const snapshot = prepareBotReview(input());
    expect(validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), decision: "clarify", questions: ["Does approval apply to each refund?"] }).decision).toBe("clarify");
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), decision: "clarify" }));
    const unsupported = { kind: "unsupported", sourceQuote: "Approval", ruleIndices: [], message: "The supplied policy needs an unsupported source." };
    expect(validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), decision: "unsupported", findings: [unsupported] }).decision).toBe("unsupported");
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), decision: "unsupported" }));
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), questions: ["Unresolved"] }));
  });

  it("keeps errors fixed and bounds callback text", () => {
    const snapshot = prepareBotReview(input());
    try {
      validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), secret: "private-callback-content" });
      throw Error("Expected rejection");
    } catch (error) { expect((error as Error).message).toBe("Invalid Bot review result"); }
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), decision: "clarify", questions: ["x".repeat(600)] }));
  });

  it("rejects aggregate UTF-8 output even when each field fits its own limit", () => {
    const sourceQuote = "政策".repeat(128);
    const snapshot = prepareBotReview({ ...input(), request: sourceQuote });
    const findings = Array.from({ length: 16 }, () => ({ kind: "omission", sourceQuote,
      ruleIndices: [], message: "x".repeat(512) }));
    rejected(() => validateBotReviewResult(snapshot, REVIEW, { ...pass(snapshot), decision: "needs_changes", findings }));
  });
});
