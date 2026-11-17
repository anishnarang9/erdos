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
  it("sends the full UTF-8 reference and rejects binary without a model call", async () => {
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
    expect(bad.status, text).toBe(400);
    expect(text).not.toContain("binary file");
    expect(text).not.toContain("<truncated");
    expect(model.calls).toHaveLength(before);
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
          return { ...draftReply(repairCalls === 1 ? { version: 1 } : { version: 2 }), usage: { ...usage, costInUsdTicks: null } };
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

  it("retains the actual cost when it exceeds the ceiling", async () => {
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
            usage: { promptTokens: 10_000_000, completionTokens: 0, cachedTokens: 0, reasoningTokens: null, costInUsdTicks: null },
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
});

describe("grok request bounds", () => {
  it("sends max_tokens, refuses a length stop, and keeps token prices separate from ticks", async () => {
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
    expect(seen.body?.max_tokens).toBe(8192);
    expect(seen.body?.max_completion_tokens).toBeUndefined();
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
