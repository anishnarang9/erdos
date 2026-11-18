import { describe, expect, it } from "vitest";
import { hostedClient } from "../../src/hosted/client.ts";

const hash = "0x" + "a".repeat(64), inputHash = "0x" + "b".repeat(64);
const queued = { reviewId: "review1", jobId: "job1", revisionId: "rev1", revisionHash: hash, inputHash,
  status: "queued", decision: null, result: null, resultHash: null, createdAt: 1000, expiresAt: 61000, completedAt: null };
const completed = { ...queued, status: "completed", decision: "pass", resultHash: "0x" + "c".repeat(64), completedAt: 2000,
  result: { version: 1, reviewId: "review1", inputHash, decision: "pass", coveredRuleIndices: [0], findings: [], questions: [] } };
function fixture(replies: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => { calls.push({ url: String(url), init }); return Response.json(replies.shift()); }) as typeof fetch;
  return { calls, client: hostedClient({ baseUrl: "https://api.example.test", apiKey: "synthetic-owner-key", fetch: fetcher }) };
}
describe("hosted Bot review client", () => {
  it("requests one review with owner authentication and an explicit replay key", async () => {
    const { client, calls } = fixture([queued]);
    const body = { revisionHash: hash, request: "Require approval.", examples: [] };
    expect((await client.requestBotReview("job1", body, "review-1")).status).toBe("queued");
    expect(calls[0]!.url).toBe("https://api.example.test/v1/jobs/job1/bot-reviews");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual(body);
    expect(new Headers(calls[0]!.init!.headers).get("authorization")).toBe("Bearer synthetic-owner-key");
    expect(new Headers(calls[0]!.init!.headers).get("idempotency-key")).toBe("review-1");
  });
  it("polls only the existing review and returns its structured result", async () => {
    const { client, calls } = fixture([queued, { ...queued, status: "waiting" }, completed]);
    const review = await client.waitForBotReview("job1", "review1", { intervalMs: 1, timeoutMs: 1000 });
    expect(review.decision).toBe("pass"); expect(review.result?.coveredRuleIndices).toEqual([0]);
    expect(calls).toHaveLength(3); expect(calls.every(call => call.init!.method === "GET")).toBe(true);
    expect(calls.every(call => call.url.endsWith("/v1/jobs/job1/bot-reviews/review1"))).toBe(true);
  });
  it.each(["expired", "uncertain"])("returns %s without resending or starting another review", async status => {
    const { client, calls } = fixture([{ ...queued, status }]);
    expect((await client.waitForBotReview("job1", "review1")).status).toBe(status); expect(calls).toHaveLength(1);
  });
  it("rejects wrong identities, incomplete terminal results and private callback data", async () => {
    for (const body of [{ ...queued, jobId: "other" }, { ...queued, reviewId: "other" },
      { ...queued, status: "completed" }, { ...completed, result: { ...completed.result, inputHash: hash } },
      { ...queued, callbackTicket: "private-ticket" }, { ...queued, status: "approved" },
      { ...queued, status: ["queued"] },
      { ...completed, decision: "needs_changes", result: { ...completed.result, decision: "needs_changes", findings: [
        { kind: ["omission"], sourceQuote: "Require", ruleIndices: [0], message: "Missing rule" }] } },
      { ...completed, result: { ...completed.result, approved: true } }]) {
      const { client } = fixture([body]); await expect(client.botReview("job1", "review1")).rejects.toThrow(/Invalid Bot review/);
    }
    const wrongRevision = fixture([{ ...queued, revisionHash: inputHash }]);
    await expect(wrongRevision.client.requestBotReview("job1", { revisionHash: hash, examples: [] }, "request-1")).rejects.toThrow(/Invalid Bot review/);
  });
  it("forwards the selected receipt for buyer approval and never approves during polling", async () => {
    const { client, calls } = fixture([{}]);
    await client.approve("job1", { revisionHash: hash, referenceDigest: hash, botReviewId: "review1" }, "approve-1");
    expect(JSON.parse(calls[0]!.init!.body as string).botReviewId).toBe("review1");
    expect(new Headers(calls[0]!.init!.headers).get("if-match")).toBe(`"${hash}"`);
  });
  it("honors cancellation before any poll", async () => {
    const { client, calls } = fixture([]), controller = new AbortController(); controller.abort();
    await expect(client.waitForBotReview("job1", "review1", { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it("accepts an API-canonicalized digest after an uppercase-hash request", async () => {
    const { client, calls } = fixture([queued]);
    const uppercase = "0x" + hash.slice(2).toUpperCase();
    expect((await client.requestBotReview("job1", { revisionHash: uppercase, examples: [] }, "upper-1")).revisionHash).toBe(hash);
    expect(calls).toHaveLength(1);
  });
});
