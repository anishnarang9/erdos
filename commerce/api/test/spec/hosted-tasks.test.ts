// Durable tasks execute the existing draft and compile handlers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp, simulatedEngine, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, buyerHeaders, expectError, freshKey } from "./helpers.ts";
import { DRAFT_BODY, EMPTY_REF_HASH, revisionWith } from "./helpers-t56.ts";

const REVISION = revisionWith(EMPTY_REF_HASH);
const ORIGIN = "https://api.example.test";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const WALLET_B = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const accountA = privateKeyToAccount(WALLET_A);
const accountB = privateKeyToAccount(WALLET_B);

type Created = ReturnType<typeof createApp>;
const opened: Created[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function clarification() {
  return { result: { kind: "clarification" as const, questions: ["Which file?"] }, model: "spec", traceId: "t1" };
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

function clocked(extra: Partial<CreateAppOptions> = {}) {
  const clock = { t: T0 };
  const created = createApp({
    dbPath: ":memory:",
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
    deployment: { mode: "local", serviceOrigin: ORIGIN },
    ...extra,
  });
  opened.push(created);
  return { created, clock };
}

function auth(key: string, idem = freshKey()): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idem };
}

async function post(app: Created["app"], path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function issue(app: Created["app"], account: PrivateKeyAccount) {
  const challenge = await post(app, "/v1/auth/challenge", { wallet: account.address.toLowerCase() });
  const issued = await challenge.json() as { challengeId: string; message: string };
  expect(challenge.status, JSON.stringify(issued)).toBe(200);
  const signature = await account.signMessage({ message: issued.message });
  const keys = await post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
}

function draftTask(request = DRAFT_BODY.request) {
  return { operation: "draft", input: { ...DRAFT_BODY, request } };
}

async function createJob(app: Created["app"], key: string) {
  const res = await post(app, "/v1/jobs", { revision: REVISION, source: "import" }, auth(key));
  const body = await res.json() as { jobId: string; revision: { revisionHash: string } };
  expect(res.status, JSON.stringify(body)).toBe(201);
  const approved = await post(app, `/v1/jobs/${body.jobId}/approve`, {
    revisionHash: body.revision.revisionHash,
    referenceDigest: EMPTY_REF_HASH,
  }, { ...auth(key), "if-match": body.revision.revisionHash });
  expect(approved.status, await approved.clone().text()).toBe(200);
  return { jobId: body.jobId, revisionHash: body.revision.revisionHash };
}

describe("durable tasks", () => {
  it("limits public draft admission to the live Bot pilot wallet", async () => {
    const model = countingModel();
    const { created } = clocked({
      deployment: { mode: "public", serviceOrigin: ORIGIN },
      draftModel: model,
      budget: { reservationMode: "provider-bound", requestCeilingMicroUsd: 2_540_960,
        dailyCeilingMicroUsd: 5_081_920, inputMicroUsdPerMillion: 2_500_000,
        outputMicroUsdPerMillion: 5_000_000 },
      botReview: { serviceToken: "callback-only-test-credential-0123456789",
        pilotOwner: accountA.address.toLowerCase(), maxDispatches: 1, dispatch: async () => {} },
    });
    const keyA = await issue(created.app, accountA);
    const keyB = await issue(created.app, accountB);
    await expectError(await post(created.app, "/v1/tasks", draftTask(), auth(keyB)), 403, "forbidden");
    const admitted = await post(created.app, "/v1/tasks", draftTask(), auth(keyA));
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    await expectError(await post(created.app, "/v1/tasks", draftTask("A second task"), auth(keyA)), 503, "service_disabled");
    expect((await post(created.app, "/v1/tasks", draftTask(), auth(keyA))).status).toBe(202);
    expect(model.calls).toBe(0);
  });

  it("keeps the one-draft pilot limit after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-pilot-drafts-"));
    const dbPath = join(dir, "service.db");
    const options: Partial<CreateAppOptions> = {
      dbPath,
      deployment: { mode: "public", serviceOrigin: ORIGIN },
      draftModel: countingModel(),
      budget: { reservationMode: "provider-bound", requestCeilingMicroUsd: 2_540_960,
        dailyCeilingMicroUsd: 5_081_920, inputMicroUsdPerMillion: 2_500_000,
        outputMicroUsdPerMillion: 5_000_000 },
      botReview: { serviceToken: "callback-only-test-credential-0123456789",
        pilotOwner: accountA.address.toLowerCase(), maxDispatches: 1, dispatch: async () => {} },
    };
    try {
      const first = clocked(options).created;
      const key = await issue(first.app, accountA);
      expect((await post(first.app, "/v1/tasks", draftTask(), auth(key))).status).toBe(202);
      first.close();
      opened.splice(opened.indexOf(first), 1);
      const second = clocked(options).created;
      await expectError(await post(second.app, "/v1/tasks", draftTask("A second task"), auth(key)), 503, "service_disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admits two distinct drafts when the reviewed pilot allows two reviews", async () => {
    const { created } = clocked({
      deployment: { mode: "public", serviceOrigin: ORIGIN },
      draftModel: countingModel(),
      budget: { reservationMode: "provider-bound", requestCeilingMicroUsd: 2_540_960,
        dailyCeilingMicroUsd: 7_622_880, inputMicroUsdPerMillion: 2_500_000,
        outputMicroUsdPerMillion: 5_000_000 },
      botReview: { serviceToken: "callback-only-test-credential-0123456789",
        pilotOwner: accountA.address.toLowerCase(), maxDispatches: 2, dispatch: async () => {} },
    });
    const key = await issue(created.app, accountA);
    expect((await post(created.app, "/v1/tasks", draftTask("First"), auth(key))).status).toBe(202);
    expect((await post(created.app, "/v1/tasks", draftTask("Second"), auth(key))).status).toBe(202);
    await expectError(await post(created.app, "/v1/tasks", draftTask("Third"), auth(key)), 503, "service_disabled");
    expect((await post(created.app, "/v1/tasks", draftTask("First"), auth(key))).status).toBe(202);
  });

  it("limits a local ten-draft pilot to its wallet after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-local-ten-drafts-"));
    const dbPath = join(dir, "service.db");
    const model = countingModel();
    const options: Partial<CreateAppOptions> = {
      dbPath,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
      budget: { reservationMode: "provider-bound", requestCeilingMicroUsd: 2_540_960,
        dailyCeilingMicroUsd: 27_950_560, inputMicroUsdPerMillion: 2_500_000,
        outputMicroUsdPerMillion: 5_000_000 },
      botReview: { serviceToken: "callback-only-test-credential-0123456789",
        pilotOwner: accountA.address.toLowerCase(), maxDispatches: 10, dispatch: async () => {} },
    };
    try {
      const first = clocked(options).created;
      const keyA = await issue(first.app, accountA);
      const keyB = await issue(first.app, accountB);
      await expectError(await post(first.app, "/v1/tasks", draftTask("Other wallet"), auth(keyB)), 403, "forbidden");
      await expectError(await post(first.app, "/v1/drafts", DRAFT_BODY, auth(keyB)), 403, "forbidden");
      expect(model.calls).toBe(0);
      for (let n = 1; n <= 10; n++) {
        const admitted = await post(first.app, "/v1/tasks", draftTask(`Pilot case ${n}`), auth(keyA));
        expect(admitted.status, await admitted.clone().text()).toBe(202);
      }
      first.close();
      opened.splice(opened.indexOf(first), 1);
      const second = clocked(options).created;
      await expectError(await post(second.app, "/v1/tasks", draftTask("Pilot case 11"), auth(keyA)), 503, "service_disabled");
      await expectError(await post(second.app, "/v1/drafts", DRAFT_BODY, auth(keyA)), 403, "forbidden");
      expect(model.calls).toBe(0);
      expect((await post(second.app, "/v1/tasks", draftTask("Pilot case 1"), auth(keyA))).status).toBe(202);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 202 before the real draft handler runs", async () => {
    const model = countingModel();
    const { created } = clocked({ draftModel: model });
    const key = await issue(created.app, accountA);
    const queued = await post(created.app, "/v1/tasks", draftTask(), auth(key));
    const view = await queued.json() as { id: string; state: string; attempt: number; createdAt: string; result?: unknown };
    expect(queued.status, JSON.stringify(view)).toBe(202);
    expect(view.state).toBe("queued");
    expect(view.attempt).toBe(0);
    expect(view.createdAt).toBe(new Date(T0).toISOString());
    expect(view.result).toBeUndefined();
    expect(model.calls).toBe(0);
    expect(JSON.stringify(view)).not.toContain(key);
    await created.pumpTasks();
    expect(model.calls).toBe(1);
    const done = await created.app.request(`/v1/tasks/${view.id}`, { headers: { authorization: `Bearer ${key}` } });
    const finished = await done.json() as { state: string; attempt: number; result: { kind: string; draftId: string } };
    expect(finished.state).toBe("succeeded");
    expect(finished.attempt).toBe(1);
    expect(finished.result.kind).toBe("clarification");
    expect(finished.result.draftId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("deduplicates one owner's work and lets another owner run the same input", async () => {
    const model = countingModel();
    const { created } = clocked({ draftModel: model });
    const keyA = await issue(created.app, accountA);
    const keyB = await issue(created.app, accountB);
    const [left, right] = await Promise.all([
      post(created.app, "/v1/tasks", draftTask(), auth(keyA, "same-key")),
      post(created.app, "/v1/tasks", draftTask(), auth(keyA, "other-key")),
    ]);
    const leftBody = await left.json() as { id: string };
    const rightBody = await right.json() as { id: string };
    expect(left.status).toBe(202);
    expect(right.status).toBe(202);
    expect(leftBody.id).toBe(rightBody.id);
    const replay = await post(created.app, "/v1/tasks", draftTask(), auth(keyA, "same-key"));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await replay.json() as { id: string }).id).toBe(leftBody.id);
    const other = await post(created.app, "/v1/tasks", draftTask(), auth(keyB));
    const otherBody = await other.json() as { id: string };
    expect(otherBody.id).not.toBe(leftBody.id);
    await created.pumpTasks();
    expect(model.calls).toBe(2);
    await expectError(
      await created.app.request(`/v1/tasks/${leftBody.id}`, { headers: { authorization: `Bearer ${keyB}` } }),
      404,
      "not_found",
    );
  });

  it("runs at most two drafts and one compile", async () => {
    let active = 0;
    let max = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = {
      async draft() {
        active += 1;
        max = Math.max(max, active);
        await gate;
        active -= 1;
        return clarification();
      },
    };
    const base = simulatedEngine();
    const engine = {
      ...base,
      active: 0,
      max: 0,
      calls: 0,
      async compile(input: Parameters<typeof base.compile>[0]) {
        engine.active += 1;
        engine.max = Math.max(engine.max, engine.active);
        engine.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        engine.active -= 1;
        return base.compile(input);
      },
    };
    const { created } = clocked({ draftModel: model, engine });
    const key = await issue(created.app, accountA);
    const ids = [];
    for (const request of ["Count the words in a.txt", "Count the words in b.txt", "Count the words in c.txt"]) {
      const res = await post(created.app, "/v1/tasks", draftTask(request), auth(key));
      ids.push(((await res.json()) as { id: string }).id);
    }
    const pumping = created.pumpTasks();
    for (let i = 0; i < 50 && max < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const states = [];
    for (const id of ids) {
      const view = await (await created.app.request(`/v1/tasks/${id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
      states.push(view.state);
    }
    expect(max).toBe(2);
    expect(states.filter((state) => state === "running")).toHaveLength(2);
    expect(states.filter((state) => state === "queued")).toHaveLength(1);
    release();
    await pumping;
    const first = await createJob(created.app, key);
    const second = await createJob(created.app, key);
    expect((await post(created.app, "/v1/tasks", { operation: "compile", jobId: first.jobId, revisionHash: first.revisionHash }, auth(key))).status).toBe(202);
    expect((await post(created.app, "/v1/tasks", { operation: "compile", jobId: second.jobId, revisionHash: second.revisionHash }, auth(key))).status).toBe(202);
    await created.pumpTasks();
    expect(engine.max).toBe(1);
    expect(engine.calls).toBe(1);
    await created.pumpTasks();
    expect(engine.calls).toBe(2);
  });

  it("runs an independent compile while a hosted draft awaits its provider", async () => {
    let signalDraftStarted!: () => void;
    let releaseDraft!: () => void;
    const started = new Promise<void>(resolve => { signalDraftStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseDraft = resolve; });
    const { created } = clocked({
      draftModel: { async draft() {
        signalDraftStarted();
        await held;
        return clarification();
      } },
    });
    const buyer = await issue(created.app, accountA);
    const drafter = await issue(created.app, accountB);
    const job = await createJob(created.app, buyer);
    expect((await post(created.app, "/v1/tasks", draftTask(), auth(drafter))).status).toBe(202);
    const draftPump = created.pumpTasks();
    try {
      await Promise.race([started, draftPump.then(() => { throw new Error("Draft did not start"); })]);
      const compile = await post(created.app, "/v1/tasks", { operation: "compile", ...job }, auth(buyer));
      expect(compile.status).toBe(202);
      const { id } = await compile.json() as { id: string };
      await created.pumpTasks();
      const response = await created.app.request(`/v1/tasks/${id}`, { headers: auth(buyer) });
      expect(await response.json()).toMatchObject({ state: "succeeded" });
    } finally {
      releaseDraft();
      await draftPump;
    }
  });

  it("resumes queued work and does not retry an interrupted draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-tasks-"));
    const dbPath = join(dir, "api.db");
    const model = countingModel();
    const first = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
    });
    opened.push(first);
    const key = await issue(first.app, accountA);
    const queued = await post(first.app, "/v1/tasks", draftTask("Count the words in queued.txt"), auth(key));
    const interrupted = await post(first.app, "/v1/tasks", draftTask("Count the words in running.txt"), auth(key));
    const queuedId = ((await queued.json()) as { id: string }).id;
    const interruptedId = ((await interrupted.json()) as { id: string }).id;
    expect(model.calls).toBe(0);
    first.close();
    const raw = new DatabaseSync(dbPath);
    const stored = raw.prepare("SELECT input_json FROM tasks WHERE id = ?").get(queuedId) as { input_json: string };
    expect(stored.input_json).not.toContain(key);
    expect(stored.input_json).not.toContain("authorization");
    raw.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run(interruptedId);
    raw.close();
    const second = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
    });
    opened.push(second);
    second.reconcileTasks();
    const resumed = await (await second.app.request(`/v1/tasks/${queuedId}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    const uncertain = await (await second.app.request(`/v1/tasks/${interruptedId}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(resumed.state).toBe("queued");
    expect(uncertain.state).toBe("uncertain");
    await second.pumpTasks();
    expect(model.calls).toBe(1);
    const after = await (await second.app.request(`/v1/tasks/${interruptedId}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(after.state).toBe("uncertain");
    const done = await (await second.app.request(`/v1/tasks/${queuedId}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(done.state).toBe("succeeded");
  });

  it("requeues an interrupted compile and then runs it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-compile-"));
    const dbPath = join(dir, "api.db");
    const base = simulatedEngine();
    let calls = 0;
    const engine = { ...base, async compile(input: Parameters<typeof base.compile>[0]) { calls += 1; return base.compile(input); } };
    const first = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      engine,
    });
    opened.push(first);
    const key = await issue(first.app, accountA);
    const job = await createJob(first.app, key);
    const queued = await post(first.app, "/v1/tasks", { operation: "compile", jobId: job.jobId, revisionHash: job.revisionHash }, auth(key));
    const taskId = ((await queued.json()) as { id: string }).id;
    expect(queued.status).toBe(202);
    first.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run(taskId);
    raw.close();
    const second = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      engine,
    });
    opened.push(second);
    second.reconcileTasks();
    expect(((await (await second.app.request(`/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${key}` } })).json()) as { state: string }).state).toBe("queued");
    await second.pumpTasks();
    const done = await (await second.app.request(`/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string; result: { state: string } };
    expect(done.state).toBe("succeeded");
    expect(done.result.state).toBe("compiled");
    expect(calls).toBe(1);
  });

  it("persists a model reservation before dispatch and stops at the daily ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-budget-"));
    const dbPath = join(dir, "api.db");
    const model = countingModel();
    const budget = {
      requestCeilingMicroUsd: 50_000,
      dailyCeilingMicroUsd: 100_000,
      inputMicroUsdPerMillion: 1_250_000,
      outputMicroUsdPerMillion: 2_500_000,
    };
    const created = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
      budget,
    });
    opened.push(created);
    const key = await issue(created.app, accountA);
    const accepted = await post(created.app, "/v1/tasks", draftTask("Count the words in first.txt"), auth(key));
    expect(accepted.status).toBe(202);
    expect(model.calls).toBe(0);
    const raw = new DatabaseSync(dbPath);
    const reserved = raw.prepare("SELECT state, ceiling_micro_usd, settled_micro_usd FROM spend_reservations").get() as {
      state: string;
      ceiling_micro_usd: number;
      settled_micro_usd: number | null;
    };
    raw.close();
    expect(reserved).toEqual({ state: "reserved", ceiling_micro_usd: 50_000, settled_micro_usd: null });
    await created.pumpTasks();
    expect(model.calls).toBe(1);
    const after = new DatabaseSync(dbPath);
    const uncertain = after.prepare("SELECT state, ceiling_micro_usd, settled_micro_usd FROM spend_reservations").get() as {
      state: string;
      ceiling_micro_usd: number;
      settled_micro_usd: number | null;
    };
    const halts = after.prepare("SELECT COUNT(*) AS n FROM spend_halts").get() as { n: number };
    after.close();
    expect(uncertain).toEqual({ state: "uncertain", ceiling_micro_usd: 50_000, settled_micro_usd: null });
    expect(uncertain.settled_micro_usd).not.toBe(0);
    expect(halts.n).toBe(0);
    expect((await post(created.app, "/v1/tasks", draftTask("Count the words in second.txt"), auth(key))).status).toBe(202);
    await created.pumpTasks();
    await expectError(await post(created.app, "/v1/tasks", draftTask("Count the words in third.txt"), auth(key)), 429, "rate_limited");
    expect(model.calls).toBe(2);
    expect(() => createApp({
      dbPath: ":memory:",
      buyerToken: BUYER_TOKEN,
      budget: { ...budget, inputMicroUsdPerMillion: 0 },
    })).toThrow(/positive integer/);
  });

  it("rejects a legacy token, a foreign compile, and a public draft without prices", async () => {
    const model = countingModel();
    const { created } = clocked({ draftModel: model });
    await expectError(await post(created.app, "/v1/tasks", draftTask(), buyerHeaders()), 401, "unauthorized");
    const keyA = await issue(created.app, accountA);
    const keyB = await issue(created.app, accountB);
    const job = await createJob(created.app, keyA);
    await expectError(
      await post(created.app, "/v1/tasks", { operation: "compile", jobId: job.jobId, revisionHash: job.revisionHash }, auth(keyB)),
      404,
      "not_found",
    );
    const owned = await post(created.app, "/v1/tasks", { operation: "compile", jobId: job.jobId, revisionHash: job.revisionHash }, auth(keyA));
    expect(owned.status, await owned.clone().text()).toBe(202);
    let failed = 0;
    const failing = {
      async draft() {
        failed += 1;
        if (failed === 1) throw new Error("secret sk-live /Users/private/key");
        return clarification();
      },
    };
    const retryApp = clocked({ draftModel: failing });
    const retryKey = await issue(retryApp.created.app, accountA);
    const first = await post(retryApp.created.app, "/v1/tasks", draftTask(), auth(retryKey));
    const firstId = ((await first.json()) as { id: string }).id;
    await retryApp.created.pumpTasks();
    const failedView = await (await retryApp.created.app.request(`/v1/tasks/${firstId}`, { headers: { authorization: `Bearer ${retryKey}` } })).json() as { state: string; error: { message: string } };
    expect(failedView.state).toBe("failed");
    expect(failedView.error.message).toBe("The draft model failed");
    expect(JSON.stringify(failedView)).not.toContain("sk-live");
    const second = await post(retryApp.created.app, "/v1/tasks", draftTask(), auth(retryKey));
    expect(((await second.json()) as { id: string }).id).not.toBe(firstId);
    await retryApp.created.pumpTasks();
    expect(failed).toBe(2);
    const publicApp = clocked({ deployment: { mode: "public", serviceOrigin: ORIGIN }, draftModel: model });
    const publicKey = await issue(publicApp.created.app, accountA);
    await expectError(await post(publicApp.created.app, "/v1/tasks", draftTask(), auth(publicKey)), 503, "model_unavailable");
    expect(model.calls).toBe(0);
  });

  it("keeps queued model work paused after restart with emergency disable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-disable-"));
    const dbPath = join(dir, "api.db");
    const model = countingModel();
    const first = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
    });
    opened.push(first);
    const key = await issue(first.app, accountA);
    const queued = await post(first.app, "/v1/tasks", draftTask("Check the requested policy"), auth(key));
    const view = await queued.json() as { id: string; state: string };
    expect(queued.status, JSON.stringify(view)).toBe(202);
    expect(view.state).toBe("queued");
    expect(model.calls).toBe(0);
    first.close();
    const second = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      draftModel: model,
      expensiveDisabled: true,
    });
    opened.push(second);
    second.reconcileTasks();
    await second.pumpTasks();
    expect(model.calls).toBe(0);
    const after = await (await second.app.request(`/v1/tasks/${view.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(after.state).toBe("queued");
  });

  it("rejects public synchronous drafts and compiles before any model or compiler call", async () => {
    const model = countingModel();
    const base = simulatedEngine();
    let compiles = 0;
    const engine = {
      ...base,
      async compile(input: Parameters<typeof base.compile>[0]) {
        compiles += 1;
        return base.compile(input);
      },
    };
    const { created } = clocked({
      deployment: { mode: "public", serviceOrigin: ORIGIN },
      draftModel: model,
      engine,
      budget: {
        requestCeilingMicroUsd: 50_000,
        dailyCeilingMicroUsd: 100_000,
        inputMicroUsdPerMillion: 1_250_000,
        outputMicroUsdPerMillion: 2_500_000,
      },
    });
    const key = await issue(created.app, accountA);
    await expectError(await post(created.app, "/v1/drafts", DRAFT_BODY, auth(key)), 403, "forbidden");
    expect(model.calls).toBe(0);
    const job = await createJob(created.app, key);
    await expectError(
      await post(created.app, `/v1/jobs/${job.jobId}/compile`, { revisionHash: job.revisionHash }, auth(key)),
      403,
      "forbidden",
    );
    expect(compiles).toBe(0);
    const task = await post(created.app, "/v1/tasks", { operation: "compile", jobId: job.jobId, revisionHash: job.revisionHash }, auth(key));
    expect(task.status).toBe(202);
    expect(compiles).toBe(0);
  });
});
