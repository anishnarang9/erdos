// Same Idempotency-Key must not leave a second paid task behind.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, expectError, freshKey } from "./helpers.ts";
import { DRAFT_BODY } from "./helpers-t56.ts";

const ORIGIN = "https://api.example.test";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const WALLET_B = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const accountA = privateKeyToAccount(WALLET_A);
const accountB = privateKeyToAccount(WALLET_B);
const budget = {
  requestCeilingMicroUsd: 50_000,
  dailyCeilingMicroUsd: 5_000_000,
  inputMicroUsdPerMillion: 1_250_000,
  outputMicroUsdPerMillion: 2_500_000,
};

type Created = ReturnType<typeof createApp>;
const opened: Created[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function clarification() {
  return { result: { kind: "clarification" as const, questions: ["Which policy?"] }, model: "spec", traceId: "t1" };
}

function countingModel() {
  const model = {
    calls: 0,
    async draft() {
      model.calls += 1;
      return clarification();
    },
  };
  return model;
}

function appWith(extra: Partial<CreateAppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-idem-"));
  const dbPath = join(dir, "api.db");
  const model = countingModel();
  const created = createApp({
    dbPath,
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    deployment: { mode: "local", serviceOrigin: ORIGIN },
    draftModel: model,
    budget,
    ...extra,
  });
  opened.push(created);
  return { created, model, dbPath };
}

function auth(key: string, idem = freshKey()): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idem };
}

function draftTask(request: string) {
  return { operation: "draft", input: { ...DRAFT_BODY, request } };
}

async function post(app: Created["app"], body: unknown, headers: Record<string, string>) {
  return app.request("/v1/tasks", { method: "POST", headers, body: JSON.stringify(body) });
}

async function issue(app: Created["app"], account: PrivateKeyAccount) {
  const challenge = await app.request("/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address.toLowerCase() }),
  });
  const issued = await challenge.json() as { challengeId: string; message: string };
  expect(challenge.status, JSON.stringify(issued)).toBe(200);
  const signature = await account.signMessage({ message: issued.message });
  const keys = await app.request("/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: issued.challengeId, signature }),
  });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
}

