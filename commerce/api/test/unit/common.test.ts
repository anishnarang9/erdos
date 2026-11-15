import { afterEach, describe, expect, it } from "vitest";
import { TOKEN, buyerPost, errorOf, makeApp, providerHeaders, validRevision, type TestApp } from "./helpers.ts";

let t: TestApp;
afterEach(() => t?.close());

const jobBody = { revision: validRevision(), source: "import" };

describe("errors and routing", () => {
  it("GET /healthz", async () => {
    t = makeApp();
    const res = await t.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown routes return 404 JSON", async () => {
    t = makeApp();
    for (const [method, path] of [["GET", "/nope"], ["POST", "/v1/nope"], ["DELETE", "/v1/jobs/x"]] as const) {
      const res = await t.app.request(path, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    }
  });

  it("invalid JSON on POST returns 400 validation_failed", async () => {
    t = makeApp();
    for (const body of ["{not json", ""]) {
      const res = await buyerPost(t, "/v1/jobs", body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("validation_failed");
    }
  });

  it("a body over 1 MiB returns 413 payload_too_large; exactly 1 MiB is read", async () => {
    t = makeApp();
    const big = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
    const res = await buyerPost(t, "/v1/jobs", big);
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");
    const exact = `"${"x".repeat(1024 * 1024 - 2)}"`;
    expect((await buyerPost(t, "/v1/jobs", exact)).status).toBe(400); // read and parsed, then fails shape checks
  });

  it("buyer routes check auth first; the remaining stub returns 501", async () => {
    t = makeApp();
    for (const path of ["/v1/drafts", "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/compile", "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/select-quote", "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/funding-receipt"]) {
      const res = await buyerPost(t, path, {});
      expect(res.status).not.toBe(401);
      expect((await buyerPost(t, path, {}, { authorization: "Bearer wrong-token-xxxxxxxx" })).status).toBe(401);
    }
    for (const path of ["/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/submission"]) {
      const res = await t.app.request(path);
      expect(res.status).toBe(501);
      expect((await errorOf(res)).code).toBe("not_implemented");
    }
    const quotes = "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/quotes";
    const unsigned = await t.app.request(quotes, { method: "POST", body: "{}", headers: { "idempotency-key": "q1" } });
    expect(unsigned.status).toBe(401);
    const h = await providerHeaders({ method: "POST", pathWithQuery: quotes, body: "{}" });
    const signed = await t.app.request(quotes, { method: "POST", body: "{}", headers: { ...h, "idempotency-key": "q1" } });
    expect(signed.status).toBe(400); // authenticated, then fails the quote shape check
  });
});

describe("buyer auth", () => {
  it.each([
    ["missing", undefined],
    ["wrong token", "Bearer not-the-right-token-123"],
    ["token prefix", `Bearer ${TOKEN.slice(0, -1)}`],
    ["wrong scheme", `Basic ${TOKEN}`],
  ])("%s returns 401", async (_label, authorization) => {
    t = makeApp();
    const headers: Record<string, string> = { "idempotency-key": "a1", "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const res = await t.app.request("/v1/jobs", { method: "POST", headers, body: JSON.stringify(jobBody) });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("unauthorized");
  });

  it("auth is checked before JSON parsing and the idempotency key", async () => {
    t = makeApp();
    const res = await t.app.request("/v1/jobs", { method: "POST", body: "{bad" });
    expect(res.status).toBe(401);
  });
});

describe("idempotency", () => {
  it("missing or malformed Idempotency-Key returns 400", async () => {
    t = makeApp();
    for (const key of ["", "has space", "x".repeat(129), "bad/char"]) {
      const res = await t.app.request("/v1/jobs", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(jobBody),
      });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("validation_failed");
    }
  });

  it("same key and body replays status and body with Idempotent-Replayed: true", async () => {
    t = makeApp();
    const first = await buyerPost(t, "/v1/jobs", jobBody, { "idempotency-key": "same:key_1.0" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const firstText = await first.text();
    const again = await buyerPost(t, "/v1/jobs", jobBody, { "idempotency-key": "same:key_1.0" });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.text()).toBe(firstText);
  });

  it("replays stored 4xx responses too, but not 5xx", async () => {
    t = makeApp();
    const bad = { revision: validRevision({ maxBudget: "0" }), source: "import" };
    const a = await buyerPost(t, "/v1/jobs", bad, { "idempotency-key": "err-1" });
    const b = await buyerPost(t, "/v1/jobs", bad, { "idempotency-key": "err-1" });
    expect([a.status, b.status]).toEqual([400, 400]);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(await b.text()).toBe(await a.text());
    // No draft model configured: 503 model_unavailable, a 5xx that must not be stored.
    const s1 = await buyerPost(t, "/v1/drafts", {}, { "idempotency-key": "stub-1" });
    const s2 = await buyerPost(t, "/v1/drafts", {}, { "idempotency-key": "stub-1" });
    expect([s1.status, s2.status]).toEqual([503, 503]);
    expect(s2.headers.get("idempotent-replayed")).toBeNull();
  });

  it("same key with a different body returns 422 idempotency_key_reused", async () => {
    t = makeApp();
    await buyerPost(t, "/v1/jobs", jobBody, { "idempotency-key": "reuse" });
    const res = await buyerPost(t, "/v1/jobs", { ...jobBody, source: "grok" }, { "idempotency-key": "reuse" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("idempotency_key_reused");
  });

  it("the same key on a different path is a different scope", async () => {
    t = makeApp();
    expect((await buyerPost(t, "/v1/jobs", jobBody, { "idempotency-key": "scoped" })).status).toBe(201);
    expect((await buyerPost(t, "/v1/drafts", jobBody, { "idempotency-key": "scoped" })).status).toBe(503);
  });

  it("a replayed create does not create a second job", async () => {
    t = makeApp();
    const a = (await (await buyerPost(t, "/v1/jobs", jobBody, { "idempotency-key": "once" })).json()) as { jobId: string };
    const b = (await (await buyerPost(t, "/v1/jobs", jobBody, { "idempotency-key": "once" })).json()) as { jobId: string };
    expect(b.jobId).toBe(a.jobId);
  });
});
