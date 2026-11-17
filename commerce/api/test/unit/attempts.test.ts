import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, buyerHeaders, freshKey } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, revisionWith } from "../spec/helpers-t56.ts";

const ORIGIN = "https://api.example.test";
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const SOLVER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const OTHER = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const ATTEMPT = "7e5a0427-f47c-4508-b041-42a9ff58993e";
const EARLY = "11111111-1111-4111-8111-111111111111";
const MIDDLE = "22222222-2222-4222-8222-222222222222";
const CORE = "0x" + "11".repeat(20);
const ADAPTER = "0x" + "22".repeat(20);
const REPORTED_AT = new Date(T0).toISOString();

type App = ReturnType<typeof createApp>;
const opened: App[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(mode: "local" | "public" = "local") {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-attempts-"));
  dirs.push(dir);
  const clock = { t: T0 };
  const opts: CreateAppOptions = {
    dbPath: join(dir, "api.db"),
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
    deployment: { mode, serviceOrigin: ORIGIN },
  };
  const created = createApp(opts);
  opened.push(created);
  return { app: created.app, clock, dbPath: opts.dbPath };
}

function auth(key: string, idem = freshKey()): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idem };
}

async function post(app: App["app"], path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function issue(app: App["app"], account: PrivateKeyAccount) {
  const challenged = await post(app, "/v1/auth/challenge", { wallet: account.address.toLowerCase() });
  const challenge = await challenged.json() as { challengeId: string; message: string };
  expect(challenged.status, JSON.stringify(challenge)).toBe(200);
  const signature = await account.signMessage({ message: challenge.message });
  const issued = await post(app, "/v1/auth/keys", { challengeId: challenge.challengeId, signature });
  const body = await issued.json() as { key: string; wallet: string };
  expect(issued.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function createJob(app: App["app"], key: string) {
  const res = await post(app, "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import" }, auth(key));
  const body = await res.json() as { jobId: string; state: string };
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body;
}

function events(start: number, count: number, phase = "proving") {
  return Array.from({ length: count }, (_, index) => ({
    cursor: start + index,
    reportedAt: REPORTED_AT,
    phase,
  }));
}

function attemptBody(attemptId: string, extra: Record<string, unknown> = {}, count = 1, phase = "preparing") {
  return { version: 1, attemptId, events: events(1, count, phase), ...extra };
}

function linkJob(dbPath: string, jobId: string) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    `INSERT INTO open_claim_links
      (job_id, chain_id, core, adapter, chain_job_id, funding_tx, registration_tx, verified_at)
     VALUES (?, 5042002, ?, ?, '7', ?, ?, ?)`,
  ).run(jobId, CORE, ADAPTER, "0x" + "aa".repeat(32), "0x" + "bb".repeat(32), REPORTED_AT);
  db.close();
}

it("rejects the shared buyer token and publishes only for the authenticated wallet", async () => {
  const { app } = setup();
  const owner = await issue(app, OWNER);
  const solver = await issue(app, SOLVER);
  const other = await issue(app, OTHER);
  const job = await createJob(app, owner.key);
  const legacy = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT), buyerHeaders());
  expect(legacy.status).toBe(401);
  const key = freshKey();
  const created = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT.toUpperCase()), auth(solver.key, key));
  const body = await created.json() as {
    attemptId: string; solver: string; phase: string; progress: string; accepted: number;
    confirmedPayment: boolean; confirmedWinner: null; confirmedRefund: boolean; highWaterCursor: number;
  };
  expect(created.status, JSON.stringify(body)).toBe(201);
  expect(body).toMatchObject({
    attemptId: ATTEMPT,
    solver: solver.wallet,
    phase: "preparing",
    progress: "solver-reported",
    accepted: 1,
    confirmedPayment: false,
    confirmedWinner: null,
    confirmedRefund: false,
    highWaterCursor: 1,
  });
  expect(JSON.stringify(body)).not.toContain("paymentConfirmed");
  const replay = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT.toUpperCase()), auth(solver.key, key));
  expect(replay.status).toBe(201);
  expect(replay.headers.get("idempotent-replayed")).toBe("true");
  expect(await replay.json()).toEqual(body);
  const changed = await post(
    app,
    `/v1/jobs/${job.jobId}/attempts`,
    attemptBody(ATTEMPT, {}, 1, "proving"),
    auth(solver.key, key),
  );
  expect(changed.status).toBe(422);
  const again = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT), auth(solver.key));
  const againBody = await again.json() as { accepted: number };
  expect(again.status, JSON.stringify(againBody)).toBe(200);
  expect(againBody.accepted).toBe(0);
  const stolen = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT, {}, 1, "claimed"), auth(other.key));
  expect(stolen.status).toBe(403);
  const view = await app.request(`/v1/jobs/${job.jobId}`);
  expect((await view.json() as { state: string }).state).toBe(job.state);
});