function counts(dbPath: string) {
  const raw = new DatabaseSync(dbPath);
  const tasks = Number((raw.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n);
  const reservations = Number((raw.prepare("SELECT COUNT(*) AS n FROM spend_reservations").get() as { n: number }).n);
  const stored = Number((raw.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE route = '/v1/tasks'").get() as { n: number }).n);
  raw.close();
  return { tasks, reservations, stored };
}

describe("task idempotency", () => {
  it("creates only one paid task when concurrent requests reuse a key with different bodies", async () => {
    const { created, model, dbPath } = appWith();
    const key = await issue(created.app, accountA);
    const headers = auth(key, "same-cost-key");
    const [first, second] = await Promise.all([
      post(created.app, draftTask("Check policy A"), headers),
      post(created.app, draftTask("Check policy B"), headers),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([202, 422]);
    const accepted = first.status === 202 ? first : second;
    const rejected = first.status === 422 ? first : second;
    const view = await accepted.json() as { id: string; state: string };
    await expectError(rejected, 422, "idempotency_key_reused");
    expect(view.state).toBe("queued");
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1, stored: 1 });
    await created.pumpTasks();
    expect(model.calls).toBe(1);
    const replayA = await post(created.app, draftTask("Check policy A"), headers);
    const replayB = await post(created.app, draftTask("Check policy B"), headers);
    const replayStatuses = [replayA.status, replayB.status].sort((a, b) => a - b);
    expect(replayStatuses).toEqual([202, 422]);
    const replay = replayA.status === 202 ? replayA : replayB;
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await replay.json() as { id: string }).id).toBe(view.id);
    expect(counts(dbPath).tasks).toBe(1);
    expect(model.calls).toBe(1);
  });

  it("replays one task when the same key and same input race", async () => {
    const { created, model, dbPath } = appWith();
    const key = await issue(created.app, accountA);
    const headers = auth(key, "same-body-key");
    const body = draftTask("Check policy A");
    const [first, second] = await Promise.all([
      post(created.app, body, headers),
      post(created.app, body, headers),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const left = await first.json() as { id: string };
    const right = await second.json() as { id: string };
    expect(left.id).toBe(right.id);
    const replays = [first, second].filter((res) => res.headers.get("idempotent-replayed") === "true");
    expect(replays).toHaveLength(1);
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1, stored: 1 });
    await created.pumpTasks();
    expect(model.calls).toBe(1);
  });

  it("keeps semantic dedup across distinct keys and separate owners", async () => {
    const { created, model, dbPath } = appWith();
    const keyA = await issue(created.app, accountA);
    const keyB = await issue(created.app, accountB);
    const body = draftTask("Check policy A");
    const [left, right] = await Promise.all([
      post(created.app, body, auth(keyA, "owner-a-key")),
      post(created.app, body, auth(keyA, "owner-a-other-key")),
    ]);
    expect(left.status).toBe(202);
    expect(right.status).toBe(202);
    const leftId = ((await left.json()) as { id: string }).id;
    const rightId = ((await right.json()) as { id: string }).id;
    expect(leftId).toBe(rightId);
    expect(counts(dbPath)).toMatchObject({ tasks: 1, reservations: 1, stored: 2 });
    const other = await post(created.app, body, auth(keyB, "owner-a-key"));
    expect(other.status).toBe(202);
    expect(((await other.json()) as { id: string }).id).not.toBe(leftId);
    expect(counts(dbPath)).toMatchObject({ tasks: 2, reservations: 2 });
    await created.pumpTasks();
    expect(model.calls).toBe(2);
  });

  it("rechecks a quota rejection without a second reservation", async () => {
    const { created, model, dbPath } = appWith({
      budget: { ...budget, dailyCeilingMicroUsd: 50_000 },
    });
    const key = await issue(created.app, accountA);
    const [first, second] = await Promise.all([
      post(created.app, draftTask("Check policy A"), auth(key, "quota-a")),
      post(created.app, draftTask("Check policy B"), auth(key, "quota-b")),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([202, 429]);
    const denied = first.status === 429 ? first : second;
    await expectError(denied, 429, "rate_limited");
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1, stored: 2 });
    const replay = await post(
      created.app,
      draftTask(first.status === 429 ? "Check policy A" : "Check policy B"),
      auth(key, first.status === 429 ? "quota-a" : "quota-b"),
    );
    expect(replay.status).toBe(429);
    expect(replay.headers.get("idempotent-replayed")).toBeNull();
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1, stored: 2 });
    await created.pumpTasks();
    expect(model.calls).toBe(1);
  });

  it("restores one accepted task and does not keep a rejected body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-idem-crash-"));
    const dbPath = join(dir, "api.db");
    const model = countingModel();
    const first = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
      budget,
    });
    opened.push(first);
    const key = await issue(first.app, accountA);
    const headers = auth(key, "crash-key");
    const accepted = await post(first.app, draftTask("Check policy A"), headers);
    const view = await accepted.json() as { id: string; state: string };
    expect(accepted.status).toBe(202);
    expect(view.state).toBe("queued");
    const rejected = await post(first.app, { operation: "draft", input: { ...DRAFT_BODY, request: "nope" }, extra: true }, auth(key, "bad-shape"));
    await expectError(rejected, 400, "validation_failed");
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1, stored: 2 });
    first.close();
    const second = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
      budget,
    });
    opened.push(second);
    second.reconcileTasks();
    const replay = await post(second.app, draftTask("Check policy A"), headers);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await replay.json() as { id: string }).id).toBe(view.id);
    const conflict = await post(second.app, draftTask("Check policy B"), headers);
    await expectError(conflict, 422, "idempotency_key_reused");
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1, stored: 2 });
    await second.pumpTasks();
    expect(model.calls).toBe(1);
    const done = await (await second.app.request(`/v1/tasks/${view.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(done.state).toBe("succeeded");
  });
});
