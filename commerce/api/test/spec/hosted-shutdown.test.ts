// Shutdown must stop the owned compiler before SQLite closes and before another process compiles.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { cliEngine, createApp, type CreatedApp } from "../../src/index.ts";
import { BUYER_TOKEN, T0, freshKey } from "./helpers.ts";
import { DRAFT_BODY, EMPTY_REF_HASH, revisionWith } from "./helpers-t56.ts";

const REVISION = revisionWith(EMPTY_REF_HASH);
const ORIGIN = "https://api.example.test";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const accountA = privateKeyToAccount(WALLET_A);
const opened: CreatedApp[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const app of opened.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": freshKey() };
}

async function post(app: CreatedApp["app"], path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function issue(app: CreatedApp["app"], account: PrivateKeyAccount) {
  const challenge = await post(app, "/v1/auth/challenge", { wallet: account.address.toLowerCase() }, { "content-type": "application/json" });
  const issued = await challenge.json() as { challengeId: string; message: string };
  expect(challenge.status, JSON.stringify(issued)).toBe(200);
  const signature = await account.signMessage({ message: issued.message });
  const keys = await post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature }, { "content-type": "application/json" });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // The compiler has not written the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`missing ${path}`);
}

describe("graceful task drain", () => {
  it("kills the owned compiler group and requeues the compile before close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-shutdown-"));
    dirs.push(dir);
    const dbPath = join(dir, "api.db");
    const pidFile = join(dir, "engine.pid");
    const childFile = join(dir, "descendant.pid");
    const script = join(dir, "controlled-engine.mjs");
    const nextPid = join(dir, "restart.pid");
    writeFileSync(
      script,
      `import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const cmd=process.argv[2];if(cmd!=="compile"){const h="0x"+"11".repeat(32);console.log(JSON.stringify({structureHash:h,rulesHash:h,preview:{}}));process.exit(0);}writeFileSync(process.env.FAKE_ENGINE_PIDFILE,String(process.pid));const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(process.env.FAKE_ENGINE_CHILD_PIDFILE,String(child.pid));setInterval(()=>{},1000);`,
    );
    const engine = cliEngine({
      bin: { command: process.execPath, args: [script] },
      workDir: join(dir, "work"),
      compileTimeoutMs: 5_000,
      env: { FAKE_ENGINE_PIDFILE: pidFile, FAKE_ENGINE_CHILD_PIDFILE: childFile },
    });
    const first = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      engine,
    });
    opened.push(first);
    const key = await issue(first.app, accountA);
    const created = await post(first.app, "/v1/jobs", { revision: REVISION, source: "import" }, auth(key));
    const job = await created.json() as { jobId: string; revision: { revisionHash: string } };
    expect(created.status, JSON.stringify(job)).toBe(201);
    const approved = await post(first.app, `/v1/jobs/${job.jobId}/approve`, {
      revisionHash: job.revision.revisionHash,
      referenceDigest: EMPTY_REF_HASH,
    }, { ...auth(key), "if-match": job.revision.revisionHash });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const queued = await post(first.app, "/v1/tasks", {
      operation: "compile",
      jobId: job.jobId,
      revisionHash: job.revision.revisionHash,
    }, auth(key));
    const task = await queued.json() as { id: string; state: string };
    expect(queued.status, JSON.stringify(task)).toBe(202);
    const pumping = first.pumpTasks();
    const enginePid = Number(await waitForFile(pidFile));
    const descendant = Number(await waitForFile(childFile));
    expect(alive(enginePid)).toBe(true);
    expect(alive(descendant)).toBe(true);
    await first.drainTasks(1_000);
    expect(alive(enginePid)).toBe(false);
    expect(alive(descendant)).toBe(false);
    await pumping;
    const drained = await (await first.app.request(`/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(drained.state).toBe("queued");
    await first.pumpTasks();
    expect(alive(enginePid)).toBe(false);
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(enginePid));
    first.close();
    const restartScript = join(dir, "restart-engine.mjs");
    writeFileSync(
      restartScript,
      `import {writeFileSync} from "node:fs";if(process.argv[2]!=="compile"){const h="0x"+"11".repeat(32);console.log(JSON.stringify({structureHash:h,rulesHash:h,preview:{}}));process.exit(0);}writeFileSync(${JSON.stringify(nextPid)},String(process.pid));process.exit(0);`,
    );
    const second = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      engine: cliEngine({
        bin: { command: process.execPath, args: [restartScript] },
        workDir: join(dir, "restart-work"),
      }),
    });
    opened.push(second);
    second.reconcileTasks();
    const resumed = await (await second.app.request(`/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(resumed.state).toBe("queued");
    expect(alive(enginePid)).toBe(false);
    expect(alive(descendant)).toBe(false);
    await second.pumpTasks();
    const restarted = Number(readFileSync(nextPid, "utf8").trim());
    expect(restarted).not.toBe(enginePid);
    expect(alive(enginePid)).toBe(false);
    expect(alive(descendant)).toBe(false);
    expect(alive(restarted)).toBe(false);
  });

  it("keeps a dispatched draft uncertain when the drain bound wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-shutdown-draft-"));
    dirs.push(dir);
    const dbPath = join(dir, "api.db");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let modelSignal: AbortSignal | undefined;
    const created = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      budget: {
        requestCeilingMicroUsd: 50_000,
        dailyCeilingMicroUsd: 100_000,
        inputMicroUsdPerMillion: 1_250_000,
        outputMicroUsdPerMillion: 2_500_000,
      },
      draftModel: {
        async draft(input) {
          modelSignal = input.signal;
          calls += 1;
          await gate;
          return { result: { kind: "clarification" as const, questions: ["Which file?"] }, model: "spec", traceId: "drain" };
        },
      },
    });
    opened.push(created);
    const key = await issue(created.app, accountA);
    const queued = await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: { ...DRAFT_BODY, request: "Count the words in drain.txt" },
    }, auth(key));
    const task = await queued.json() as { id: string };
    expect(queued.status, JSON.stringify(task)).toBe(202);
    const pumping = created.pumpTasks();
    const started = Date.now();
    let dispatched = false;
    while (Date.now() - started < 2_000) {
      const raw = new DatabaseSync(dbPath);
      const row = raw.prepare("SELECT dispatched_at FROM spend_reservations WHERE task_id = ?").get(task.id) as { dispatched_at: string | null } | undefined;
      raw.close();
      if (row?.dispatched_at) {
        dispatched = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(dispatched).toBe(true);
    expect(calls).toBe(1);
    await created.drainTasks(200);
    expect(modelSignal?.aborted).toBe(true);
    await created.pumpTasks();
    expect(calls).toBe(1);
    release();
    await pumping;
    const view = await (await created.app.request(`/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(view.state).toBe("uncertain");
    const raw = new DatabaseSync(dbPath);
    const reservation = raw.prepare("SELECT state, settled_micro_usd, ceiling_micro_usd FROM spend_reservations WHERE task_id = ?").get(task.id) as {
      state: string;
      settled_micro_usd: number | null;
      ceiling_micro_usd: number;
    };
    raw.close();
    expect(reservation).toEqual({ state: "uncertain", settled_micro_usd: null, ceiling_micro_usd: 50_000 });
    expect(reservation.settled_micro_usd).not.toBe(0);
  });
});
