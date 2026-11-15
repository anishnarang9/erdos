import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUYER_TOKEN, createJob, expectError, freshKey, makeApp, providerHeaders } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp;
let jobId: string;
beforeEach(async () => {
  s = makeApp();
  jobId = (await createJob(s)).jobId;
});
afterEach(() => s.close());

const body = JSON.stringify({ placeholder: true });
const buyer = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${BUYER_TOKEN}`,
  "content-type": "application/json",
  "idempotency-key": freshKey(),
  ...extra,
});

// T5-T8 implemented every route except GET /v1/jobs/:id/submission (T11). The buyer and provider routes
// below keep their auth-first and idempotency-order checks; the 501 checks moved to the remaining stub.
describe("buyer routes (formerly 501 stubs)", () => {
  const routes = (id: string) => ["/v1/drafts", `/v1/jobs/${id}/compile`, `/v1/jobs/${id}/select-quote`, `/v1/jobs/${id}/funding-receipt`];
  it("each passes buyer auth with a valid token and then rejects the placeholder body or state", async () => {
    for (const p of routes(jobId)) {
      const res = await s.app.request(p, { method: "POST", headers: buyer(), body });
      expect([400, 409, 503], `${p}: ${await res.clone().text()}`).toContain(res.status);
    }
  });
  it("each returns 401 (auth first) without a token", async () => {
    for (const p of routes(jobId)) {
      const res = await s.app.request(p, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": freshKey() },
        body,
      });
      await expectError(res, 401, "unauthorized");
    }
  });
  it("each returns 401 with a wrong token", async () => {
    for (const p of routes(jobId)) {
      const res = await s.app.request(p, { method: "POST", headers: buyer({ authorization: "Bearer wrong-wrong-wrong-wrong" }), body });
      await expectError(res, 401, "unauthorized");
    }
  });
  it("5xx responses are not stored for idempotency: a repeat with no draft model is not a replay", async () => {
    const key = freshKey();
    const h = buyer({ "idempotency-key": key });
    await expectError(await s.app.request("/v1/drafts", { method: "POST", headers: h, body }), 503, "model_unavailable");
    const again = await s.app.request("/v1/drafts", { method: "POST", headers: h, body });
    expect(again.headers.get("idempotent-replayed")).toBeNull();
    await expectError(again, 503, "model_unavailable");
  });
});

describe("provider route POST /v1/jobs/:id/quotes", () => {
  it("returns 401 without provider auth", async () => {
    const res = await s.app.request(`/v1/jobs/${jobId}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey() },
      body,
    });
    await expectError(res, 401, "unauthorized");
  });
  it("returns 401 with only the buyer token", async () => {
    const res = await s.app.request(`/v1/jobs/${jobId}/quotes`, { method: "POST", headers: buyer(), body });
    await expectError(res, 401, "unauthorized");
  });
  it("a valid provider signature passes auth, then the placeholder body fails the quote shape (400)", async () => {
    const path = `/v1/jobs/${jobId}/quotes`;
    const h = await providerHeaders({ method: "POST", pathWithQuery: path, body });
    const res = await s.app.request(path, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "idempotency-key": freshKey() },
      body,
    });
    await expectError(res, 400, "validation_failed");
  });
});

describe("public routes need no auth", () => {
  it("GET /v1/jobs answers without auth", async () => {
    expect((await s.app.request("/v1/jobs")).status).toBe(200);
  });
  it("GET /v1/jobs?capability=x&open=true answers without auth", async () => {
    expect((await s.app.request("/v1/jobs?capability=x&open=true")).status).toBe(200);
  });
  it("GET /v1/jobs/:id/submission returns 501 without auth", async () => {
    await expectError(await s.app.request(`/v1/jobs/${jobId}/submission`), 501, "not_implemented");
  });
});

describe("501 stubs: idempotency key and JSON still checked (rule 2a order)", () => {
  const buyerStubs = (id: string) => ["/v1/drafts", `/v1/jobs/${id}/compile`, `/v1/jobs/${id}/select-quote`, `/v1/jobs/${id}/funding-receipt`];
  it("authenticated buyer stub with no Idempotency-Key returns 400", async () => {
    for (const p of buyerStubs(jobId)) {
      const h: Record<string, string> = buyer();
      delete h["idempotency-key"];
      await expectError(await s.app.request(p, { method: "POST", headers: h, body }), 400, "validation_failed");
    }
  });
  it("authenticated buyer stub with invalid JSON returns 400", async () => {
    for (const p of buyerStubs(jobId)) {
      await expectError(await s.app.request(p, { method: "POST", headers: buyer(), body: "{x" }), 400, "validation_failed");
    }
  });
  it("quotes signed over a different body returns 401", async () => {
    const path = `/v1/jobs/${jobId}/quotes`;
    const h = await providerHeaders({ method: "POST", pathWithQuery: path, body: JSON.stringify({ placeholder: false }) });
    const res = await s.app.request(path, { method: "POST", headers: { ...h, "content-type": "application/json", "idempotency-key": freshKey() }, body });
    await expectError(res, 401, "unauthorized");
  });
  it("quotes with valid signature but no Idempotency-Key returns 400", async () => {
    const path = `/v1/jobs/${jobId}/quotes`;
    const h = await providerHeaders({ method: "POST", pathWithQuery: path, body });
    await expectError(await s.app.request(path, { method: "POST", headers: { ...h, "content-type": "application/json" }, body }), 400, "validation_failed");
  });
  it("quotes with valid signature and invalid JSON returns 400", async () => {
    const path = `/v1/jobs/${jobId}/quotes`;
    const bad = "{x";
    const h = await providerHeaders({ method: "POST", pathWithQuery: path, body: bad });
    await expectError(await s.app.request(path, { method: "POST", headers: { ...h, "idempotency-key": freshKey() }, body: bad }), 400, "validation_failed");
  });
});
