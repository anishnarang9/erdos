// Cross-validation findings (round 2). Each test names the contract rule it defends.
import { afterEach, describe, expect, it } from "vitest";
import type { PlanValidator } from "../../src/index.ts";
import {
  BUYER_TOKEN,
  DIGEST,
  T0,
  createJob,
  expectError,
  freshKey,
  makeApp,
  providerHeaders,
  validRevision,
} from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const TS = Math.floor(T0 / 1000);
const P = "/v1/assignments";

function jobsInit(key: string, body: string): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${BUYER_TOKEN}`, "content-type": "application/json", "idempotency-key": key },
    body,
  };
}

describe("Rule 6: (address, nonce) can never be reused while its timestamp is still valid", () => {
  it("replay at now + 120.5 s of a request signed with timestamp = first-use + 60 s is rejected", async () => {
    s = makeApp();
    const h = await providerHeaders({ pathWithQuery: P, timestamp: TS + 60 });
    expect((await s.app.request(P, { headers: h })).status).toBe(200);
    // floor(now/1000) = TS + 120, so |now - timestamp| = 60 s: still inside the window.
    s.clock.t = T0 + 120_500;
    await expectError(await s.app.request(P, { headers: h }), 401, "unauthorized");
  });
});

describe("POST /v1/jobs: a plan the validator accepts but JCS cannot hash is a client error, not 500", () => {
  // Rule 2c "Plan limits": 400 validation_failed with a path under /plan; a server error is never acceptable.
  const underPlan = async (res: Response): Promise<void> => {
    const body = await expectError(res, 400, "validation_failed");
    const errs = (body.error.details?.errors ?? []) as { path: string }[];
    expect(errs.some((e) => e.path === "/plan" || e.path.startsWith("/plan/")), JSON.stringify(errs)).toBe(true);
  };
  const withPlanJson = (planJson: string): string =>
    `{"revision":${JSON.stringify({ ...validRevision(), plan: "@@PLAN@@" }).replace('"@@PLAN@@"', planJson)},"source":"import"}`;
  const nested = (k: number): string => `{"version":1,"x":${"[".repeat(k)}${"]".repeat(k)}}`;

  it("plan string with a lone surrogate returns 400 under /plan", async () => {
    s = makeApp();
    await underPlan(await s.app.request("/v1/jobs", jobsInit(freshKey(), withPlanJson('{"version":"\\ud800"}'))));
  });
  it("lone surrogate in a plan object KEY returns 400 under /plan", async () => {
    s = makeApp();
    await underPlan(await s.app.request("/v1/jobs", jobsInit(freshKey(), withPlanJson('{"version":1,"\\udc00":2}'))));
  });
  it("plan number 1e999 (parses to Infinity) returns 400 under /plan", async () => {
    s = makeApp();
    await underPlan(await s.app.request("/v1/jobs", jobsInit(freshKey(), withPlanJson('{"version":1e999}'))));
  });
  it("plan number -1e999 nested in an array returns 400 under /plan", async () => {
    s = makeApp();
    await underPlan(await s.app.request("/v1/jobs", jobsInit(freshKey(), withPlanJson('{"version":1,"a":[0,-1e999]}'))));
  });
  it("deeply nested plan (200k levels, < 1 MiB) returns 400 under /plan", async () => {
    s = makeApp();
    const body = withPlanJson(nested(200_000));
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);
    await underPlan(await s.app.request("/v1/jobs", jobsInit(freshKey(), body)));
  });
  it("plan nested 70 levels returns 400 under /plan", async () => {
    s = makeApp();
    await underPlan(await s.app.request("/v1/jobs", jobsInit(freshKey(), withPlanJson(nested(70)))));
  });
  it("plan nested about 60 levels is accepted (under the 64 limit on any reading of depth)", async () => {
    s = makeApp();
    const res = await s.app.request("/v1/jobs", jobsInit(freshKey(), withPlanJson(nested(60))));
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe("Rule 4: concurrent requests with the same idempotency scope", () => {
  const slow = (ms: number): PlanValidator => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true };
  };
  it("same key + same body in flight together: one job, identical bodies, one marked replayed", async () => {
    s = makeApp({ validatePlan: slow(20) });
    const key = freshKey();
    const body = JSON.stringify({ revision: validRevision(), source: "import" });
    const [a, b] = await Promise.all([s.app.request("/v1/jobs", jobsInit(key, body)), s.app.request("/v1/jobs", jobsInit(key, body))]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await a.text()).toBe(await b.text());
    const replayed = [a, b].filter((r) => r.headers.get("idempotent-replayed") === "true");
    expect(replayed.length).toBe(1);
  });
  it("same key + different bodies in flight together: one 201 and one 422", async () => {
    s = makeApp({ validatePlan: slow(20) });
    const key = freshKey();
    const b1 = JSON.stringify({ revision: validRevision(), source: "import" });
    const b2 = JSON.stringify({ revision: validRevision(), source: "grok" });
    const [a, b] = await Promise.all([s.app.request("/v1/jobs", jobsInit(key, b1)), s.app.request("/v1/jobs", jobsInit(key, b2))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
  });
  it("two approvals with different keys in flight together both return the same approval", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    const body = JSON.stringify({ revisionHash, referenceDigest: DIGEST });
    const init = (): RequestInit => {
      const i = jobsInit(freshKey(), body);
      (i.headers as Record<string, string>)["if-match"] = revisionHash;
      return i;
    };
    const [a, b] = await Promise.all([s.app.request(`/v1/jobs/${jobId}/approve`, init()), s.app.request(`/v1/jobs/${jobId}/approve`, init())]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual(await b.json());
  });
});

describe("Rule 2a: requests that fail auth, have a bad key, or invalid JSON are never stored", () => {
  it("invalid JSON with key K, then a valid body with key K succeeds (not 422)", async () => {
    s = makeApp();
    const key = freshKey();
    await expectError(await s.app.request("/v1/jobs", jobsInit(key, "{bad")), 400, "validation_failed");
    const res = await s.app.request("/v1/jobs", jobsInit(key, JSON.stringify({ revision: validRevision(), source: "import" })));
    expect(res.status).toBe(201);
  });
  it("wrong token with key K, then the right token with key K and another body succeeds", async () => {
    s = makeApp();
    const key = freshKey();
    const bad = jobsInit(key, "{}");
    (bad.headers as Record<string, string>).authorization = "Bearer wrong-wrong-wrong-wrong";
    await expectError(await s.app.request("/v1/jobs", bad), 401, "unauthorized");
    const res = await s.app.request("/v1/jobs", jobsInit(key, JSON.stringify({ revision: validRevision(), source: "import" })));
    expect(res.status).toBe(201);
  });
});
