import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { createApp, type CreatedApp, type Engine, type SettlementResponse, paidCompileLimitFromEnv } from "../../src/index.ts";
import { BUYER_TOKEN, T0, freshKey } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, approveOk, countingEngine, createJob56, json, req, revisionWith } from "../spec/helpers-t56.ts";

const asset = "0x3600000000000000000000000000000000000000" as Address;
const payTo = "0x1111111111111111111111111111111111111111" as Address;
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const accountA = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OPERATOR = "operator-token-0123456789";
const types = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;
let nonce = 0;
const opened: CreatedApp[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const app of opened.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-paid-"));
  dirs.push(dir);
  return join(dir, "api.db");
}

function payments(path: string): { payment_id: string; state: string }[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT payment_id, state FROM x402_payments ORDER BY created_at").all() as { payment_id: string; state: string }[];
  } finally {
    db.close();
  }
}

function taskState(path: string, id: string): string {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string } | undefined;
    return row?.state ?? "";
  } finally {
    db.close();
  }
}

type Fac = {
  settlements: number;
  settle: (payload: unknown, requirements: unknown) => Promise<SettlementResponse>;
  release: () => void;
  holdNext: () => void;
};

function hangingFacilitator(): Fac {
  let settlements = 0;
  let hold = false;
  let release = (): void => undefined;
  let gate = Promise.resolve();
  return {
    get settlements() { return settlements; },
    release: () => release(),
    holdNext() {
      hold = true;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async settle() {
      settlements += 1;
      if (!hold) return { success: true, payer: payer.address, transaction: "0x" + "ab".repeat(32), network: "eip155:5042002" };
      hold = false;
      await gate;
      return { success: true, payer: payer.address, transaction: "0x" + "ab".repeat(32), network: "eip155:5042002" };
    },
  };
}

function setup(opts: {
  limit?: number;
  dbPath?: string;
  hangSettle?: boolean;
  failCompile?: boolean;
  hangCompile?: boolean;
} = {}) {
  const dbPath = opts.dbPath ?? tempDb();
  let releaseCompile = (): void => undefined;
  let compileGate = new Promise<void>((resolve) => {
    releaseCompile = resolve;
  });
  let compiles = 0;
  const engine = countingEngine({
    compile: async (input) => {
      compiles += 1;
      if (opts.hangCompile && compiles === 1) await compileGate;
      if (opts.failCompile && compiles === 1) throw new Error("transient compile failure");
      return countingEngine().compile(input);
    },
  });
  const facilitator = hangingFacilitator();
  const made = createApp({
    dbPath,
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    engine: engine as unknown as Engine,
    operatorToken: OPERATOR,
    paidCompileLimit: opts.limit ?? 2,
    deployment: { mode: "local", serviceOrigin: "https://api.example.test" },
    x402: {
      resourceBaseUrl: "https://api.example.test",
      network: "eip155:5042002",
      asset,
      payTo,
      amount: "10000",
      extra: { name: "USD Coin", version: "2" },
      facilitator,
    },
  });
  opened.push(made);
  const spec = { app: made.app, close: made.close, clock: { t: T0 } };
  return { made, spec, engine, facilitator, dbPath, releaseCompile };
}

async function job(spec: { app: CreatedApp["app"]; close: () => void; clock: { t: number } }) {
  const created = await createJob56(spec, revisionWith(EMPTY_REF_HASH));
  await approveOk(spec, created.jobId, created.revisionHash, EMPTY_REF_HASH);
  return created;
}

async function request(spec: { app: CreatedApp["app"]; close: () => void; clock: { t: number } }, created: { jobId: string; revisionHash: string }, payload?: unknown) {
  return req(spec, "POST", `/v1/jobs/${created.jobId}/paid-compile`, { revisionHash: created.revisionHash },
    payload ? { "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") } : {});
}

async function signed(challenge: Response) {
  const quote = JSON.parse(Buffer.from(challenge.headers.get("payment-required")!, "base64").toString("utf8"));
  const accepted = quote.accepts[0];
  const authorization = {
    from: payer.address, to: accepted.payTo, value: accepted.amount,
    validAfter: String(T0 / 1000 - 1), validBefore: String(T0 / 1000 + 3600),
    nonce: ("0x" + (++nonce).toString(16).padStart(64, "0")) as Hex,
  };
  const signature = await payer.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: asset },
    types, primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(accepted.amount), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2 as const, resource: quote.resource, accepted, payload: { signature, authorization }, extensions: {} };
}

