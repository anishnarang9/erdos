// Public identity: wallet challenges, API keys, and job ownership.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, buyerHeaders, expectError, freshKey } from "./helpers.ts";
import { DRAFT_BODY, EMPTY_REF_HASH, revisionWith } from "./helpers-t56.ts";

const REVISION = revisionWith(EMPTY_REF_HASH);

const ORIGIN = "https://api.example.test";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const WALLET_B = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const accountA = privateKeyToAccount(WALLET_A);
const accountB = privateKeyToAccount(WALLET_B);

type App = ReturnType<typeof createApp>;
const opened: App[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function clocked(extra: Partial<CreateAppOptions> = {}) {
  const clock = { t: T0 };
  const app = createApp({
    dbPath: ":memory:",
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
    deployment: { mode: "local", serviceOrigin: ORIGIN },
    ...extra,
  });
  opened.push(app);
  return { app: app.app, clock, close: app.close };
}

function auth(key: string, idem = freshKey()): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "idempotency-key": idem,
  };
}

async function post(app: App["app"], path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function challenge(app: App["app"], account: PrivateKeyAccount) {
  const res = await post(app, "/v1/auth/challenge", { wallet: account.address.toLowerCase() });
  const body = (await res.json()) as { challengeId: string; message: string; expiresAt: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function issue(app: App["app"], account: PrivateKeyAccount) {
  const issued = await challenge(app, account);
  const signature = await account.signMessage({ message: issued.message });
  const res = await post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature });
  const body = (await res.json()) as { id: string; key: string; wallet: string; scopes: string[]; createdAt: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { ...issued, ...body, signature };
}

async function createOwnedJob(app: App["app"], key: string) {
  const res = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, auth(key));
  const body = (await res.json()) as { jobId: string; revision: { revisionHash: string } };
  expect(res.status, JSON.stringify(body)).toBe(201);
  return { jobId: body.jobId, revisionHash: body.revision.revisionHash };
}

async function approve(app: App["app"], key: string, jobId: string, revisionHash: string) {
  return post(
    app,
    `/v1/jobs/${jobId}/approve`,
    { revisionHash, referenceDigest: EMPTY_REF_HASH },
    { ...auth(key), "if-match": revisionHash },
  );
}

describe("wallet API key issuance", () => {
  it("returns an expiring challenge bound to the service, wallet, action, nonce, and expiry", async () => {
    const { app } = clocked();
    const body = await challenge(app, accountA);
    expect(body.challengeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.expiresAt).toBe(new Date(T0 + 10 * 60 * 1000).toISOString());
    expect(body.message).toContain("UBC26-HOSTED-AUTH-v1");
    expect(body.message).toContain(`service: ${ORIGIN}`);
    expect(body.message).toContain(`wallet: ${accountA.address.toLowerCase()}`);
    expect(body.message).toContain("action: issue-api-key");
    expect(body.message).toMatch(/nonce: [A-Za-z0-9_-]{20,}/);
    expect(body.message).toContain(`expires: ${body.expiresAt}`);
  });

  it("issues one high-entropy key and stores only its digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-identity-"));
    const dbPath = join(dir, "api.db");
    const clock = { t: T0 };
    const created = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => clock.t,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
    });
    opened.push(created);
    const logs: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    };
    let key = "";
    try {
      const issued = await issue(created.app, accountA);
      key = issued.key;
      expect(issued.key).toMatch(/^ubk_[A-Za-z0-9_-]{43}$/);
      expect(issued.wallet).toBe(accountA.address.toLowerCase());
      expect(issued.scopes).toEqual(["buyer"]);
      expect(issued.createdAt).toBe(new Date(T0).toISOString());
      expect(JSON.stringify(issued)).not.toContain("digest");
      const current = await created.app.request("/v1/auth/keys/current", { headers: { authorization: `Bearer ${issued.key}` } });
      const view = await current.json();
      expect(current.status).toBe(200);
      expect(view).toEqual({
        id: issued.id,
        wallet: issued.wallet,
        scopes: ["buyer"],
        createdAt: issued.createdAt,
      });
    } finally {
      console.log = original;
    }
    expect(logs.join("\n")).not.toContain(key);
    created.close();
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT key_digest FROM api_keys").get() as { key_digest: string };
    expect(row.key_digest).toBe(createHash("sha256").update(key).digest("hex"));
    expect(row.key_digest).not.toContain(key);
    db.close();
  });

  it("rejects a wrong-domain signature, an expired challenge, and a replay", async () => {
    const { app, clock } = clocked();
    const first = await challenge(app, accountA);
    const foreign = first.message.replace(ORIGIN, "https://evil.example");
    const bad = await post(app, "/v1/auth/keys", {
      challengeId: first.challengeId,
      signature: await accountA.signMessage({ message: foreign }),
    });
    await expectError(bad, 401, "unauthorized");

    const expired = await challenge(app, accountA);
    clock.t += 10 * 60 * 1000 + 1;
    const late = await post(app, "/v1/auth/keys", {
      challengeId: expired.challengeId,
      signature: await accountA.signMessage({ message: expired.message }),
    });
    await expectError(late, 401, "unauthorized");

    clock.t = T0;
    const issued = await issue(app, accountA);
    const replay = await post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature: issued.signature });
    await expectError(replay, 401, "unauthorized");
  });

  it("consumes one challenge once when two requests arrive together", async () => {
    const { app } = clocked();
    const issued = await challenge(app, accountA);
    const signature = await accountA.signMessage({ message: issued.message });
    const [left, right] = await Promise.all([
      post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature }),
      post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("stops a revoked key immediately and hides another wallet's key", async () => {
    const { app } = clocked();
    const a = await issue(app, accountA);
    const b = await issue(app, accountB);
    const denied = await post(app, `/v1/auth/keys/${a.id}/revoke`, {}, auth(b.key));
    await expectError(denied, 404, "not_found");
    const revoked = await post(app, `/v1/auth/keys/${a.id}/revoke`, {}, auth(a.key));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    const again = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, auth(a.key));
    await expectError(again, 401, "unauthorized");
    const current = await app.request("/v1/auth/keys/current", { headers: { authorization: `Bearer ${b.key}` } });
    const view = (await current.json()) as { id: string };
    expect(view.id).toBe(b.id);
  });
});

