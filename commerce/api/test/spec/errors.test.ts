import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/index.ts";
import { BUYER_TOKEN, T0, buyerHeaders, expectError, makeApp, validRevision } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

describe("Construction: createApp", () => {
  it("buyerToken shorter than 16 characters makes createApp throw", () => {
    expect(() => createApp({ dbPath: ":memory:", buyerToken: "a".repeat(15), now: () => T0 })).toThrow();
  });
  it("empty buyerToken makes createApp throw", () => {
    expect(() => createApp({ dbPath: ":memory:", buyerToken: "", now: () => T0 })).toThrow();
  });
  it("missing buyerToken makes createApp throw (required)", () => {
    const opts = { dbPath: ":memory:", now: () => T0 } as unknown as Parameters<typeof createApp>[0];
    expect(() => createApp(opts)).toThrow();
  });
  it("buyerToken of exactly 16 characters is accepted", () => {
    const created = createApp({ dbPath: ":memory:", buyerToken: "b".repeat(16), now: () => T0 });
    expect(typeof created.app.request).toBe("function");
    created.close();
  });
  it("validatePlan is optional (defaults to simulatedValidatePlan)", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", {
      method: "POST",
      headers: buyerHeaders(),
      body: JSON.stringify({ revision: validRevision(), source: "import" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /healthz", () => {
  it("is public and returns 200 { ok: true }", async () => {
    s = makeApp();
    const res = await s.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("Common rule 2: unknown routes return 404 not_found", () => {
  it("GET of an unknown path", async () => {
    s = makeApp();
    await expectError(await s.app.request("/does-not-exist"), 404, "not_found");
  });
  it("GET of an unknown /v1 path", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/nothing-here"), 404, "not_found");
  });
  it("authenticated POST with idempotency key to an unknown /v1 path", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/nothing-here", { method: "POST", headers: buyerHeaders(), body: "{}" });
    await expectError(res, 404, "not_found");
  });
});

describe("Common rule 3: request bodies", () => {
  it("invalid JSON on POST /v1/jobs returns 400 validation_failed", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body: "{not json" });
    await expectError(res, 400, "validation_failed");
  });
  it("empty body on POST /v1/jobs returns 400 validation_failed", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body: "" });
    await expectError(res, 400, "validation_failed");
  });
  it("invalid JSON on POST /v1/jobs/:id/approve returns 400 validation_failed", async () => {
    s = makeApp();
    const created = await s.app.request("/v1/jobs", {
      method: "POST",
      headers: buyerHeaders(),
      body: JSON.stringify({ revision: validRevision(), source: "import" }),
    });
    const { jobId, revision } = (await created.json()) as { jobId: string; revision: { revisionHash: string } };
    const res = await s.app.request(`/v1/jobs/${jobId}/approve`, {
      method: "POST",
      headers: buyerHeaders({ "if-match": `"${revision.revisionHash}"` }),
      body: "]]]",
    });
    await expectError(res, 400, "validation_failed");
  });
  it("JSON body that is not an object (array) on POST /v1/jobs returns 400", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body: "[]" });
    await expectError(res, 400, "validation_failed");
  });
  it("body over 1 MiB returns 413 payload_too_large", async () => {
    s = makeApp();
    const big = JSON.stringify({ revision: validRevision(), source: "import", pad: "x".repeat(1024 * 1024 + 10) });
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body: big });
    await expectError(res, 413, "payload_too_large");
  });
  it("body of 1 MiB + 1 byte returns 413", async () => {
    s = makeApp();
    const prefix = '{"pad":"';
    const suffix = '"}';
    const big = prefix + "x".repeat(1024 * 1024 + 1 - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(big)).toBe(1024 * 1024 + 1);
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body: big });
    await expectError(res, 413, "payload_too_large");
  });
  it("body of exactly 1 MiB is not rejected as too large", async () => {
    s = makeApp();
    const prefix = '{"pad":"';
    const suffix = '"}';
    const exact = prefix + "x".repeat(1024 * 1024 - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(exact)).toBe(1024 * 1024);
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body: exact });
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400); // unknown/missing fields
  });
  it("buyer token used in helpers is >= 16 chars (sanity)", () => {
    expect(BUYER_TOKEN.length).toBeGreaterThanOrEqual(16);
  });
});

describe("Rule 2c: size before auth, invalid UTF-8, wrong method", () => {
  it("body over 1 MiB with no auth returns 413 (size check precedes auth)", async () => {
    s = makeApp();
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    await expectError(res, 413, "payload_too_large");
  });
  it("body over 1 MiB with a wrong token and no key returns 413", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/drafts", {
      method: "POST",
      headers: { authorization: "Bearer wrong-wrong-wrong-wrong" },
      body: "x".repeat(2 * 1024 * 1024),
    });
    await expectError(res, 413, "payload_too_large");
  });
  it("body over 1 MiB on the provider route with no auth returns 413", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/quotes", { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    await expectError(res, 413, "payload_too_large");
  });
  it("invalid UTF-8 body (0xFF inside a JSON string) returns 400 validation_failed", async () => {
    s = makeApp();
    const raw = JSON.stringify({ revision: { ...validRevision(), plan: { version: "@" } }, source: "import" });
    const [pre, post] = raw.split("@") as [string, string];
    const body = new Uint8Array([...Buffer.from(pre), 0xff, ...Buffer.from(post)]);
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body });
    await expectError(res, 400, "validation_failed");
  });
  it("overlong UTF-8 encoding (0xC0 0xAF) returns 400", async () => {
    s = makeApp();
    const raw = JSON.stringify({ revision: { ...validRevision(), plan: { version: "@" } }, source: "import" });
    const [pre, post] = raw.split("@") as [string, string];
    const body = new Uint8Array([...Buffer.from(pre), 0xc0, 0xaf, ...Buffer.from(post)]);
    const res = await s.app.request("/v1/jobs", { method: "POST", headers: buyerHeaders(), body });
    await expectError(res, 400, "validation_failed");
  });
  it("unknown route with no auth returns 404 (not 401)", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/nothing-here", { method: "POST", body: "{}" }), 404, "not_found");
  });
  for (const [method, path] of [
    ["GET", "/v1/drafts"],
    ["DELETE", "/v1/jobs"],
    ["PUT", "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ"],
    ["GET", "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/approve"],
    ["POST", "/v1/assignments"],
    ["POST", "/healthz"],
  ] as const) {
    it(`wrong method ${method} ${path} returns 404 not_found`, async () => {
      s = makeApp();
      const init: RequestInit = { method, headers: buyerHeaders() };
      if (method !== "GET") init.body = "{}";
      await expectError(await s.app.request(path, init), 404, "not_found");
    });
  }
});