it("appends contiguous cursors and keeps a conflicting cursor from changing history", async () => {
  const { app } = setup();
  const owner = await issue(app, OWNER);
  const solver = await issue(app, SOLVER);
  const job = await createJob(app, owner.key);
  expect((await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT), auth(solver.key))).status).toBe(201);
  const appended = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
    version: 1,
    attemptId: ATTEMPT,
    events: events(2, 1, "claimed"),
    reportedClaimTx: "0x" + "ab".repeat(32),
    reportedWinner: SOLVER.address,
  }, auth(solver.key));
  const body = await appended.json() as { accepted: number; phase: string; confirmedPayment: boolean; reportedClaimTx: string };
  expect(appended.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({
    accepted: 1,
    phase: "claimed",
    confirmedPayment: false,
    confirmedWinner: null,
    reportedClaimTx: "0x" + "ab".repeat(32),
    reportedWinner: solver.wallet,
  });
  const gap = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
    version: 1, attemptId: ATTEMPT, events: events(4, 1, "released"),
  }, auth(solver.key));
  expect(gap.status).toBe(409);
  const clash = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
    version: 1, attemptId: ATTEMPT, events: [{ cursor: 1, reportedAt: REPORTED_AT, phase: "lost" }],
  }, auth(solver.key));
  expect(clash.status).toBe(409);
  const detail = await app.request(`/v1/jobs/${job.jobId}/attempts/${ATTEMPT}`);
  const viewed = await detail.json() as { highWaterCursor: number; phase: string; events: { cursor: number; phase: string }[] };
  expect(detail.status, JSON.stringify(viewed)).toBe(200);
  expect(viewed.highWaterCursor).toBe(2);
  expect(viewed.events.map((event) => event.phase)).toEqual(["preparing", "claimed"]);
  expect((await (await app.request(`/v1/jobs/${job.jobId}`)).json() as { state: string }).state).toBe("drafted");
});

it("rejects unknown fields, a late solver clock, and a chain binding that is not linked", async () => {
  const { app, dbPath } = setup();
  const owner = await issue(app, OWNER);
  const solver = await issue(app, SOLVER);
  const job = await createJob(app, owner.key);
  const leaked = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
    ...attemptBody(ATTEMPT),
    detail: "/tmp/secret-solver-path",
    paymentConfirmed: true,
  }, auth(solver.key));
  const leakedText = await leaked.text();
  expect(leaked.status).toBe(400);
  expect(leakedText).not.toContain("secret-solver-path");
  const late = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
    version: 1,
    attemptId: ATTEMPT,
    events: [{ cursor: 1, reportedAt: new Date(T0 + 6 * 60 * 1000).toISOString(), phase: "preparing" }],
  }, auth(solver.key));
  expect(late.status).toBe(400);
  const unbound = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT, {
    chain: { chainId: 5042002, core: CORE, adapter: ADAPTER, jobId: "7" },
  }), auth(solver.key));
  expect(unbound.status).toBe(409);
  linkJob(dbPath, job.jobId);
  const mismatch = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(ATTEMPT, {
    chain: { chainId: 5042002, core: CORE, adapter: ADAPTER, jobId: "8" },
  }), auth(solver.key));
  expect(mismatch.status).toBe(409);
  const bound = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(EARLY), auth(solver.key));
  const boundBody = await bound.json() as { chain: { jobId: string; chainId: number } };
  expect(bound.status, JSON.stringify(boundBody)).toBe(201);
  expect(boundBody.chain).toEqual({ chainId: 5042002, core: CORE, adapter: ADAPTER, jobId: "7" });
});