async function metrics(made: CreatedApp): Promise<{ paidCompile: { active: number; waiting: number; rejected: number; limit: number }; resources: { hostQuota: string } }> {
  const res = await made.app.request("/v1/operator/metrics", { headers: { authorization: `Bearer ${OPERATOR}` } });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ paidCompile: { active: number; waiting: number; rejected: number; limit: number }; resources: { hostQuota: string } }>;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 2_000) throw new Error("timed out waiting for paid compile state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function authHeaders(app: CreatedApp["app"], account: PrivateKeyAccount): Promise<Record<string, string>> {
  const challenge = await app.request("/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address.toLowerCase() }),
  });
  const issued = await challenge.json() as { challengeId: string; message: string };
  const signature = await account.signMessage({ message: issued.message });
  const keys = await app.request("/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: issued.challengeId, signature }),
  });
  const body = await keys.json() as { key: string };
  return { authorization: `Bearer ${body.key}`, "content-type": "application/json", "idempotency-key": freshKey() };
}

it("refuses a new payment at capacity before settlement and before a new row", async () => {
  const { made, spec, facilitator, dbPath } = setup({ limit: 1 });
  const created = await job(spec);
  const first = await signed(await request(spec, created));
  const second = await signed(await request(spec, created));
  facilitator.holdNext();
  const pending = request(spec, created, first);
  try {
    await waitFor(async () => (await metrics(made)).paidCompile.active === 1);
    const refused = await request(spec, created, second);
    const body = await json(refused);
    expect(refused.status).toBe(429);
    expect(body.error).toMatchObject({ code: "rate_limited", message: "Paid compile queue is full", details: { queue: "paid-compile", scope: "global" } });
    expect(facilitator.settlements).toBe(1);
    expect(payments(dbPath)).toHaveLength(1);
    const view = await metrics(made);
    expect(view.paidCompile.rejected).toBeGreaterThanOrEqual(1);
    expect(view.paidCompile.limit).toBe(1);
    expect(view.resources.hostQuota).toBe("not_enforced");
  } finally {
    facilitator.release();
    await pending;
  }
});

it("returns an exact completed replay while the paid compile cap is full", async () => {
  const { made, spec, facilitator, dbPath } = setup({ limit: 1 });
  const created = await job(spec);
  const first = await signed(await request(spec, created));
  const done = await request(spec, created, first);
  expect(done.status).toBe(200);
  const stored = await done.clone().text();
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM approvals WHERE job_id = ?").run(created.jobId);
  db.close();
  const another = await job(spec);
  const second = await signed(await request(spec, another));
  facilitator.holdNext();
  const pending = request(spec, another, second);
  try {
    await waitFor(async () => (await metrics(made)).paidCompile.active === 1);
    const replay = await request(spec, created, first);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(stored);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(facilitator.settlements).toBe(2);
  } finally {
    facilitator.release();
    await pending;
  }
  expect(facilitator.settlements).toBe(2);
});

it("settles one concurrent payment once and rechecks approval before a second charge", async () => {
  const dbPath = tempDb();
  const { made, spec, facilitator, engine, releaseCompile } = setup({ limit: 3, dbPath, hangCompile: true });
  const created = await job(spec);
  const first = await signed(await request(spec, created));
  const another = await job(spec);
  const other = await signed(await request(spec, another));
  const pendingFirst = request(spec, created, first);
  const pendingOther = request(spec, another, other);
  let duplicate: Promise<Response> = Promise.resolve(new Response());
  try {
    await waitFor(() => engine.compileCalls.length === 1);
    await waitFor(async () => (await metrics(made)).paidCompile.waiting === 1);
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM approvals WHERE revision_id IN (SELECT id FROM revisions WHERE job_id = ?)").run(another.jobId);
    db.close();
    duplicate = request(spec, created, first);
  } finally {
    releaseCompile();
  }
  const [firstResult, otherResult, duplicateResult] = await Promise.all([pendingFirst, pendingOther, duplicate]);
  expect(firstResult.status).toBe(200);
  expect(otherResult.status).toBe(409);
  expect((await json(otherResult)).error.code).toBe("approval_required");
  expect([firstResult, duplicateResult].filter((res) => res.headers.get("idempotent-replayed") === "true")).toHaveLength(1);
  expect(facilitator.settlements).toBe(1);
  expect(payments(dbPath)).toHaveLength(1);
});

