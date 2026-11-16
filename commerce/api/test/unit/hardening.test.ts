import { afterEach, describe, expect, it } from "vitest";
import type { PlanValidator } from "../../src/index.ts";
import { DIGEST, T0, TOKEN, buyerPost, createJob, errorOf, makeApp, providerHeaders, type TestApp } from "./helpers.ts";

let t: TestApp;
afterEach(() => t?.close());

const REST = `"referenceDigest":"${DIGEST}","outputs":[{"name":"r.json","format":"json"}],"expirySeconds":600,"maxBudget":"5"`;
/** Raw POST /v1/jobs body with the plan given as raw JSON text. */
const rawJob = (planJson: string) => `{"source":"import","revision":{"plan":${planJson},${REST}}}`;
const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

describe("provider nonce retention (2c)", () => {
  it("a nonce whose timestamp is still inside the window cannot be replayed after 120.5 s", async () => {
    t = makeApp();
    const ts = Math.floor(T0 / 1000) + 60;
    const h = await providerHeaders({ pathWithQuery: "/v1/assignments", timestamp: ts, nonce: "late-nonce-1" });
    expect((await t.app.request("/v1/assignments", { headers: h })).status).toBe(200);
    t.clock.ms = T0 + 120_500;
    const replay = await t.app.request("/v1/assignments", { headers: h });
    expect(replay.status).toBe(401);
    expect((await errorOf(replay)).code).toBe("unauthorized");
  });

  it("accepts an address header in any case and keys nonces by the lowercase address", async () => {
    t = makeApp();
    const h = await providerHeaders({ pathWithQuery: "/v1/assignments", nonce: "case-nonce-1" });
    const upper = { ...h, "x-ubc26-address": "0x" + h["x-ubc26-address"]!.slice(2).toUpperCase() };
    expect((await t.app.request("/v1/assignments", { headers: upper })).status).toBe(200);
    const again = { ...h, "x-ubc26-address": h["x-ubc26-address"]!.toLowerCase() };
    expect((await t.app.request("/v1/assignments", { headers: again })).status).toBe(401);
  });
});

describe("plan must be hashable (2c)", () => {
  async function expectPlan400(raw: string, pathPrefix = "/plan"): Promise<void> {
    let calls = 0;
    const spy: PlanValidator = async () => {
      calls += 1;
      return { ok: true };
    };
    t = makeApp(spy);
    const res = await buyerPost(t, "/v1/jobs", raw);
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe("validation_failed");
    const paths = (err.details.errors as { path: string }[]).map((e) => e.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith(pathPrefix)).toBe(true);
    expect(calls).toBe(0);
  }

  it("rejects a lone surrogate in a string value", async () => {
    await expectPlan400(rawJob(`{"version":"\\ud800"}`), "/plan/version");
  });
  it("rejects a lone surrogate in an object key", async () => {
    await expectPlan400(rawJob(`{"version":1,"\\udc00":1}`), "/plan/");
  });
  it("rejects non-finite numbers", async () => {
    await expectPlan400(rawJob(`{"version":1e999}`), "/plan/version");
  });
  it("rejects 200k-deep nesting without overflowing", async () => {
    await expectPlan400(rawJob(`{"version":1,"x":${nested(200_000)}}`), "/plan/x");
  });
  it("accepts depth 64 and rejects depth 65 (the plan object is depth 1)", async () => {
    t = makeApp();
    expect((await buyerPost(t, "/v1/jobs", rawJob(`{"version":1,"x":${nested(63)}}`))).status).toBe(201);
    t.close();
    await expectPlan400(rawJob(`{"version":1,"x":${nested(64)}}`), "/plan/x");
  });
  it("accepts well-formed surrogate pairs", async () => {
    t = makeApp();
    expect((await buyerPost(t, "/v1/jobs", rawJob(`{"version":"\\ud83d\\ude00"}`))).status).toBe(201);
  });
});

describe("request decoding and headers (2c)", () => {
  it("invalid UTF-8 returns 400 validation_failed after auth", async () => {
    t = makeApp();
    const body = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]); // {"a":"\xff"}
    const res = await t.app.request("/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "utf8-1" },
      body,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation_failed");
    const noAuth = await t.app.request("/v1/jobs", { method: "POST", body });
    expect(noAuth.status).toBe(401);
  });

  it("a body over 1 MiB returns 413 even without auth", async () => {
    t = makeApp();
    const res = await t.app.request("/v1/jobs", { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");
  });

  it("missing If-Match and Idempotency-Key report /headers/<name> paths", async () => {
    t = makeApp();
    const job = await createJob(t);
    const body = { revisionHash: job.revision.revisionHash, referenceDigest: DIGEST };
    const noIfMatch = await buyerPost(t, `/v1/jobs/${job.jobId}/approve`, body);
    expect((await errorOf(noIfMatch)).details.errors).toEqual([
      { path: "/headers/if-match", message: expect.any(String) },
    ]);
    const noKey = await t.app.request("/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    expect((await errorOf(noKey)).details.errors[0].path).toBe("/headers/idempotency-key");
  });

  it('If-Match "*" and weak W/"<hash>" never match (409)', async () => {
    t = makeApp();
    const job = await createJob(t);
    const hash = job.revision.revisionHash;
    for (const ifMatch of ["*", `W/"${hash}"`, `"${hash}", "${hash}"`]) {
      const res = await buyerPost(t, `/v1/jobs/${job.jobId}/approve`, { revisionHash: hash, referenceDigest: DIGEST }, { "if-match": ifMatch });
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe("revision_conflict");
    }
    const upper = await buyerPost(
      t,
      `/v1/jobs/${job.jobId}/approve`,
      { revisionHash: hash.toUpperCase().replace("0X", "0x"), referenceDigest: DIGEST.toUpperCase() },
      { "if-match": `"${hash.toUpperCase()}"` },
    );
    expect(upper.status).toBe(200);
  });

  it("Bearer is case-sensitive with exactly one space", async () => {
    t = makeApp();
    for (const authorization of [`bearer ${TOKEN}`, `Bearer  ${TOKEN}`, `BEARER ${TOKEN}`]) {
      const res = await buyerPost(t, "/v1/jobs", "{}", { authorization });
      expect(res.status).toBe(401);
    }
  });

  it("a known path with the wrong method returns 404 not_found", async () => {
    t = makeApp();
    for (const [method, path] of [["GET", "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/approve"], ["PUT", "/v1/jobs"], ["POST", "/healthz"]] as const) {
      const res = await t.app.request(path, { method });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("not_found");
    }
  });
});

describe(":id must be a raw 26-character ULID", () => {
  it("lower-case and percent-encoded ids return 404 and are not stored as idempotency scopes", async () => {
    t = makeApp();
    const job = await createJob(t);
    const hash = job.revision.revisionHash;
    const body = { revisionHash: hash, referenceDigest: DIGEST };
    const encoded = "%" + job.jobId.charCodeAt(0).toString(16) + job.jobId.slice(1);
    for (const id of [job.jobId.toLowerCase(), encoded, job.jobId + "0", job.jobId.slice(1)]) {
      const res = await buyerPost(t, `/v1/jobs/${id}/approve`, body, { "if-match": hash, "idempotency-key": "id-key" });
      expect(res.status).toBe(404);
      expect(res.headers.get("idempotent-replayed")).toBeNull();
      expect((await t.app.request(`/v1/jobs/${id}`)).status).toBe(404);
    }
    const real = await buyerPost(t, `/v1/jobs/${job.jobId}/approve`, body, { "if-match": hash, "idempotency-key": "id-key" });
    expect(real.status).toBe(200);
  });
});
