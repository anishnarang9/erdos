// Auth challenge and key issuance have their own IP window.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { authLimitFromEnv, createApp, resolveAuthLimit, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, expectError } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, revisionWith } from "../spec/helpers-t56.ts";

const ORIGIN = "https://api.example.test";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const accountA = privateKeyToAccount(WALLET_A);
const REVISION = revisionWith(EMPTY_REF_HASH);
const SIGNATURE = `0x${"ab".repeat(65)}`;

type Created = ReturnType<typeof createApp>;
const opened: Created[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function clocked(extra: Partial<CreateAppOptions> = {}) {
  const clock = { t: T0 };
  const dir = mkdtempSync(join(tmpdir(), "ubc26-auth-limit-"));
  const dbPath = join(dir, "api.db");
  const created = createApp({
    dbPath,
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
    deployment: { mode: "local", serviceOrigin: ORIGIN, trustProxy: true },
    authLimit: { perIp: 2, windowMs: 60_000 },
    ...extra,
  });
  opened.push(created);
  return { created, clock, dbPath };
}

async function challenge(app: Created["app"], forwarded: string, wallet = accountA.address.toLowerCase()) {
  return app.request("/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
    body: JSON.stringify({ wallet }),
  });
}

describe("auth issuance limits", () => {
  it("uses a positive default and does not echo a rejected secret", () => {
    expect(resolveAuthLimit(undefined)).toEqual({ perIp: 20, windowMs: 60_000 });
    const secret = "auth-secret-value";
    expect(() => authLimitFromEnv({ AUTH_LIMIT_IP: secret })).toThrow(/AUTH_LIMIT_IP must be a positive safe integer/);
    try {
      authLimitFromEnv({ AUTH_LIMIT_IP: secret });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
    expect(() => resolveAuthLimit({ perIp: 0 })).toThrow(/positive safe integer/);
  });

  it("caps one IP and leaves another IP and the expensive window alone", async () => {
    const { created, clock, dbPath } = clocked({
      rateLimit: { expensivePerPrincipal: 10, expensivePerIp: 1, windowMs: 60_000 },
    });
    expect((await challenge(created.app, "203.0.113.8")).status).toBe(200);
    expect((await challenge(created.app, "203.0.113.8, 198.51.100.2")).status).toBe(200);
    const denied = await challenge(created.app, "203.0.113.8");
    const body = await expectError(denied, 429, "rate_limited");
    expect(body.error.message).toBe("Auth rate limit exceeded");
    expect(JSON.stringify(body)).not.toContain(accountA.address.toLowerCase());
    expect((await challenge(created.app, "203.0.113.9")).status).toBe(200);

    const forged = await created.app.request("/v1/auth/keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ challengeId: "not-used", signature: SIGNATURE }),
    });
    const forgedBody = await expectError(forged, 429, "rate_limited");
    expect(JSON.stringify(forgedBody)).not.toContain(SIGNATURE);
    expect(JSON.stringify(forgedBody)).not.toContain("not-used");

    clock.t += 60_000;
    expect((await challenge(created.app, "203.0.113.8")).status).toBe(200);

    const raw = new DatabaseSync(dbPath);
    const authBuckets = raw.prepare("SELECT DISTINCT bucket FROM rate_counters WHERE bucket LIKE 'auth-ip:%'").all() as { bucket: string }[];
    const expensive = raw.prepare("SELECT bucket FROM rate_counters WHERE bucket LIKE 'ip:%'").all();
    raw.close();
    expect(authBuckets.map((row) => row.bucket).sort()).toEqual(["auth-ip:203.0.113.8", "auth-ip:203.0.113.9"]);
    expect(expensive).toEqual([]);

    const key = await issueOn(created.app, "198.51.100.10");
    const job = await created.app.request("/v1/jobs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": "auth-limit-job",
        "x-forwarded-for": "198.51.100.10",
      },
      body: JSON.stringify({ revision: REVISION, source: "import" }),
    });
    const createdJob = await job.json() as { jobId: string; revision: { revisionHash: string } };
    expect(job.status, JSON.stringify(createdJob)).toBe(201);
    const approved = await created.app.request(`/v1/jobs/${createdJob.jobId}/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": "auth-limit-approve",
        "if-match": createdJob.revision.revisionHash,
        "x-forwarded-for": "198.51.100.10",
      },
      body: JSON.stringify({ revisionHash: createdJob.revision.revisionHash, referenceDigest: EMPTY_REF_HASH }),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const compileHeaders = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": "auth-limit-compile",
      "x-forwarded-for": "198.51.100.10",
    };
    const firstCompile = await created.app.request(`/v1/jobs/${createdJob.jobId}/compile`, {
      method: "POST",
      headers: compileHeaders,
      body: JSON.stringify({ revisionHash: createdJob.revision.revisionHash }),
    });
    expect(firstCompile.status).toBe(200);
    const secondCompile = await created.app.request(`/v1/jobs/${createdJob.jobId}/compile`, {
      method: "POST",
      headers: { ...compileHeaders, "idempotency-key": "auth-limit-compile-2" },
      body: JSON.stringify({ revisionHash: createdJob.revision.revisionHash }),
    });
    const limited = await expectError(secondCompile, 429, "rate_limited");
    expect(limited.error.message).toBe("Rate limit exceeded");
  });

  it("shares one direct bucket in public mode when the proxy is not trusted", async () => {
    const { created } = clocked({
      deployment: { mode: "public", serviceOrigin: ORIGIN, trustProxy: false },
      authLimit: { perIp: 1, windowMs: 60_000 },
    });
    expect((await challenge(created.app, "203.0.113.8")).status).toBe(200);
    const denied = await challenge(created.app, "203.0.113.9");
    await expectError(denied, 429, "rate_limited");
  });
});

async function issueOn(app: Created["app"], forwarded: string) {
  const challenged = await challenge(app, forwarded);
  const issued = await challenged.json() as { challengeId: string; message: string };
  expect(challenged.status, JSON.stringify(issued)).toBe(200);
  const signature = await accountA.signMessage({ message: issued.message });
  const keys = await app.request("/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
    body: JSON.stringify({ challengeId: issued.challengeId, signature }),
  });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
}
