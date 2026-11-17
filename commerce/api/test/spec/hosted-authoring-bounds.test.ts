// Bounded authoring: no silent truncation, one repair, and dispatch-aware billing.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, grokDraftModel, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, expectError, freshKey } from "./helpers.ts";
import {
  DRAFT_BODY,
  countingEngine,
  draftReply,
  fakeModel,
  file,
  json,
  makeApp56,
  refsPayload,
  req,
} from "./helpers-t56.ts";

const ORIGIN = "https://api.example.test";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const accountA = privateKeyToAccount(WALLET_A);
const budget = {
  requestCeilingMicroUsd: 5_000_000,
  dailyCeilingMicroUsd: 20_000_000,
  inputMicroUsdPerMillion: 1_250_000,
  outputMicroUsdPerMillion: 2_500_000,
};
const usage = {
  promptTokens: 1_000,
  completionTokens: 1_000,
  cachedTokens: null,
  reasoningTokens: null,
  costInUsdTicks: 999,
};
const ONE_CALL_MICRO_USD = 3_750;

type Created = ReturnType<typeof createApp>;
const opened: Created[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": freshKey() };
}

async function post(app: Created["app"], path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function issue(app: Created["app"]) {
  const challenge = await post(app, "/v1/auth/challenge", { wallet: accountA.address.toLowerCase() }, { "content-type": "application/json" });
  const issued = await challenge.json() as { challengeId: string; message: string };
  expect(challenge.status, JSON.stringify(issued)).toBe(200);
  const signature = await accountA.signMessage({ message: issued.message });
  const keys = await post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature }, { "content-type": "application/json" });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
}

function appWith(extra: Partial<CreateAppOptions>, dbPath = ":memory:") {
  const created = createApp({
    dbPath,
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    deployment: { mode: "local", serviceOrigin: ORIGIN },
    budget,
    ...extra,
  });
  opened.push(created);
  return created;
}

function reservation(dbPath: string) {
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare("SELECT state, ceiling_micro_usd, settled_micro_usd, dispatched_at, breach, usage_json FROM spend_reservations").get() as {
    state: string;
    ceiling_micro_usd: number;
    settled_micro_usd: number | null;
    dispatched_at: string | null;
    breach: number | null;
    usage_json: string | null;
  };
  raw.close();
  return row;
}

describe("reference text", () => {
  it("sends full UTF-8 references and explicit base64 for binary bytes", async () => {
    const model = fakeModel(draftReply());
    const s = makeApp56({ draftModel: model });
    const long = "x".repeat(9000);
    const ok = await req(s, "POST", "/v1/drafts", { ...DRAFT_BODY, references: refsPayload([file("notes.txt", long)]) });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(model.calls).toHaveLength(1);
    const sent = model.calls[0] as { referenceFiles?: { name: string; text: string }[] };
    expect(sent.referenceFiles).toEqual([{ name: "notes.txt", text: long }]);
    const before = model.calls.length;
    const bad = await req(s, "POST", "/v1/drafts", { ...DRAFT_BODY, references: refsPayload([file("blob.bin", new Uint8Array([0xff, 0xfe]))]) });
    const text = await bad.text();
    expect(bad.status, text).toBe(200);
    expect(text).not.toContain("binary file");
    expect(text).not.toContain("<truncated");
    expect(model.calls).toHaveLength(before + 1);
    expect((model.calls.at(-1) as unknown as { referenceFiles: unknown[] }).referenceFiles[0]).toMatchObject({ name: "blob.bin", encoding: "base64", contentBase64: "//4=", byteLength: 2 });
    s.close();
  });

  it("reports an unmatched quote beside the draft and does not call the model again", async () => {
    const model = fakeModel(draftReply());
    const s = makeApp56({ draftModel: model });
    const res = await req(s, "POST", "/v1/drafts", DRAFT_BODY);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.kind).toBe("draft");
    expect(body.sourceQuotes).toEqual([{ path: "/request", quote: "count words" }]);
    expect(body.quoteVerification).toEqual([{ path: "/request", quote: "count words", found: false }]);
    expect(body.coverage.omissions).toContain("A source quote was not found in the supplied text.");
    expect(model.calls).toHaveLength(1);
    s.close();
  });
});

