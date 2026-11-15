import { afterEach, describe, expect, it } from "vitest";
import {
  BUYER_TOKEN,
  createJob,
  expectError,
  freshKey,
  makeApp,
  validRevision,
} from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import type { PlanValidator } from "../../src/index.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const jobBody = () => JSON.stringify({ revision: validRevision(), source: "import" });

function req(key: string | null, body: string, token = BUYER_TOKEN, extra: Record<string, string> = {}): RequestInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extra,
  };
  if (key !== null) headers["idempotency-key"] = key;
  return { method: "POST", headers, body };
}

describe("Common rule 4: Idempotency-Key header format", () => {
  it("missing Idempotency-Key returns 400 validation_failed", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/jobs", req(null, jobBody())), 400, "validation_failed");
  });
  it("empty Idempotency-Key returns 400", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/jobs", req("", jobBody())), 400, "validation_failed");
  });
  it("129-character Idempotency-Key returns 400", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/jobs", req("k".repeat(129), jobBody())), 400, "validation_failed");
  });
  it("128-character Idempotency-Key is accepted", async () => {
    s = makeApp();
    expect((await s.app.request("/v1/jobs", req("k".repeat(128), jobBody()))).status).toBe(201);
  });
  it("1-character Idempotency-Key is accepted", async () => {
    s = makeApp();
    expect((await s.app.request("/v1/jobs", req("k", jobBody()))).status).toBe(201);
  });
  it("key using every allowed character class [A-Za-z0-9_.:-] is accepted", async () => {
    s = makeApp();
    expect((await s.app.request("/v1/jobs", req("Az09_.:-", jobBody()))).status).toBe(201);
  });
  for (const bad of ["has space", "a/b", "a+b", "a=b", "é", "a,b", "a@b"]) {
    it(`key with disallowed character ${JSON.stringify(bad)} returns 400`, async () => {
      s = makeApp();
      const headers = new Headers({
        authorization: `Bearer ${BUYER_TOKEN}`,
        "content-type": "application/json",
      });
      // Non-ASCII header values cannot be set directly; encode as latin1 bytes.
      headers.set("idempotency-key", Buffer.from(bad, "utf8").toString("latin1"));
      const res = await s.app.request("/v1/jobs", { method: "POST", headers, body: jobBody() });
      await expectError(res, 400, "validation_failed");
    });
  }
});

describe("Common rule 4: Idempotency replay", () => {
  it("same scope + same requestHash replays status and body exactly with Idempotent-Replayed: true", async () => {
    s = makeApp();
    const key = freshKey();
    const body = jobBody();
    const first = await s.app.request("/v1/jobs", req(key, body));
    const firstText = await first.text();
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).not.toBe("true");
    s.clock.t += 5000;
    const second = await s.app.request("/v1/jobs", req(key, body));
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(firstText);
    // A replay must not create a second job: the replayed jobId still resolves.
    const { jobId } = JSON.parse(firstText) as { jobId: string };
    expect((await s.app.request(`/v1/jobs/${jobId}`)).status).toBe(200);
  });

  it("same scope + different body returns 422 idempotency_key_reused", async () => {
    s = makeApp();
    const key = freshKey();
    expect((await s.app.request("/v1/jobs", req(key, jobBody()))).status).toBe(201);
    const other = JSON.stringify({ revision: { ...validRevision(), expirySeconds: 700 }, source: "import" });
    await expectError(await s.app.request("/v1/jobs", req(key, other)), 422, "idempotency_key_reused");
  });

  it("requestHash is over the raw body: whitespace-only difference returns 422", async () => {
    s = makeApp();
    const key = freshKey();
    const body = jobBody();
    expect((await s.app.request("/v1/jobs", req(key, body))).status).toBe(201);
    await expectError(await s.app.request("/v1/jobs", req(key, body + " ")), 422, "idempotency_key_reused");
  });

  it("same key on a different path is a different scope (allowed)", async () => {
    s = makeApp();
    const key = freshKey();
    const first = await s.app.request("/v1/jobs", req(key, jobBody()));
    expect(first.status).toBe(201);
    const { jobId, revision } = (await first.json()) as { jobId: string; revision: { revisionHash: string } };
    const approveBody = JSON.stringify({ revisionHash: revision.revisionHash, referenceDigest: validRevision().referenceDigest });
    const res = await s.app.request(
      `/v1/jobs/${jobId}/approve`,
      req(key, approveBody, BUYER_TOKEN, { "if-match": `"${revision.revisionHash}"` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).not.toBe("true");
  });

  it("authentication is checked before idempotency: wrong token with a used key returns 401, not a replay", async () => {
    s = makeApp();
    const key = freshKey();
    const body = jobBody();
    expect((await s.app.request("/v1/jobs", req(key, body))).status).toBe(201);
    const res = await s.app.request("/v1/jobs", req(key, body, "wrong-token-wrong-token"));
    expect(res.headers.get("idempotent-replayed")).not.toBe("true");
    await expectError(res, 401, "unauthorized");
  });

  it("missing auth with a used key returns 401, not a replay", async () => {
    s = makeApp();
    const key = freshKey();
    const body = jobBody();
    expect((await s.app.request("/v1/jobs", req(key, body))).status).toBe(201);
    const res = await s.app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body,
    });
    await expectError(res, 401, "unauthorized");
  });

  it("a 4xx response (validation_failed) is stored and replayed", async () => {
    s = makeApp();
    const key = freshKey();
    const body = JSON.stringify({ revision: { ...validRevision(), expirySeconds: 1 }, source: "import" });
    const first = await s.app.request("/v1/jobs", req(key, body));
    const firstText = await first.text();
    expect(first.status).toBe(400);
    const second = await s.app.request("/v1/jobs", req(key, body));
    expect(second.status).toBe(400);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(firstText);
  });

  it("approve replay returns the stored body even after the clock moves", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    const key = freshKey();
    const body = JSON.stringify({ revisionHash, referenceDigest: validRevision().referenceDigest });
    const init = () => req(key, body, BUYER_TOKEN, { "if-match": revisionHash });
    const first = await s.app.request(`/v1/jobs/${jobId}/approve`, init());
    const firstText = await first.text();
    expect(first.status).toBe(200);
    s.clock.t += 60_000;
    const second = await s.app.request(`/v1/jobs/${jobId}/approve`, init());
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(firstText);
  });

  it("5xx responses are not stored: a retry with the same key re-executes", async () => {
    let calls = 0;
    const flaky: PlanValidator = async () => {
      calls += 1;
      if (calls === 1) throw new Error("validator crashed");
      return { ok: true };
    };
    s = makeApp({ validatePlan: flaky });
    const key = freshKey();
    const body = jobBody();
    const first = await s.app.request("/v1/jobs", req(key, body));
    await expectError(first, 500, "internal");
    const second = await s.app.request("/v1/jobs", req(key, body));
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).not.toBe("true");
    expect(calls).toBe(2);
  });
});