it("resumes a settled compile without a second charge and refuses that resume while the cap is full", async () => {
  const { made, spec, facilitator, dbPath } = setup({ limit: 1, failCompile: true });
  const created = await job(spec);
  const first = await signed(await request(spec, created));
  expect((await request(spec, created, first)).status).toBe(502);
  expect(payments(dbPath)).toEqual([expect.objectContaining({ state: "settled" })]);
  const other = await signed(await request(spec, created));
  facilitator.holdNext();
  const pending = request(spec, created, other);
  try {
    await waitFor(async () => (await metrics(made)).paidCompile.active === 1);
    const blocked = await request(spec, created, first);
    expect(blocked.status).toBe(429);
    expect((await json(blocked)).error.details).toMatchObject({ queue: "paid-compile", scope: "global" });
    expect(facilitator.settlements).toBe(2);
    expect(payments(dbPath).filter((row) => row.state === "settled" || row.state === "complete")).toHaveLength(1);
  } finally {
    facilitator.release();
    await pending;
  }
  const resumed = await request(spec, created, first);
  expect(resumed.status, await resumed.clone().text()).toBe(200);
  expect(facilitator.settlements).toBe(2);
});

it("leaves a durable compile queued when the external compiler is busy", async () => {
  const dbPath = tempDb();
  const { made, spec, engine, releaseCompile } = setup({ limit: 1, dbPath, hangCompile: true });
  const headers = await authHeaders(made.app, accountA);
  const created = await req(spec, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import" }, headers);
  const body = await json(created);
  expect(created.status, JSON.stringify(body)).toBe(201);
  const approved = await req(spec, "POST", `/v1/jobs/${body.jobId}/approve`, {
    revisionHash: body.revision.revisionHash, referenceDigest: EMPTY_REF_HASH,
  }, { ...headers, "idempotency-key": freshKey(), "if-match": `"${body.revision.revisionHash}"` });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const queued = await req(spec, "POST", "/v1/tasks", {
    operation: "compile", jobId: body.jobId, revisionHash: body.revision.revisionHash,
  }, { ...headers, "idempotency-key": freshKey() });
  const task = await json(queued);
  expect(queued.status, JSON.stringify(task)).toBe(202);
  const payload = await signed(await request(spec, { jobId: body.jobId, revisionHash: body.revision.revisionHash }));
  const pending = request(spec, { jobId: body.jobId, revisionHash: body.revision.revisionHash }, payload);
  try {
    await waitFor(() => engine.compileCalls.length === 1);
    await made.pumpTasks();
    expect(taskState(dbPath, task.id)).toBe("queued");
  } finally {
    releaseCompile();
    await pending;
  }
  await made.pumpTasks();
  expect(taskState(dbPath, task.id)).toBe("succeeded");
  expect(engine.compileCalls.length).toBe(1);
});

it("cancels a waiting paid compile on drain and does not compile after shutdown", async () => {
  const { made, spec, facilitator, engine, dbPath } = setup({ limit: 2 });
  const created = await job(spec);
  const first = await signed(await request(spec, created));
  const second = await signed(await request(spec, created));
  facilitator.holdNext();
  const active = request(spec, created, first);
  try {
    await waitFor(async () => (await metrics(made)).paidCompile.active === 1);
    const waiting = request(spec, created, second);
    await waitFor(async () => (await metrics(made)).paidCompile.waiting === 1);
    const drained = made.drainTasks(1_000);
    const waitingResult = await waiting;
    expect(waitingResult.status).toBe(429);
    expect((await json(waitingResult)).error).toMatchObject({
      code: "rate_limited",
      message: "Paid compile is not accepting work",
      details: { queue: "paid-compile", scope: "draining" },
    });
    expect(facilitator.settlements).toBe(1);
    facilitator.release();
    const activeResult = await active;
    expect(activeResult.status).toBe(429);
    expect(engine.compileCalls).toHaveLength(0);
    await drained;
  } finally {
    facilitator.release();
  }
  const third = await signed(await request(spec, created));
  const after = await request(spec, created, third);
  expect(after.status).toBe(429);
  expect(facilitator.settlements).toBe(1);
  expect(payments(dbPath)).toHaveLength(1);
  expect(payments(dbPath)[0]?.state).toBe("settled");
});

it("rejects a non positive paid compile limit before opening the database", () => {
  const dbPath = tempDb();
  try {
    opened.push(createApp({ dbPath, buyerToken: BUYER_TOKEN, paidCompileLimit: 0 }));
    expect.fail("createApp accepted a zero paid compile limit");
  } catch (err) {
    expect(err instanceof Error ? err.message : "").toMatch(/paidCompileLimit must be a positive safe integer/);
  }
  expect(existsSync(dbPath)).toBe(false);
});


it("preserves an uncertain settlement when its facilitator responds after drain and database close", async () => {
  const { made, spec, facilitator, engine, dbPath } = setup();
  const created = await job(spec);
  const payload = await signed(await request(spec, created));
  facilitator.holdNext();
  const active = request(spec, created, payload);
  try {
    await waitFor(() => facilitator.settlements === 1);
    await made.drainTasks(1);
    made.close();
  } finally {
    facilitator.release();
  }
  const response = await active;
  expect(response.status).toBe(409);
  expect((await json(response)).error.code).toBe("payment_pending");
  expect(engine.compileCalls).toHaveLength(0);
  expect(payments(dbPath)).toEqual([expect.objectContaining({ state: "settling" })]);
});

it("does not publish an artifact when an uncooperative compiler completes after database close", async () => {
  const { made, spec, facilitator, engine, dbPath, releaseCompile } = setup({ hangCompile: true });
  const created = await job(spec);
  const payload = await signed(await request(spec, created));
  const active = request(spec, created, payload);
  try {
    await waitFor(() => engine.compileCalls.length === 1);
    await made.drainTasks(1);
    made.close();
  } finally {
    releaseCompile();
  }
  const response = await active;
  expect(response.status).toBe(429);
  expect((await json(response)).error.code).toBe("rate_limited");
  expect(response.headers.get("payment-response")).not.toBeNull();
  expect(facilitator.settlements).toBe(1);
  expect(payments(dbPath)).toEqual([expect.objectContaining({ state: "settled" })]);
  const db = new DatabaseSync(dbPath);
  try { expect(db.prepare("SELECT COUNT(*) AS n FROM manifests").get()).toMatchObject({ n: 0 }); }
  finally { db.close(); }
});

it("releases compiler ownership if durable task claiming rolls back", async () => {
  const { made, spec, engine, dbPath } = setup();
  const headers = await authHeaders(made.app, accountA);
  const response = await req(spec, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import" }, headers);
  const created = await json(response);
  const binding = { jobId: created.jobId, revisionHash: created.revision.revisionHash };
  expect((await req(spec, "POST", `/v1/jobs/${binding.jobId}/approve`, { revisionHash: binding.revisionHash, referenceDigest: EMPTY_REF_HASH },
    { ...headers, "idempotency-key": freshKey(), "if-match": `"${binding.revisionHash}"` })).status).toBe(200);
  expect((await req(spec, "POST", "/v1/tasks", { operation: "compile", ...binding }, { ...headers, "idempotency-key": freshKey() })).status).toBe(202);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER reject_claim BEFORE UPDATE ON tasks WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'controlled claim failure'); END");
  try { await expect(made.pumpTasks()).rejects.toThrow("controlled claim failure"); }
  finally { db.exec("DROP TRIGGER reject_claim"); db.close(); }
  const payload = await signed(await request(spec, binding));
  const paid = request(spec, binding, payload);
  try {
    await waitFor(() => engine.compileCalls.length === 1);
    expect((await paid).status).toBe(200);
  } finally { made.close(); await paid; }
});


it("parses the paid admission environment limit without echoing invalid input", () => {
  expect(paidCompileLimitFromEnv({})).toBe(2);
  expect(paidCompileLimitFromEnv({ PAID_COMPILE_LIMIT: "3" })).toBe(3);
  for (const raw of ["0", "-1", "1.5", "01", "", "secret-value", "9007199254740992"]) {
    expect(() => paidCompileLimitFromEnv({ PAID_COMPILE_LIMIT: raw })).toThrow("PAID_COMPILE_LIMIT must be a positive safe integer");
  }
});