describe("one repair", () => {
  it("keeps invalid draft usage settled without a second call when repairs are disabled", async () => {
    const model = fakeModel(() => ({ ...draftReply({ version: 1 }), usage: { ...usage, cachedTokens: 0, reasoningTokens: 0, costInUsdTicks: null } }));
    const engine = countingEngine({
      validate: async () => ({ ok: false, kind: "invalid", errors: [{ path: "/version", message: "bad version" }] }),
    });
    const dbPath = join(mkdtempSync(join(tmpdir(), "ubc26-single-draft-")), "api.db");
    const created = appWith({ draftModel: model, engine: engine as CreateAppOptions["engine"], authoringRepairs: false }, dbPath);
    const response = await post(created.app, "/v1/drafts", DRAFT_BODY, auth(BUYER_TOKEN));
    const body = await json(response);
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.kind).toBe("unsupported");
    expect(body.billing).toMatchObject({ state: "settled", microUsd: ONE_CALL_MICRO_USD });
    expect(model.calls).toHaveLength(1);

    const key = await issue(created.app);
    const headers = auth(key);
    const input = { operation: "draft", input: DRAFT_BODY };
    const queued = await post(created.app, "/v1/tasks", input, headers);
    expect(queued.status).toBe(202);
    const task = await queued.json() as { id: string };
    await created.pumpTasks();
    const replay = await post(created.app, "/v1/tasks", input, headers);
    expect(replay.status).toBe(202);
    expect((await replay.json() as { id: string }).id).toBe(task.id);
    await created.pumpTasks();
    expect(model.calls).toHaveLength(2);
    expect(reservation(dbPath)).toMatchObject({
      state: "settled", settled_micro_usd: ONE_CALL_MICRO_USD, breach: 0,
    });
  });

  it("repairs one invalid plan when usage is known and does not repair a capability refusal", async () => {
    let calls = 0;
    const model = fakeModel(() => {
      calls += 1;
      return { ...draftReply(calls === 1 ? { version: 1 } : { version: 2 }), usage };
    });
    const engine = countingEngine({
      validate: async (plan) => (plan as { version?: number }).version === 2
        ? { ok: true }
        : { ok: false, kind: "invalid", errors: [{ path: "/version", message: "bad version" }] },
    });
    const s = makeApp56({ draftModel: model, engine });
    const res = await req(s, "POST", "/v1/drafts", DRAFT_BODY);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.kind).toBe("draft");
    expect(calls).toBe(2);
    const repairCall = model.calls[1] as { repair?: { errors: { path: string; message: string }[] } };
    expect(repairCall.repair?.errors).toEqual([{ path: "/version", message: "bad version" }]);
    expect(body.qualification.repairCount).toBe(1);
    expect(engine.validateCalls).toHaveLength(2);
    s.close();

    const refused = fakeModel(() => ({ ...draftReply(), usage }));
    const refusal = countingEngine({
      validate: async () => ({ ok: false, kind: "unsupported", capabilityError: { capability: "gpu" } }),
    });
    const second = makeApp56({ draftModel: refused, engine: refusal });
    const denied = await json(await req(second, "POST", "/v1/drafts", DRAFT_BODY));
    expect(denied.kind).toBe("unsupported");
    expect(refused.calls).toHaveLength(1);
    expect(refusal.validateCalls).toHaveLength(1);
    second.close();
  });

  it("does not repair when the provider omits usage", async () => {
    const model = fakeModel(draftReply());
    const engine = countingEngine({
      validate: async () => ({ ok: false, kind: "invalid", errors: [{ path: "/version", message: "bad version" }] }),
    });
    const s = makeApp56({ draftModel: model, engine });
    const body = await json(await req(s, "POST", "/v1/drafts", DRAFT_BODY));
    expect(body.kind).toBe("unsupported");
    expect(model.calls).toHaveLength(1);
    expect(engine.validateCalls).toHaveLength(1);
    s.close();
  });
});

