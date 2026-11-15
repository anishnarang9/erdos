import { afterEach, describe, expect, it } from "vitest";
import { BUYER_TOKEN, createJob, expectError, freshKey, makeApp, validRevision } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const FAKE_ID = "01JZZZZZZZZZZZZZZZZZZZZZZZ";

// Buyer routes per the plan (CONTRACT.md "as in the plan").
const buyerRoutes = (id: string): string[] => [
  "/v1/jobs",
  `/v1/jobs/${id}/approve`,
  "/v1/drafts",
  `/v1/jobs/${id}/compile`,
  `/v1/jobs/${id}/select-quote`,
  `/v1/jobs/${id}/funding-receipt`,
];

const badAuth: [string, Record<string, string>][] = [
  ["missing Authorization", {}],
  ["wrong scheme (Basic)", { authorization: `Basic ${Buffer.from(`x:${BUYER_TOKEN}`).toString("base64")}` }],
  ["token without scheme", { authorization: BUYER_TOKEN }],
  ["wrong token", { authorization: "Bearer not-the-buyer-token-xx" }],
  ["token prefix only", { authorization: `Bearer ${BUYER_TOKEN.slice(0, -1)}` }],
  ["token with extra suffix", { authorization: `Bearer ${BUYER_TOKEN}x` }],
  ["empty bearer", { authorization: "Bearer " }],
];

describe("Common rule 5: buyer authentication returns 401 unauthorized", () => {
  for (const [label, auth] of badAuth) {
    for (const path of buyerRoutes(FAKE_ID)) {
      it(`${label} on POST ${path}`, async () => {
        s = makeApp();
        const res = await s.app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": freshKey(), ...auth },
          body: JSON.stringify({ revision: validRevision(), source: "import" }),
        });
        await expectError(res, 401, "unauthorized");
      });
    }
  }

  it("auth runs before idempotency-key validation (no auth + no key -> 401)", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await expectError(res, 401, "unauthorized");
  });

  it("auth runs before JSON parsing (wrong token + invalid JSON -> 401)", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", {
      method: "POST",
      headers: { authorization: "Bearer nope-nope-nope-nope", "idempotency-key": freshKey() },
      body: "{oops",
    });
    await expectError(res, 401, "unauthorized");
  });

  it("wrong token on approve of an existing job -> 401 and the job stays drafted", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}/approve`, {
      method: "POST",
      headers: {
        authorization: "Bearer nope-nope-nope-nope",
        "idempotency-key": freshKey(),
        "if-match": `"${revisionHash}"`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ revisionHash, referenceDigest: validRevision().referenceDigest }),
    });
    await expectError(res, 401, "unauthorized");
    const view = (await (await s.app.request(`/v1/jobs/${jobId}`)).json()) as { state: string; approval: unknown };
    expect(view.state).toBe("drafted");
    expect(view.approval).toBeNull();
  });

  it("correct token is accepted on POST /v1/jobs", async () => {
    s = makeApp();
    await createJob(s);
  });
});
