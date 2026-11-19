import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, simulatedEngine, type CreateAppOptions, type Engine } from "../../src/index.ts";
import { BUYER_TOKEN, PROVIDER_KEY, OTHER_KEY, freshKey } from "./helpers.ts";
import { EMPTY_REF_HASH, revisionWith } from "./helpers-t56.ts";
import { startPumpTimer } from "../../src/pump-timer.ts";

const SERVICE = "bot-only-service-credential-" + "x".repeat(32);
const MCP = "/integrations/grok-bot/mcp";
const plan = { version: 1, rules: [{ op: "literal", type: "bool", value: true }] };
const revision = () => revisionWith(EMPTY_REF_HASH, plan);
const examples = [
  { name: "accepted", predictedVerdict: 1 as const, files: [{ name: "result.json", content: "yes" }] },
  { name: "rejected", predictedVerdict: 0 as const, files: [{ name: "result.json", content: "no" }] },
];
type Delivery = { reviewId: string; callbackTicket: string; inputHash: string; input: unknown; expiresAt: number; callbackUrl: string };
const opened: ReturnType<typeof createApp>[] = [];
const dirs: string[] = [];
afterEach(() => { for (const app of opened.splice(0)) app.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
function setup(extra: Partial<CreateAppOptions> = {}) {
  const sends: Delivery[] = [];
  const evalFn = vi.fn<NonNullable<Engine["eval"]>>(async ({ deliverables }) => ({ ok: true,
    verdict: Buffer.from(deliverables[0]!.content).toString() === "yes" ? 1 : 0 }));
  const created = createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN,
    deployment: { mode: "local", serviceOrigin: "https://api.example.test" },
    engine: { ...simulatedEngine(), eval: evalFn },
    botReview: { serviceToken: SERVICE, dispatch: async input => { sends.push(input); } }, ...extra });
  opened.push(created); return { ...created, sends, evalFn };
}
async function post(app: ReturnType<typeof createApp>["app"], path: string, body: unknown, key?: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json",
    ...(key ? { authorization: `Bearer ${key}`, "idempotency-key": freshKey() } : {}), ...headers }, body: JSON.stringify(body) });
}
async function issue(app: ReturnType<typeof createApp>["app"], key: `0x${string}` = PROVIDER_KEY) {
  const account = privateKeyToAccount(key);
  const response = await post(app, "/v1/auth/challenge", { wallet: account.address.toLowerCase() });
  const challenge = await response.json() as { challengeId: string; message: string };
  const issued = await post(app, "/v1/auth/keys", { challengeId: challenge.challengeId, signature: await account.signMessage({ message: challenge.message }) });
  return (await issued.json() as { key: string }).key;
}
async function job(app: ReturnType<typeof createApp>["app"], key: string) {
  const response = await post(app, "/v1/jobs", { revision: revision(), source: "import" }, key);
  const result = await response.json() as { jobId: string; revision: { revisionHash: string } };
  expect(response.status, JSON.stringify(result)).toBe(201);
  return { jobId: result.jobId, revisionHash: result.revision.revisionHash };
}
function reviewBody(revisionHash: string) { return { revisionHash, request: "Require approval.", examples }; }
async function review(app: ReturnType<typeof createApp>["app"], key: string, jobId: string, revisionHash: string) {
  return post(app, `/v1/jobs/${jobId}/bot-reviews`, reviewBody(revisionHash), key);
}
function result(delivery: Delivery) {
  return { version: 1, reviewId: delivery.reviewId, inputHash: delivery.inputHash,
    decision: "pass", coveredRuleIndices: [0], findings: [], questions: [] };
}
async function rpc(app: ReturnType<typeof createApp>["app"], body: unknown, token = SERVICE, headers: Record<string, string> = {}) {
  return post(app, MCP, body, undefined, { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", ...headers });
}
async function callback(app: ReturnType<typeof createApp>["app"], delivery: Delivery, value: unknown = result(delivery)) {
  const response = await rpc(app, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "submit_constraint_review",
    arguments: { reviewId: delivery.reviewId, callbackTicket: delivery.callbackTicket, result: value } } });
  return response.json() as Promise<any>;
}
async function approve(app: ReturnType<typeof createApp>["app"], key: string, jobId: string, revisionHash: string, botReviewId?: string) {
  return post(app, `/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest: EMPTY_REF_HASH,
    ...(botReviewId ? { botReviewId } : {}) }, key, { "if-match": revisionHash });
}
async function status(app: ReturnType<typeof createApp>["app"], key: string, jobId: string, reviewId: string) {
  const response = await app.request(`/v1/jobs/${jobId}/bot-reviews/${reviewId}`, { headers: { authorization: `Bearer ${key}` } });
  return (await response.json() as any).status;
}

describe("live Bot review integration with a controlled transport", () => {
  it("rejects unrestricted Bot dispatch in public mode before opening a database", () => {
    expect(() => createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN,
      deployment: { mode: "public", serviceOrigin: "https://api.example.test" },
      engine: simulatedEngine(), botReview: { serviceToken: SERVICE, dispatch: async () => undefined } }))
      .toThrow("Public Bot dispatch requires the one-wallet pilot policy");
  });
  it("accepts a three-dispatch one-wallet pilot in public mode", () => {
    const owner = privateKeyToAccount(PROVIDER_KEY).address.toLowerCase();
    const created = createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN,
      deployment: { mode: "public", serviceOrigin: "https://api.example.test" },
      engine: simulatedEngine(), botReview: { serviceToken: SERVICE,
        dispatch: async () => undefined, pilotOwner: owner, maxDispatches: 3 } });
    created.close();
  });
  it("accepts ten dispatches only for a local one-wallet pilot", () => {
    const owner = privateKeyToAccount(PROVIDER_KEY).address.toLowerCase();
    const botReview = { serviceToken: SERVICE, dispatch: async () => undefined,
      pilotOwner: owner, maxDispatches: 10 as const };
    expect(() => createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN,
      deployment: { mode: "public", serviceOrigin: "https://api.example.test" },
      engine: simulatedEngine(), botReview })).toThrow("Public Bot dispatch requires the one-wallet pilot policy");
    expect(() => createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN,
      deployment: { mode: "local", serviceOrigin: "https://api.example.test" },
      engine: simulatedEngine(), botReview: { ...botReview, pilotOwner: undefined } })).toThrow();
    const created = setup({ botReview });
    expect(created.app).toBeDefined();
  });
  it("restricts a live pilot to one owner and one durable trigger", async () => {
    const owner = privateKeyToAccount(PROVIDER_KEY).address.toLowerCase();
    const dispatch = vi.fn(async () => undefined);
    const { app } = setup({ botReview: { serviceToken: SERVICE, dispatch, pilotOwner: owner, maxDispatches: 1 } });
    const otherKey = await issue(app, OTHER_KEY), otherJob = await job(app, otherKey);
    expect((await review(app, otherKey, otherJob.jobId, otherJob.revisionHash)).status).toBe(403);
    const key = await issue(app), first = await job(app, key);
    expect((await review(app, key, first.jobId, first.revisionHash)).status).toBe(202);
    const second = await job(app, key);
    expect((await review(app, key, second.jobId, second.revisionHash)).status).toBe(503);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("allows one more dispatch for the configured objection across API restarts", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "ubc26-recovery-"));
    dirs.push(dbDir);
    const dbPath = join(dbDir, "db.sqlite");
    const sends: Delivery[] = [];
    const pilot = {
      serviceToken: SERVICE, pilotOwner: privateKeyToAccount(PROVIDER_KEY).address.toLowerCase(),
      maxDispatches: 1 as const, dispatch: async (delivery: Delivery) => { sends.push(delivery); },
    };
    const first = setup({ dbPath, botReview: pilot });
    const key = await issue(first.app), target = await job(first.app, key);
    expect((await review(first.app, key, target.jobId, target.revisionHash)).status).toBe(202);
    const objection = sends[0]!;
    await callback(first.app, objection, { ...result(objection), decision: "needs_changes",
      findings: [{ kind: "omission", sourceQuote: "Require approval.", ruleIndices: [0], message: "Review this rule." }] });
    const revise = (app: typeof first.app, value = revision(), ifMatch = target.revisionHash) => post(app,
      `/v1/jobs/${target.jobId}/revisions`, { source: "import", revision: value }, key, { "if-match": ifMatch });
    const other = await job(first.app, key);
    first.close();

    const botReview = { ...pilot, recoveryReviewId: objection.reviewId };
    const second = setup({ dbPath, botReview });
    expect((await review(second.app, key, other.jobId, other.revisionHash)).status).toBe(503);
    const existing = await review(second.app, key, target.jobId, target.revisionHash);
    expect((await existing.json() as any).reviewId).toBe(objection.reviewId);
    expect(sends).toHaveLength(1);
    const different = await revise(second.app, { ...revision(), maxBudget: "6000000" });
    expect(different.status).toBe(201);
    const { revision: { revisionHash: differentHash } } = await different.json() as { revision: { revisionHash: string } };
    expect((await review(second.app, key, target.jobId, differentHash)).status).toBe(503);
    expect((await revise(second.app, revision(), differentHash)).status).toBe(201);
    expect((await review(second.app, key, target.jobId, target.revisionHash)).status).toBe(202);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.reviewId).not.toBe(objection.reviewId);
    second.close();

    const third = setup({ dbPath, botReview });
    expect((await revise(third.app)).status).toBe(201);
    expect((await review(third.app, key, target.jobId, target.revisionHash)).status).toBe(503);
    expect(sends).toHaveLength(2);
  });
  it("remains disabled without configuration", async () => {
    const { app } = setup({ botReview: undefined }); const key = await issue(app), task = await job(app, key);
    expect((await review(app, key, task.jobId, task.revisionHash)).status).toBe(503);
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("derives the snapshot from owned state, evaluates examples and dispatches once across new replay keys", async () => {
    const { app, sends, evalFn } = setup(); const key = await issue(app), task = await job(app, key);
    const first = await review(app, key, task.jobId, task.revisionHash), body = await first.json() as any;
    expect(first.status, JSON.stringify(body)).toBe(202); expect(body.status).toBe("queued");
    expect(await status(app, key, task.jobId, body.reviewId)).toBe("waiting");
    expect(sends).toHaveLength(1); expect(evalFn).toHaveBeenCalledTimes(2);
    expect(sends[0]!.input).toMatchObject({ request: "Require approval.", plan, revisionHash: task.revisionHash,
      referenceDigest: EMPTY_REF_HASH, exampleChecks: [{ name: "accepted", verdict: 1 }, { name: "rejected", verdict: 0 }] });
    expect(sends[0]!.callbackUrl).toBe("https://api.example.test" + MCP);
    expect(JSON.stringify(body)).not.toMatch(/callbackTicket|serviceToken|inputJson/);
    const again = await review(app, key, task.jobId, task.revisionHash);
    expect((await again.json() as any).reviewId).toBe(body.reviewId); expect(sends).toHaveLength(1);
    expect((await approve(app, key, task.jobId, task.revisionHash, body.reviewId)).status).toBe(409);
  });

  it("requires a passed receipt and explicit buyer approval, then retains receipt hashes", async () => {
    const { app, sends } = setup(); const key = await issue(app), task = await job(app, key);
    expect((await approve(app, key, task.jobId, task.revisionHash)).status).toBe(409);
    await review(app, key, task.jobId, task.revisionHash);
    const receipt = await callback(app, sends[0]!); expect(receipt.result.isError).not.toBe(true);
    expect((await app.request(`/v1/jobs/${task.jobId}`)).status).toBe(200);
    const pending = await app.request(`/v1/jobs/${task.jobId}`); expect((await pending.json() as any).state).toBe("drafted");
    expect((await approve(app, key, task.jobId, task.revisionHash)).status).toBe(409);
    const approved = await approve(app, key, task.jobId, task.revisionHash, sends[0]!.reviewId);
    const body = await approved.json() as any;
    expect(approved.status, JSON.stringify(body)).toBe(200);
    expect(body.approval).toMatchObject({ botReviewId: sends[0]!.reviewId, botInputHash: sends[0]!.inputHash });
    expect(body.approval.botResultHash).toMatch(/^0x[0-9a-f]{64}$/);
    const replay = await approve(app, key, task.jobId, task.revisionHash, sends[0]!.reviewId);
    expect((await replay.json() as any).approval).toEqual(body.approval);
  });

  it("isolates owners and keeps the callback credential separate from buyer credentials", async () => {
    const { app, sends } = setup(); const key = await issue(app), other = await issue(app, OTHER_KEY), task = await job(app, key);
    await review(app, key, task.jobId, task.revisionHash); const id = sends[0]!.reviewId;
    const path = `/v1/jobs/${task.jobId}/bot-reviews/${id}`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { authorization: `Bearer ${other}` } })).status).toBe(404);
    expect((await review(app, other, task.jobId, task.revisionHash)).status).toBe(404);
    expect((await app.request(path, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, key)).status).toBe(401);
    expect((await post(app, "/v1/jobs", { revision: revision(), source: "import" }, SERVICE)).status).toBe(401);
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, SERVICE, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("exposes one result tool and implements bounded MCP initialization and notifications", async () => {
    const { app } = setup();
    const initialized = await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "controlled-test", version: "1" } } });
    expect((await initialized.json() as any).result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
    const notice = await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notice.status).toBe(202); expect(await notice.text()).toBe("");
    const tools = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await tools.json() as any).result.tools.map((tool: any) => tool.name)).toEqual(["submit_constraint_review"]);
    expect((await app.request(MCP, { headers: { authorization: `Bearer ${SERVICE}` } })).status).toBe(405);
    const unknown = await rpc(app, { jsonrpc: "2.0", id: 2, method: "approve" });
    expect((await unknown.json() as any).error.code).toBe(-32601);
    const oversized = await rpc(app, { text: "x".repeat(17000) }); expect(oversized.status).toBe(413);
  });

  it("keeps objections terminal and rejects conflicting callback replay", async () => {
    const { app, sends } = setup(); const key = await issue(app), task = await job(app, key);
    await review(app, key, task.jobId, task.revisionHash); const delivery = sends[0]!;
    const objection = { ...result(delivery), decision: "clarify", questions: ["What counts as approval?"] };
    const receipt = await callback(app, delivery, objection);
    expect(receipt.result.isError).not.toBe(true);
    expect(await callback(app, delivery, objection)).toEqual(receipt);
    expect((await callback(app, delivery)).result.isError).toBe(true);
    expect((await approve(app, key, task.jobId, task.revisionHash, delivery.reviewId)).status).toBe(409);
  });

  it("rejects changed policy, untrusted verdicts and mismatched examples before Bot dispatch", async () => {
    const { app, sends } = setup(); const key = await issue(app), task = await job(app, key);
    const path = `/v1/jobs/${task.jobId}/bot-reviews`;
    expect((await post(app, path, { ...reviewBody(task.revisionHash), plan: {} }, key)).status).toBe(400);
    expect((await post(app, path, { ...reviewBody(task.revisionHash), examples: [{ ...examples[0], predictedVerdict: 0 }, examples[1]] }, key)).status).toBe(400);
    expect((await post(app, path, { ...reviewBody(task.revisionHash), examples: [examples[0], { ...examples[1], files: examples[0]!.files }] }, key)).status).toBe(400);
    expect(sends).toHaveLength(0);
    await review(app, key, task.jobId, task.revisionHash);
    expect((await post(app, path, { ...reviewBody(task.revisionHash), request: "Replaced policy." }, key)).status).toBe(409);
    expect(sends).toHaveLength(1);
  });

  it("marks failed delivery uncertain and never sends it again", async () => {
    const dispatch = vi.fn(async () => { throw new Error("response lost"); });
    const { app } = setup({ botReview: { serviceToken: SERVICE, dispatch } }); const key = await issue(app), task = await job(app, key);
    const response = await review(app, key, task.jobId, task.revisionHash);
    const body = await response.json() as any;
    expect(body.status).toBe("queued"); expect(await status(app, key, task.jobId, body.reviewId)).toBe("uncertain");
    await review(app, key, task.jobId, task.revisionHash); expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reports expiry through owner polling with dispatch enabled=%s", async enabled => {
    let now = Date.now();
    const sends: Delivery[] = [], dispatch = vi.fn(async (delivery: Delivery) => { sends.push(delivery); });
    const created = setup({ now: () => now, botReview: { serviceToken: SERVICE, ...(enabled ? { dispatch } : {}) } });
    const key = await issue(created.app), task = await job(created.app, key);
    const accepted = await review(created.app, key, task.jobId, task.revisionHash), body = await accepted.json() as any;
    now = body.expiresAt - 1;
    expect(await status(created.app, key, task.jobId, body.reviewId)).toBe(enabled ? "waiting" : "queued");
    now = body.expiresAt;
    expect(await status(created.app, key, task.jobId, body.reviewId)).toBe("expired");
    await created.pumpTasks(); await review(created.app, key, task.jobId, task.revisionHash);
    expect(dispatch).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect((await approve(created.app, key, task.jobId, task.revisionHash, body.reviewId)).status).toBe(409);
    if (enabled) expect((await callback(created.app, sends[0]!)).result.isError).toBe(true);
  });

  it("preserves a completed callback that races the webhook response", async () => {
    let app: ReturnType<typeof createApp>["app"];
    const created = setup({ botReview: { serviceToken: SERVICE, dispatch: async delivery => {
      const response = await callback(app, delivery); expect(response.result.isError).not.toBe(true);
    } } }); app = created.app;
    const key = await issue(app), task = await job(app, key), response = await review(app, key, task.jobId, task.revisionHash);
    const body = await response.json() as any;
    expect(body.status).toBe("queued"); expect(await status(app, key, task.jobId, body.reviewId)).toBe("completed");
  });

  it("keeps a previous approval without a Bot receipt from unlocking compilation after activation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-enable-")); dirs.push(dir);
    const dbPath = join(dir, "state.db"), first = setup({ dbPath, botReview: undefined });
    const key = await issue(first.app), task = await job(first.app, key);
    expect((await approve(first.app, key, task.jobId, task.revisionHash)).status).toBe(200);
    first.close();
    const second = setup({ dbPath });
    const compilation = await post(second.app, `/v1/jobs/${task.jobId}/compile`, { revisionHash: task.revisionHash }, key);
    expect(compilation.status, await compilation.text()).toBe(409);
  });

  it("does not replay cached approvals or compilation around the newly enabled Bot gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-cache-")); dirs.push(dir);
    const dbPath = join(dir, "state.db"), first = setup({ dbPath, botReview: undefined });
    const key = await issue(first.app), task = await job(first.app, key), approvalKey = freshKey(), compileKey = freshKey();
    const approvalPath = `/v1/jobs/${task.jobId}/approve`, compilePath = `/v1/jobs/${task.jobId}/compile`;
    const approvalBody = { revisionHash: task.revisionHash, referenceDigest: EMPTY_REF_HASH };
    const approvalHeaders = { "if-match": task.revisionHash, "idempotency-key": approvalKey };
    expect((await post(first.app, approvalPath, approvalBody, key, approvalHeaders)).status).toBe(200);
    expect((await post(first.app, compilePath, { revisionHash: task.revisionHash }, key, { "idempotency-key": compileKey })).status).toBe(200);
    first.close(); const second = setup({ dbPath });
    expect((await post(second.app, approvalPath, approvalBody, key, approvalHeaders)).status).toBe(409);
    expect((await post(second.app, compilePath, { revisionHash: task.revisionHash }, key, { "idempotency-key": compileKey })).status).toBe(409);
  });

  it("rechecks the revision after asynchronous example validation", async () => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const engine: Engine = { ...simulatedEngine(), eval: async ({ deliverables }) => {
      entered(); await blocked;
      return { ok: true, verdict: Buffer.from(deliverables[0]!.content).toString() === "yes" ? 1 : 0 };
    } };
    const { app, sends } = setup({ engine }); const key = await issue(app), task = await job(app, key);
    const pending = review(app, key, task.jobId, task.revisionHash); await waiting;
    const changed = await post(app, `/v1/jobs/${task.jobId}/revisions`, { revision: { ...revision(), maxBudget: "6000000" }, source: "import" }, key,
      { "if-match": task.revisionHash });
    expect(changed.status, await changed.text()).toBe(201); release();
    expect((await pending).status).toBe(409); expect(sends).toHaveLength(0);
  });

  it("uses the stored Grok brief and buyer answers instead of a replacement brief", async () => {
    const { app, sends } = setup({ draftModel: { draft: async () => ({ result: { kind: "draft", plan, examples,
      sourceQuotes: [{ path: "/request", quote: "Require approval." }] }, model: "controlled-test", traceId: "no-provider-call" }) } });
    const key = await issue(app);
    const draft = await post(app, "/v1/drafts", { request: "Require approval.", outputs: revision().outputs, expirySeconds: 600,
      maxBudget: "5000000", clarifications: [{ question: "Who approves?", answer: "The buyer." }] }, key);
    const drafted = await draft.json() as any; expect(draft.status, JSON.stringify(drafted)).toBe(200);
    const created = await post(app, "/v1/jobs", { revision: drafted.revision, draftId: drafted.draftId, source: "grok" }, key);
    const task = await created.json() as any; expect(created.status, JSON.stringify(task)).toBe(201);
    const path = `/v1/jobs/${task.jobId}/bot-reviews`;
    expect((await post(app, path, reviewBody(task.revision.revisionHash), key)).status).toBe(400);
    const response = await post(app, path, { revisionHash: task.revision.revisionHash, examples }, key);
    expect(response.status, await response.text()).toBe(202);
    expect(sends[0]!.input).toMatchObject({ request: "Require approval.\n\nBuyer clarifications:\nWho approves?\nThe buyer." });
  });

  it("rejects malformed protocol messages and wrong callback tickets without changing review state", async () => {
    const { app, sends } = setup(); const key = await issue(app), task = await job(app, key);
    await review(app, key, task.jobId, task.revisionHash);
    const delivery = sends[0]!;
    expect((await callback(app, { ...delivery, callbackTicket: "f".repeat(64) })).result.isError).toBe(true);
    expect((await callback(app, delivery, { accepted: true })).result.isError).toBe(true);
    for (const body of [[], null, { jsonrpc: "2.0", id: null, method: "tools/list" }]) expect((await rpc(app, body)).status).toBe(400);
    const badVersion = await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, SERVICE, { "mcp-protocol-version": "bad" });
    expect(badVersion.status).toBe(400);
    const response = await app.request(`/v1/jobs/${task.jobId}/bot-reviews/${delivery.reviewId}`, { headers: { authorization: `Bearer ${key}` } });
    expect((await response.json() as any).status).toBe("waiting");
  });

  it("persists idempotent acceptance before dispatch so a changed revision cannot reuse its key", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const dispatch = vi.fn(async () => { entered(); if (dispatch.mock.calls.length === 1) await blocked; });
    const { app } = setup({ botReview: { serviceToken: SERVICE, dispatch } });
    const key = await issue(app), task = await job(app, key), replayKey = freshKey(), path = `/v1/jobs/${task.jobId}/bot-reviews`;
    const first = post(app, path, reviewBody(task.revisionHash), key, { "idempotency-key": replayKey }); await waiting;
    try {
      const revised = await post(app, `/v1/jobs/${task.jobId}/revisions`, { revision: { ...revision(), maxBudget: "6000000" }, source: "import" }, key,
        { "if-match": task.revisionHash });
      const changed = await revised.json() as any; expect(revised.status).toBe(201);
      const second = await post(app, path, reviewBody(changed.revision.revisionHash), key, { "idempotency-key": replayKey });
      expect(second.status).toBe(422); expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
  });

  it("recovers accepted queued work on restart and sends it only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-restart-")); dirs.push(dir);
    const dbPath = join(dir, "state.db"), first = setup({ dbPath, botReview: { serviceToken: SERVICE } });
    const key = await issue(first.app), task = await job(first.app, key), accepted = await review(first.app, key, task.jobId, task.revisionHash);
    const body = await accepted.json() as any; expect(body.status).toBe("queued"); first.close();
    const second = setup({ dbPath }); second.reconcileTasks(); await second.pumpTasks(); await second.pumpTasks();
    expect(second.sends).toHaveLength(1); expect(await status(second.app, key, task.jobId, body.reviewId)).toBe("waiting");
  });

  it("does not recover queued reviews through the emergency spending stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-stop-")); dirs.push(dir);
    const dbPath = join(dir, "state.db"), first = setup({ dbPath, botReview: { serviceToken: SERVICE } });
    const key = await issue(first.app), task = await job(first.app, key), accepted = await review(first.app, key, task.jobId, task.revisionHash);
    const body = await accepted.json() as any; first.close();
    const second = setup({ dbPath, expensiveDisabled: true }); second.reconcileTasks(); await second.pumpTasks();
    expect(second.sends).toHaveLength(0); expect(await status(second.app, key, task.jobId, body.reviewId)).toBe("queued");
  });

  it("halts new Bot dispatch during drain and preserves an uncertain active delivery", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const dispatch = vi.fn(async () => { entered(); await blocked; });
    const created = setup({ botReview: { serviceToken: SERVICE, dispatch } }), key = await issue(created.app), task = await job(created.app, key);
    const pending = review(created.app, key, task.jobId, task.revisionHash); await waiting;
    await created.drainTasks(0); release();
    const body = await (await pending).json() as any;
    expect(await status(created.app, key, task.jobId, body.reviewId)).toBe("uncertain");
    expect((await review(created.app, key, task.jobId, task.revisionHash)).status).toBe(503);
    await created.pumpTasks(); expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps Bot queue progress independent from a long compiler task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-progress-")); dirs.push(dir);
    const dbPath = join(dir, "state.db"), first = setup({ dbPath });
    const key = await issue(first.app), compilerJob = await job(first.app, key);
    await review(first.app, key, compilerJob.jobId, compilerJob.revisionHash); await callback(first.app, first.sends[0]!);
    expect((await approve(first.app, key, compilerJob.jobId, compilerJob.revisionHash, first.sends[0]!.reviewId)).status).toBe(200);
    expect((await post(first.app, "/v1/tasks", { operation: "compile", ...compilerJob }, key)).status).toBe(202); first.close();
    let releaseCompiler!: () => void, releaseBot!: () => void, enteredBot!: () => void;
    const compilerBlocked = new Promise<void>(resolve => { releaseCompiler = resolve; }), botBlocked = new Promise<void>(resolve => { releaseBot = resolve; });
    const botEntered = new Promise<void>(resolve => { enteredBot = resolve; });
    const compile = vi.fn<Engine["compile"]>(async input => { await compilerBlocked; return simulatedEngine().compile(input); });
    const dispatch = vi.fn(async () => { if (dispatch.mock.calls.length === 1) { enteredBot(); await botBlocked; } });
    const created = setup({ dbPath, engine: { ...simulatedEngine(), compile, eval: async ({ deliverables }) => ({ ok: true,
      verdict: Buffer.from(deliverables[0]!.content).toString() === "yes" ? 1 : 0 }) }, botReview: { serviceToken: SERVICE, dispatch } });
    const a = await job(created.app, key), pendingReview = review(created.app, key, a.jobId, a.revisionHash); await botEntered;
    const b = await job(created.app, key); await review(created.app, key, b.jobId, b.revisionHash);
    vi.useFakeTimers(); const pumps: Promise<void>[] = [], errors: unknown[] = [];
    const timer = startPumpTimer(() => { const pending = created.pumpTasks(); pumps.push(pending); return pending; }, error => errors.push(error));
    try {
      await vi.advanceTimersByTimeAsync(1000); expect(compile).toHaveBeenCalledTimes(1);
      releaseBot(); await pendingReview;
      await vi.advanceTimersByTimeAsync(1000); expect(dispatch).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(timer); releaseBot(); releaseCompiler(); await pendingReview; await Promise.all(pumps); vi.useRealTimers();
    }
    expect(errors).toEqual([]);
  });
});

it.each([false, true])("checks coverage before public review and can reuse a qualified draft (%s)", async qualified => {
  const dispatch = vi.fn(async (_delivery: Delivery) => {});
  const request = "Require approval.";
  const draft = vi.fn(async () => ({
    model: "controlled", traceId: "public-coverage", result: {
      kind: "draft" as const, plan, examples, sourceQuotes: [{ path: "/request", quote: request }],
      coverage: { assumptions: [], unresolved: qualified ? [] : ["A requirement is unresolved."],
        requirements: [{ id: "approval", text: request, ruleIndices: [0], quoteIndices: [0] }] },
    },
  }));
  const { app, pumpTasks } = setup({
    deployment: { mode: "public", serviceOrigin: "https://api.example.test" },
    engine: { ...simulatedEngine(), mode: "real", eval: async ({ deliverables }) => ({
      ok: true, verdict: Buffer.from(deliverables[0]!.content).toString() === "yes" ? 1 : 0,
    }) },
    budget: { requestCeilingMicroUsd: 500000, dailyCeilingMicroUsd: 5000000,
      inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000 },
    botReview: { serviceToken: SERVICE, pilotOwner: privateKeyToAccount(PROVIDER_KEY).address.toLowerCase(),
      maxDispatches: 2, dispatch },
    draftModel: { outputTokenBound: { parameter: "max_tokens", maxTokens: 8192 }, draft },
  });
  const key = await issue(app);
  const queued = await post(app, "/v1/tasks", { operation: "draft", input: {
    request, outputs: revision().outputs, expirySeconds: 600, maxBudget: "5000000",
  } }, key);
  expect(queued.status, await queued.clone().text()).toBe(202);
  const { id } = await queued.json() as { id: string };
  await pumpTasks();
  const done = await app.request(`/v1/tasks/${id}`, { headers: { authorization: `Bearer ${key}` } });
  const { result: drafted } = await done.json() as any;
  expect(drafted.kind).toBe("draft");
  const created = await post(app, "/v1/jobs", { source: "grok", draftId: drafted.draftId, revision: drafted.revision }, key);
  expect(created.status, await created.clone().text()).toBe(201);
  const { jobId } = await created.json() as { jobId: string };
  const reviewed = await post(app, `/v1/jobs/${jobId}/bot-reviews`, { revisionHash: drafted.revisionHash, examples }, key);
  expect(reviewed.status, await reviewed.clone().text()).toBe(qualified ? 202 : 409);
  expect(dispatch).toHaveBeenCalledTimes(qualified ? 1 : 0);
  if (!qualified) {
    expect(await reviewed.json()).toMatchObject({
      error: { code: "approval_required", details: { blockers: ["requirement_coverage"] } },
    });
    return;
  }

  const rejected = dispatch.mock.calls[0]![0];
  const objection = await callback(app, rejected, {
    ...result(rejected), decision: "needs_changes",
    findings: [{ kind: "omission", sourceQuote: request, ruleIndices: [0], message: "The rule needs review." }],
  });
  expect(objection.result.structuredContent).toMatchObject({ decision: "needs_changes" });
  const revised = await post(app, `/v1/jobs/${jobId}/revisions`, {
    source: "grok", draftId: drafted.draftId, revision: drafted.revision,
  }, key, { "if-match": drafted.revisionHash });
  expect(revised.status, await revised.clone().text()).toBe(201);
  expect(await revised.json()).toMatchObject({ revision: { n: 2, revisionHash: drafted.revisionHash } });

  const second = await post(app, `/v1/jobs/${jobId}/bot-reviews`, { revisionHash: drafted.revisionHash, examples }, key);
  expect(second.status, await second.clone().text()).toBe(202);
  expect(dispatch).toHaveBeenCalledTimes(2);
  const accepted = dispatch.mock.calls[1]![0];
  expect(accepted.reviewId).not.toBe(rejected.reviewId);
  expect(accepted.inputHash).toBe(rejected.inputHash);
  await callback(app, accepted);
  const approval = (botReviewId: string) => post(app, `/v1/jobs/${jobId}/approve`, {
    revisionHash: drafted.revisionHash, referenceDigest: EMPTY_REF_HASH, botReviewId,
    coverageDigest: drafted.coverage.coverageDigest, exampleCheckId: drafted.exampleCheckId,
  }, key, { "if-match": drafted.revisionHash });
  expect((await approval(rejected.reviewId)).status).toBe(409);
  const approved = await approval(accepted.reviewId);
  expect(approved.status, await approved.clone().text()).toBe(200);
  const prior = await app.request(`/v1/jobs/${jobId}/bot-reviews/${rejected.reviewId}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(await prior.json()).toMatchObject({ decision: "needs_changes" });
  expect(draft).toHaveBeenCalledTimes(1);
});