describe("dispatch billing", () => {
  it("releases a reservation only when the model was not called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-release-"));
    const dbPath = join(dir, "api.db");
    let calls = 0;
    const created = appWith({
      dbPath,
      draftModel: { async draft() { calls += 1; return { result: { kind: "clarification", questions: ["Which file?"] }, model: "spec", traceId: "t" }; } },
    }, dbPath);
    const key = await issue(created.app);
    const accepted = await post(created.app, "/v1/tasks", { operation: "draft", input: { request: "" } }, auth(key));
    expect(accepted.status).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(0);
    expect(reservation(dbPath)).toMatchObject({ state: "released", dispatched_at: null, settled_micro_usd: null });
  });

  it("keeps the ceiling after a paid call fails and settles a known repair total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-paid-"));
    const dbPath = join(dir, "api.db");
    let calls = 0;
    const created = appWith({
      dbPath,
      draftModel: {
        async draft() {
          calls += 1;
          throw new Error("secret sk-live /Users/private/key");
        },
      },
    }, dbPath);
    const key = await issue(created.app);
    const accepted = await post(created.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in paid.txt" } }, auth(key));
    const view = await accepted.json() as { id: string };
    expect(accepted.status).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(1);
    const failed = await (await created.app.request(`/v1/tasks/${view.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string; error: { message: string } };
    expect(failed.state).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("sk-live");
    const held = reservation(dbPath);
    expect(held.state).toBe("uncertain");
    expect(held.settled_micro_usd).toBeNull();
    expect(held.dispatched_at).toBeTruthy();
    expect(held.ceiling_micro_usd).toBe(budget.requestCeilingMicroUsd);

    const repairDir = mkdtempSync(join(tmpdir(), "ubc26-repair-bill-"));
    const repairPath = join(repairDir, "api.db");
    let repairCalls = 0;
    const engine = countingEngine({
      validate: async (plan) => (plan as { version?: number }).version === 2
        ? { ok: true }
        : { ok: false, kind: "invalid", errors: [{ path: "/version", message: "bad version" }] },
    });
    const repairApp = appWith({
      dbPath: repairPath,
      engine: engine as CreateAppOptions["engine"],
      draftModel: {
        async draft() {
          repairCalls += 1;
          return { ...draftReply(repairCalls === 1 ? { version: 1 } : { version: 2 }), usage: { ...usage, reasoningTokens: 0, costInUsdTicks: null } };
        },
      },
    }, repairPath);
    const repairKey = await issue(repairApp.app);
    const queued = await post(repairApp.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in repair.txt" } }, auth(repairKey));
    expect(queued.status).toBe(202);
    await repairApp.pumpTasks();
    expect(repairCalls).toBe(2);
    const settled = reservation(repairPath);
    expect(settled.state).toBe("settled");
    expect(settled.settled_micro_usd).toBe(ONE_CALL_MICRO_USD * 2);
    expect(settled.settled_micro_usd).not.toBe(999);
    expect(settled.breach).toBe(0);
    expect(settled.usage_json).toContain("1000");
  });

  it("retains the full known tariff when it exceeds the ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-over-"));
    const dbPath = join(dir, "api.db");
    const created = appWith({
      dbPath,
      budget: { ...budget, requestCeilingMicroUsd: 50_000, dailyCeilingMicroUsd: 100_000 },
      draftModel: {
        async draft() {
          return {
            result: { kind: "clarification" as const, questions: ["Which file?"] },
            model: "spec",
            traceId: "t",
            usage: { promptTokens: 10_000_000, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, costInUsdTicks: null },
          };
        },
      },
    }, dbPath);
    const key = await issue(created.app);
    expect((await post(created.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in over.txt" } }, auth(key))).status).toBe(202);
    await created.pumpTasks();
    const row = reservation(dbPath);
    expect(row.state).toBe("settled");
    expect(row.settled_micro_usd).toBe(12_500_000);
    expect(row.breach).toBe(1);
    expect(row.ceiling_micro_usd).toBe(50_000);
    const again = await post(created.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in over-again.txt" } }, auth(key));
    expect(again.status).toBe(429);
  });

  it("stops queued model work after an overrun until an operator resolves the halt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-halt-"));
    const dbPath = join(dir, "api.db");
    const ticks = 125_000_000_000;
    let calls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const overrun = {
      promptTokens: 10_000_000,
      completionTokens: 0,
      cachedTokens: 0,
      reasoningTokens: null,
      costInUsdTicks: ticks,
    };
    const model = {
      async draft() {
        calls += 1;
        if (calls === 1) {
          markEntered();
          await gate;
          return { result: { kind: "clarification" as const, questions: ["Which file?"] }, model: "spec", traceId: "over", usage: overrun };
        }
        return {
          result: { kind: "clarification" as const, questions: ["Which file?"] },
          model: "spec",
          traceId: "next",
          usage: { promptTokens: 1, completionTokens: 0, cachedTokens: null, reasoningTokens: null, costInUsdTicks: null },
        };
      },
    };
    const haltBudget = { ...budget, requestCeilingMicroUsd: 50_000, dailyCeilingMicroUsd: 100_000_000 };
    const operatorToken = "operator-test-token-value";
    const created = appWith({ dbPath, budget: haltBudget, draftModel: model, operatorToken }, dbPath);
    const key = await issue(created.app);
    const first = await post(created.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in halt-a.txt" } }, auth(key));
    const firstView = await first.json() as { id: string };
    expect(first.status, JSON.stringify(firstView)).toBe(202);
    const pumping = created.pumpTasks();
    await entered;
    const second = await post(created.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in halt-b.txt" } }, auth(key));
    const secondView = await second.json() as { id: string; state: string };
    expect(second.status, JSON.stringify(secondView)).toBe(202);
    expect(secondView.state).toBe("queued");
    releaseGate();
    await pumping;
    expect(calls).toBe(1);
    const raw = new DatabaseSync(dbPath);
    const settled = raw.prepare("SELECT state, ceiling_micro_usd, settled_micro_usd, breach, usage_json FROM spend_reservations WHERE task_id = ?").get(firstView.id) as {
      state: string;
      ceiling_micro_usd: number;
      settled_micro_usd: number;
      breach: number;
      usage_json: string;
    };
    const queuedReservation = raw.prepare("SELECT state, settled_micro_usd FROM spend_reservations WHERE task_id = ?").get(secondView.id) as {
      state: string;
      settled_micro_usd: number | null;
    };
    const halt = raw.prepare("SELECT id, settled_micro_usd, ceiling_micro_usd, resolved_at FROM spend_halts").get() as {
      id: string;
      settled_micro_usd: number;
      ceiling_micro_usd: number;
      resolved_at: string | null;
    };
    raw.close();
    expect(settled).toMatchObject({ state: "settled", ceiling_micro_usd: 50_000, settled_micro_usd: 12_500_000, breach: 1 });
    expect(settled.usage_json).toContain(String(ticks));
    expect(queuedReservation).toEqual({ state: "reserved", settled_micro_usd: null });
    expect(halt.settled_micro_usd).toBe(12_500_000);
    expect(halt.ceiling_micro_usd).toBe(50_000);
    expect(halt.resolved_at).toBeNull();
    await created.pumpTasks();
    expect(calls).toBe(1);
    const blocked = await post(created.app, "/v1/tasks", { operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in halt-c.txt" } }, auth(key));
    await expectError(blocked, 503, "service_disabled");
    const sync = await post(created.app, "/v1/drafts", { ...DRAFT_BODY, request: "Count the words in halt-sync.txt" }, auth(key));
    await expectError(sync, 503, "service_disabled");
    expect(calls).toBe(1);
    const missing = await created.app.request("/v1/operator/spend-halts/missing/resolve", {
      method: "POST",
      headers: { authorization: "Bearer wrong-operator-token", "content-type": "application/json" },
      body: JSON.stringify({ note: "not authorized" }),
    });
    expect(missing.status).toBe(401);
    created.close();
    const restarted = appWith({ dbPath, budget: haltBudget, draftModel: model, operatorToken }, dbPath);
    restarted.reconcileTasks();
    await restarted.pumpTasks();
    expect(calls).toBe(1);
    const stillQueued = await (await restarted.app.request(`/v1/tasks/${secondView.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string };
    expect(stillQueued.state).toBe("queued");
    const resolved = await restarted.app.request(`/v1/operator/spend-halts/${halt.id}/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Reviewed the provider invoice" }),
    });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const again = await restarted.app.request(`/v1/operator/spend-halts/${halt.id}/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Reviewed the provider invoice again" }),
    });
    expect(again.status).toBe(409);
    await restarted.pumpTasks();
    expect(calls).toBe(2);
    const after = new DatabaseSync(dbPath);
    const kept = after.prepare("SELECT state, settled_micro_usd, breach, usage_json FROM spend_reservations WHERE task_id = ?").get(firstView.id) as {
      state: string;
      settled_micro_usd: number;
      breach: number;
      usage_json: string;
    };
    const history = after.prepare("SELECT resolved_at, resolved_by, resolution_note, settled_micro_usd FROM spend_halts WHERE id = ?").get(halt.id) as {
      resolved_at: string | null;
      resolved_by: string;
      resolution_note: string;
      settled_micro_usd: number;
    };
    const done = after.prepare("SELECT state FROM tasks WHERE id = ?").get(secondView.id) as { state: string };
    after.close();
    expect(kept).toMatchObject({ state: "settled", settled_micro_usd: 12_500_000, breach: 1 });
    expect(kept.usage_json).toContain(String(ticks));
    expect(history.resolved_at).toBeTruthy();
    expect(history.resolved_by).toBe("operator");
    expect(history.resolution_note).toBe("Reviewed the provider invoice");
    expect(history.settled_micro_usd).toBe(12_500_000);
    expect(done.state).toBe("succeeded");
  });
});