describe("job ownership", () => {
  it("keeps two keys from mutating each other's jobs", async () => {
    const { app } = clocked();
    const a = await issue(app, accountA);
    const b = await issue(app, accountB);
    const jobA = await createOwnedJob(app, a.key);
    const jobB = await createOwnedJob(app, b.key);
    expect(jobA.jobId).not.toBe(jobB.jobId);

    await expectError(await approve(app, b.key, jobA.jobId, jobA.revisionHash), 404, "not_found");
    expect((await approve(app, a.key, jobA.jobId, jobA.revisionHash)).status).toBe(200);
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/compile`, { revisionHash: jobA.revisionHash }, auth(b.key)),
      404,
      "not_found",
    );
    expect((await post(app, `/v1/jobs/${jobA.jobId}/compile`, { revisionHash: jobA.revisionHash }, auth(a.key))).status).toBe(200);
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/revisions`, { revision: REVISION, source: "import" }, { ...auth(b.key), "if-match": jobA.revisionHash }),
      404,
      "not_found",
    );
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/open-claim-terms`, {
        revisionHash: jobA.revisionHash,
        buyer: accountB.address,
        budget: "1",
        expiry: "9999999999",
      }, auth(b.key)),
      404,
      "not_found",
    );
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/open-claim-link`, {
        revisionHash: jobA.revisionHash,
        chainJobId: "1",
        fundingTx: "0x" + "ab".repeat(32),
        registrationTx: "0x" + "cd".repeat(32),
      }, auth(b.key)),
      404,
      "not_found",
    );
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/select-quote`, { quoteId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revisionHash: jobA.revisionHash }, auth(b.key)),
      404,
      "not_found",
    );
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/funding-receipt`, { txHash: "0x" + "11".repeat(32) }, auth(b.key)),
      404,
      "not_found",
    );
    await expectError(
      await post(app, `/v1/jobs/${jobA.jobId}/paid-compile`, { revisionHash: jobA.revisionHash }, auth(b.key)),
      404,
      "not_found",
    );
    const mismatch = await post(app, `/v1/jobs/${jobA.jobId}/open-claim-terms`, {
      revisionHash: jobA.revisionHash,
      buyer: accountB.address,
      budget: "1",
      expiry: "9999999999",
    }, auth(a.key));
    await expectError(mismatch, 400, "validation_failed");
  });

  it("does not let a new key mutate a legacy ownerless job", async () => {
    const { app } = clocked();
    const legacy = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, buyerHeaders());
    const body = (await legacy.json()) as { jobId: string; revision: { revisionHash: string } };
    expect(legacy.status).toBe(201);
    const key = await issue(app, accountA);
    await expectError(await approve(app, key.key, body.jobId, body.revision.revisionHash), 404, "not_found");
    const still = await post(
      app,
      `/v1/jobs/${body.jobId}/approve`,
      { revisionHash: body.revision.revisionHash, referenceDigest: EMPTY_REF_HASH },
      { ...buyerHeaders(), "if-match": body.revision.revisionHash },
    );
    expect(still.status).toBe(200);
  });

  it("scopes idempotency and drafts to the wallet", async () => {
    const { app } = clocked({
      draftModel: {
        async draft() {
          return { result: { kind: "clarification", questions: ["Which file?"] }, model: "spec", traceId: "t1" };
        },
      },
    });
    const a = await issue(app, accountA);
    const b = await issue(app, accountB);
    const idem = "same-key";
    const first = await createOwnedJob(app, a.key);
    const second = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, auth(b.key, idem));
    const third = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, auth(a.key, idem));
    expect(second.status).toBe(201);
    expect(third.status).toBe(201);
    const secondBody = (await second.json()) as { jobId: string };
    const thirdBody = (await third.json()) as { jobId: string };
    expect(new Set([first.jobId, secondBody.jobId, thirdBody.jobId]).size).toBe(3);

    const draft = await post(app, "/v1/drafts", DRAFT_BODY, auth(a.key));
    const draftBody = (await draft.json()) as { draftId: string };
    expect(draft.status, JSON.stringify(draftBody)).toBe(200);
    const stolen = await post(app, "/v1/jobs", {
      revision: REVISION,
      source: "grok",
      draftId: draftBody.draftId,
    }, auth(b.key));
    await expectError(stolen, 400, "validation_failed");
  });

  it("rejects the shared buyer token in public mode", async () => {
    const { app } = clocked({ deployment: { mode: "public", serviceOrigin: ORIGIN } });
    const denied = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, buyerHeaders());
    await expectError(denied, 401, "unauthorized");
    const key = await issue(app, accountA);
    expect((await createOwnedJob(app, key.key)).jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("expensive operation guards", () => {
  it("applies per-principal and per-IP limits and a global disable", async () => {
    const limited = clocked({
      deployment: { mode: "local", serviceOrigin: ORIGIN, trustProxy: true },
      rateLimit: { expensivePerPrincipal: 1, expensivePerIp: 10, windowMs: 60_000 },
    });
    const key = await issue(limited.app, accountA);
    const first = await createOwnedJob(limited.app, key.key);
    expect((await approve(limited.app, key.key, first.jobId, first.revisionHash)).status).toBe(200);
    expect((await post(limited.app, `/v1/jobs/${first.jobId}/compile`, { revisionHash: first.revisionHash }, auth(key.key))).status).toBe(200);
    const second = await createOwnedJob(limited.app, key.key);
    expect((await approve(limited.app, key.key, second.jobId, second.revisionHash)).status).toBe(200);
    await expectError(
      await post(limited.app, `/v1/jobs/${second.jobId}/compile`, { revisionHash: second.revisionHash }, auth(key.key)),
      429,
      "rate_limited",
    );

    const byIp = clocked({
      deployment: { mode: "local", serviceOrigin: ORIGIN, trustProxy: true },
      rateLimit: { expensivePerPrincipal: 10, expensivePerIp: 1, windowMs: 60_000 },
    });
    const ipA = await issue(byIp.app, accountA);
    const ipB = await issue(byIp.app, accountB);
    const job = await createOwnedJob(byIp.app, ipA.key);
    expect((await approve(byIp.app, ipA.key, job.jobId, job.revisionHash)).status).toBe(200);
    const headers = { ...auth(ipA.key), "x-forwarded-for": "203.0.113.8" };
    expect((await post(byIp.app, `/v1/jobs/${job.jobId}/compile`, { revisionHash: job.revisionHash }, headers)).status).toBe(200);
    const other = await createOwnedJob(byIp.app, ipB.key);
    expect((await approve(byIp.app, ipB.key, other.jobId, other.revisionHash)).status).toBe(200);
    await expectError(
      await post(byIp.app, `/v1/jobs/${other.jobId}/compile`, { revisionHash: other.revisionHash }, {
        ...auth(ipB.key),
        "x-forwarded-for": "203.0.113.8",
      }),
      429,
      "rate_limited",
    );

    const stopped = clocked({ expensiveDisabled: true });
    const owner = await issue(stopped.app, accountA);
    const blocked = await createOwnedJob(stopped.app, owner.key);
    expect((await approve(stopped.app, owner.key, blocked.jobId, blocked.revisionHash)).status).toBe(200);
    await expectError(
      await post(stopped.app, `/v1/jobs/${blocked.jobId}/compile`, { revisionHash: blocked.revisionHash }, auth(owner.key)),
      503,
      "service_disabled",
    );
  });
});