it("pages attempts and events without treating solver progress as confirmation", async () => {
  const { app } = setup();
  const owner = await issue(app, OWNER);
  const solver = await issue(app, SOLVER);
  const job = await createJob(app, owner.key);
  for (const attemptId of [ATTEMPT, MIDDLE, EARLY]) {
    const res = await post(app, `/v1/jobs/${job.jobId}/attempts`, attemptBody(attemptId), auth(solver.key));
    expect(res.status, await res.clone().text()).toBe(201);
  }
  const first = await app.request(`/v1/jobs/${job.jobId}/attempts?limit=1`);
  const firstBody = await first.json() as { attempts: { attemptId: string }[]; nextCursor: string | null };
  expect(first.status).toBe(200);
  expect(firstBody.attempts.map((item) => item.attemptId)).toEqual([EARLY]);
  expect(firstBody.nextCursor).toBeTruthy();
  const second = await app.request(`/v1/jobs/${job.jobId}/attempts?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`);
  const secondBody = await second.json() as { attempts: { attemptId: string }[]; nextCursor: string | null };
  expect(secondBody.attempts.map((item) => item.attemptId)).toEqual([MIDDLE]);
  const third = await app.request(`/v1/jobs/${job.jobId}/attempts?limit=1&cursor=${encodeURIComponent(secondBody.nextCursor ?? "")}`);
  const thirdBody = await third.json() as { attempts: { attemptId: string }[]; nextCursor: string | null };
  expect(thirdBody.attempts.map((item) => item.attemptId)).toEqual([ATTEMPT]);
  expect(thirdBody.nextCursor).toBeNull();
  expect((await (await app.request(`/v1/jobs/${job.jobId}/attempts?limit=51`)).json() as { error: { code: string } }).error.code).toBe("validation_failed");
  expect((await (await app.request(`/v1/jobs/${job.jobId}/attempts?cursor=not-a-cursor`)).json() as { error: { code: string } }).error.code).toBe("validation_failed");

  let cursor = 2;
  while (cursor <= 51) {
    const count = Math.min(20, 52 - cursor);
    const res = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
      version: 1, attemptId: EARLY, events: events(cursor, count, "proving"),
    }, auth(solver.key));
    expect(res.status, await res.clone().text()).toBe(200);
    cursor += count;
  }
  const page = await app.request(`/v1/jobs/${job.jobId}/attempts/${EARLY}?afterCursor=0`);
  const pageBody = await page.json() as {
    events: { cursor: number }[]; nextCursor: number; resumeCursor: number | null; confirmedPayment: boolean;
  };
  expect(pageBody.events).toHaveLength(50);
  expect(pageBody.nextCursor).toBe(51);
  expect(pageBody.resumeCursor).toBe(50);
  expect(pageBody.confirmedPayment).toBe(false);
  const rest = await app.request(`/v1/jobs/${job.jobId}/attempts/${EARLY}?afterCursor=50`);
  const restBody = await rest.json() as { events: { cursor: number }[]; resumeCursor: number | null };
  expect(restBody.events.map((event) => event.cursor)).toEqual([51]);
  expect(restBody.resumeCursor).toBeNull();
  expect((await (await app.request(`/v1/jobs/${job.jobId}/attempts/${EARLY}?afterCursor=52`)).status)).toBe(400);
  const otherJob = await createJob(app, owner.key);
  expect((await post(app, `/v1/jobs/${otherJob.jobId}/attempts`, attemptBody(EARLY), auth(solver.key))).status).toBe(409);
  expect((await app.request(`/v1/jobs/${otherJob.jobId}/attempts/${EARLY}`)).status).toBe(404);
});

it("stops a new event once the attempt history is full", async () => {
  const { app } = setup("public");
  const legacy = await post(app, "/v1/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/attempts", attemptBody(ATTEMPT), buyerHeaders());
  expect(legacy.status).toBe(401);
  const owner = await issue(app, OWNER);
  const solver = await issue(app, SOLVER);
  const job = await createJob(app, owner.key);
  for (let cursor = 1; cursor <= 200; cursor += 20) {
    const res = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
      version: 1, attemptId: ATTEMPT, events: events(cursor, 20, cursor === 1 ? "preparing" : "proving"),
    }, auth(solver.key));
    expect(res.status, await res.clone().text()).toBe(cursor === 1 ? 201 : 200);
  }
  const overflow = await post(app, `/v1/jobs/${job.jobId}/attempts`, {
    version: 1, attemptId: ATTEMPT, events: events(201, 1, "abandoned"),
  }, auth(solver.key));
  expect(overflow.status).toBe(413);
  const detail = await app.request(`/v1/jobs/${job.jobId}/attempts/${ATTEMPT}?afterCursor=200`);
  const body = await detail.json() as { highWaterCursor: number; events: unknown[] };
  expect(body.highWaterCursor).toBe(200);
  expect(body.events).toEqual([]);
});