describe("grok request bounds", () => {
  it("sends the visible max_completion_tokens cap and keeps token prices separate from ticks", async () => {
    const seen: { body?: Record<string, unknown>; signal?: AbortSignal } = {};
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.signal = init?.signal ?? undefined;
      return new Response(JSON.stringify({
        id: "trace-bounds",
        model: "grok-4-spec",
        choices: [{ message: { role: "assistant", content: JSON.stringify({ kind: "clarification", questions: ["Which file?"] }) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 400_000 },
          completion_tokens_details: { reasoning_tokens: 0 },
          cost_in_usd_ticks: 12345,
        },
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const model = grokDraftModel({ apiKey: "xai-SPEC-SECRET-KEY-9f8e7d6c5b4a", model: "grok-4-spec", fetch });
    const grokInput = {
      request: "Count the words",
      outputs: [{ name: "result.json", format: "json" as const }],
      referenceNames: [] as string[],
      clarifications: [] as { question: string; answer: string }[],
      schema: { type: "object" },
    };
    const out = await model.draft(grokInput);
    expect(seen.body?.max_completion_tokens).toBe(8192);
    expect(seen.body?.max_tokens).toBeUndefined();
    expect(seen.body?.presence_penalty).toBeUndefined();
    expect(seen.body?.frequency_penalty).toBeUndefined();
    expect(seen.body?.stop).toBeUndefined();
    expect(seen.body?.reasoning_effort).toBeUndefined();
    expect(seen.body?.tools).toBeUndefined();
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(seen.body)).toContain("You have no wallet");
    expect(out.usage).toMatchObject({ promptTokens: 1_000_000, cachedTokens: 400_000, costInUsdTicks: 12345 });
    const priced = createApp({
      dbPath: ":memory:",
      buyerToken: BUYER_TOKEN,
      budget,
    });
    opened.push(priced);
    const { quoteAuthoringCost } = await import("../../src/tasks.ts");
    expect(quoteAuthoringCost(out.usage!, budget)).toBe(1_250_000);

    const length = grokDraftModel({
      apiKey: "xai-SPEC-SECRET-KEY-9f8e7d6c5b4a",
      model: "grok-4-spec",
      fetch: (async () => new Response(JSON.stringify({
        id: "trace-length",
        choices: [{ message: { content: "{}" }, finish_reason: "length" }],
      }), { status: 200 })) as typeof globalThis.fetch,
    });
    await expect(length.draft({ ...grokInput, request: "Count", schema: {} })).rejects.toMatchObject({ reason: "finish_length" });
  });
});
