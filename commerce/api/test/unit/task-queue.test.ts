// Pending task admission stays bounded. Dedup and exact replay do not reserve again.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp, resolveTaskQueue, taskQueueFromEnv, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, expectError, freshKey } from "../spec/helpers.ts";
import { DRAFT_BODY } from "../spec/helpers-t56.ts";

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

function countingModel() {
  const model = {
    calls: 0,
    async draft() {
      model.calls += 1;
      return { result: { kind: "clarification" as const, questions: ["Which policy?"] }, model: "spec", traceId: "t1" };
    },
  };
  return model;
}

function appWith(extra: Partial<CreateAppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-queue-"));
  const dbPath = join(dir, "api.db");
  const model = countingModel();
  const created = createApp({
    dbPath,
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    deployment: { mode: "local", serviceOrigin: ORIGIN },
    draftModel: model,
    budget,
    taskQueue: { globalPending: 2, pendingPerWallet: 1 },
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
  raw.close();
  return { tasks, reservations };
}

function setState(dbPath: string, id: string, state: string) {
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(state, id);
  raw.close();
}

describe("pending task admission", () => {
  it("uses conservative defaults and rejects a non-positive cap before opening a database", () => {
    expect(resolveTaskQueue(undefined)).toEqual({ globalPending: 100, pendingPerWallet: 20 });
    expect(taskQueueFromEnv({})).toEqual({ globalPending: 100, pendingPerWallet: 20 });
    const secret = "not-a-number-secret";
    expect(() => taskQueueFromEnv({ TASK_PENDING_GLOBAL: secret })).toThrow(/TASK_PENDING_GLOBAL must be a positive safe integer/);
    try {
      taskQueueFromEnv({ TASK_PENDING_GLOBAL: secret });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
    expect(() => taskQueueFromEnv({ TASK_PENDING_GLOBAL: "0" })).toThrow(/positive safe integer/);
    const dbPath = join(mkdtempSync(join(tmpdir(), "ubc26-queue-config-")), "api.db");
    expect(() => createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      taskQueue: { globalPending: 0, pendingPerWallet: 1 },
    })).toThrow(/positive safe integer/);
    expect(existsSync(dbPath)).toBe(false);
    expect(() => resolveTaskQueue({ globalPending: 1, pendingPerWallet: 2 })).toThrow(/cannot exceed/);
  });

  it("rejects a new task when the wallet cap is full and still dedups without a reservation or model call", async () => {
    const { created, model, dbPath } = appWith();
    const key = await issue(created.app, accountA);
    const firstBody = draftTask("Check policy A");
    const accepted = await post(created.app, firstBody, auth(key, "queue-a"));
    const view = await accepted.json() as { id: string; state: string };
    expect(accepted.status, JSON.stringify(view)).toBe(202);
    expect(view.state).toBe("queued");
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });

    const denied = await post(created.app, draftTask("Check policy B"), auth(key, "queue-b"));
    expect(denied.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
    const body = await expectError(denied, 429, "rate_limited");
    expect(body.error.message).toBe("Task queue is full");
    expect(body.error.details).toMatchObject({ queue: "pending", scope: "wallet" });
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });

    const dedup = await post(created.app, firstBody, auth(key, "queue-a-again"));
    const again = await dedup.json() as { id: string };
    expect(dedup.status).toBe(202);
    expect(again.id).toBe(view.id);
    expect(dedup.headers.get("idempotent-replayed")).toBeNull();
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });

    const replay = await post(created.app, firstBody, auth(key, "queue-a"));
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await replay.json() as { id: string }).id).toBe(view.id);
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });

    const deniedReplay = await post(created.app, draftTask("Check policy B"), auth(key, "queue-b"));
    expect(deniedReplay.status).toBe(429);
    expect(deniedReplay.headers.get("idempotent-replayed")).toBeNull();
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });
    expect(model.calls).toBe(0);

    setState(dbPath, view.id, "succeeded");
    const different = await post(created.app, draftTask("Different body"), auth(key, "queue-b"));
    await expectError(different, 422, "idempotency_key_reused");
    const [firstRetry, secondRetry] = await Promise.all([
      post(created.app, draftTask("Check policy B"), auth(key, "queue-b")),
      post(created.app, draftTask("Check policy B"), auth(key, "queue-b")),
    ]);
    expect([firstRetry.status, secondRetry.status]).toEqual([202, 202]);
    expect((await firstRetry.json() as { id: string }).id).toBe((await secondRetry.json() as { id: string }).id);
    expect([firstRetry, secondRetry].filter(response => response.headers.get("idempotent-replayed") === "true")).toHaveLength(1);
    expect(counts(dbPath)).toEqual({ tasks: 2, reservations: 2 });
  });

  it("keeps a global cap across wallets and ignores finished states", async () => {
    const { created, model, dbPath } = appWith({ taskQueue: { globalPending: 1, pendingPerWallet: 1 } });
    const keyA = await issue(created.app, accountA);
    const keyB = await issue(created.app, accountB);
    const accepted = await post(created.app, draftTask("Check policy A"), auth(keyA, "global-a"));
    const view = await accepted.json() as { id: string };
    expect(accepted.status).toBe(202);
    const other = await post(created.app, draftTask("Check policy B"), auth(keyB, "global-b"));
    const otherBody = await expectError(other, 429, "rate_limited");
    expect(otherBody.error.details).toMatchObject({ scope: "global" });
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });

    const same = await post(created.app, draftTask("Check policy A"), auth(keyA, "global-a-dedup"));
    expect(same.status).toBe(202);
    expect((await same.json() as { id: string }).id).toBe(view.id);
    expect(counts(dbPath).reservations).toBe(1);

    setState(dbPath, view.id, "running");
    const whileRunning = await post(created.app, draftTask("Check policy C"), auth(keyB, "global-c"));
    await expectError(whileRunning, 429, "rate_limited");
    expect(counts(dbPath)).toEqual({ tasks: 1, reservations: 1 });

    for (const state of ["succeeded", "failed", "uncertain"]) {
      setState(dbPath, view.id, state);
      const next = await post(created.app, draftTask(`Check policy ${state}`), auth(keyB, `global-${state}`));
      expect(next.status, state).toBe(202);
      setState(dbPath, ((await next.json()) as { id: string }).id, "succeeded");
    }
    expect(counts(dbPath)).toEqual({ tasks: 4, reservations: 4 });
    expect(model.calls).toBe(0);
  });
});
