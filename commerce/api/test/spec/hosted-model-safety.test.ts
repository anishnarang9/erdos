// Provider response bounds. No live model call.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, simulatedEngine, type CreateAppOptions } from "../../src/index.ts";
import { ENGINE_CATALOG, PLAN_SCHEMA } from "../../src/authoring.ts";
import { DRAFT_MAX_COMPLETION_TOKENS, ModelError, draftCallTokenBound, grokDraftModel, readModelUsage, type DraftModelInput } from "../../src/grok.ts";
import { authoringCharge, maxCallMicroUsd, ticksToMicroUsd } from "../../src/tasks.ts";
import { BUYER_TOKEN, T0, freshKey } from "./helpers.ts";

const input = {
  request: "Check a policy",
  outputs: [] as { name: string; format: "json" }[],
  referenceNames: [] as string[],
  clarifications: [] as { question: string; answer: string }[],
  schema: {},
};

describe("provider response bounds", () => {
  it("cancels an oversized provider response before buffering its complete body", async () => {
    let cancelled = false;
    let pulls = 0;
    const chunk = new TextEncoder().encode("x".repeat(256 * 1024));
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"choices":[{"finish_reason":"stop","message":{"content":"'));
        else if (pulls < 18) controller.enqueue(chunk);
        else {
          controller.enqueue(new TextEncoder().encode('"}}],"id":"test"}'));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "application/json" } });
    const model = grokDraftModel({
      apiKey: "synthetic-test-api-key",
      model: "controlled-test-model",
      fetch: async () => response,
    });
    await expect(model.draft(input)).rejects.toMatchObject({ reason: "output_too_large" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(18);
  });

  it("cancels a stalled read when the request deadline expires", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    }));
    const model = grokDraftModel({
      apiKey: "synthetic-test-api-key",
      model: "controlled-test-model",
      timeoutMs: 30,
      fetch: async () => response,
    });
    await expect(model.draft(input)).rejects.toMatchObject({ reason: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("rejects a bad limit, a redirect, and a live credential aimed at another origin", async () => {
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/v1/chat/completions" } });
    }) as typeof globalThis.fetch;
    const model = grokDraftModel({ apiKey: "synthetic-test-api-key", model: "controlled-test-model", fetch });
    await expect(model.draft(input)).rejects.toMatchObject({ reason: "redirect" });
    expect(() => grokDraftModel({
      apiKey: "synthetic-test-api-key",
      model: "controlled-test-model",
      fetch,
      timeoutMs: Number.POSITIVE_INFINITY,
    })).toThrow(ModelError);
    expect(() => grokDraftModel({
      apiKey: "synthetic-test-api-key",
      model: "controlled-test-model",
      fetch,
      maxOutputChars: 1.5,
    })).toThrow(ModelError);
    let called = false;
    expect(() => grokDraftModel({
      apiKey: "synthetic-live-key",
      model: "controlled-test-model",
      baseUrl: "https://evil.example/v1",
      fetch: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch,
    })).not.toThrow();
    expect(() => grokDraftModel({
      apiKey: "synthetic-live-key",
      model: "controlled-test-model",
      baseUrl: "https://evil.example/v1",
    })).toThrow(ModelError);
    expect(called).toBe(false);
  });
});

const ORIGIN = "https://api.example.test";
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const opened: ReturnType<typeof createApp>[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": freshKey() };
}

async function post(app: ReturnType<typeof createApp>["app"], path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function issue(app: ReturnType<typeof createApp>["app"]) {
  const challenge = await post(app, "/v1/auth/challenge", { wallet: account.address.toLowerCase() }, { "content-type": "application/json" });
  const issued = await challenge.json() as { challengeId: string; message: string };
  expect(challenge.status, JSON.stringify(issued)).toBe(200);
  const signature = await account.signMessage({ message: issued.message });
  const keys = await post(app, "/v1/auth/keys", { challengeId: issued.challengeId, signature }, { "content-type": "application/json" });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
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

function appFor(extra: Partial<CreateAppOptions>, dbPath = ":memory:") {
  const created = createApp({
    dbPath,
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    deployment: { mode: "local", serviceOrigin: ORIGIN },
    engine: {
      ...simulatedEngine(),
      validate: async () => ({ ok: false as const, kind: "invalid" as const, errors: [{ path: "/version", message: "Invalid version" }] }),
    } as CreateAppOptions["engine"],
    ...extra,
  });
  opened.push(created);
  return created;
}

const pricedUsage = {
  promptTokens: 1000,
  completionTokens: 0,
  cachedTokens: null,
  reasoningTokens: null,
  costInUsdTicks: null,
};

const unitBudget = {
  requestCeilingMicroUsd: 1_000_000,
  dailyCeilingMicroUsd: 2_000_000,
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
};
const smallProviderInput = {
  request: "Check a policy",
  outputs: [{ name: "result.json", format: "json" as const }],
  referenceNames: [] as string[],
  referenceFiles: [] as { name: string; text: string }[],
  clarifications: [] as { question: string; answer: string }[],
  schema: PLAN_SCHEMA,
  catalog: ENGINE_CATALOG,
};

function callCost(input: DraftModelInput, completionTokens: number): number {
  const cost = maxCallMicroUsd(draftCallTokenBound(input, completionTokens), completionTokens, unitBudget);
  if (cost === null) throw new Error("test call cost overflowed");
  return cost;
}

describe("request spend ceiling", () => {
  it("does not dispatch when the serialized prompt and supported completion maximum exceed the ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-ceiling-"));
    const dbPath = join(dir, "api.db");
    let calls = 0;
    const full = callCost(smallProviderInput, DRAFT_MAX_COMPLETION_TOKENS);
    expect(full).toBeGreaterThan(1000);
    const created = appFor({
      dbPath,
      budget: {
        requestCeilingMicroUsd: 1000,
        dailyCeilingMicroUsd: 10_000,
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 1_000_000,
      },
      draftModel: {
        async draft() {
          calls += 1;
          return {
            model: "controlled-test-model",
            traceId: "test",
            usage: pricedUsage,
            result: { kind: "draft", plan: { version: 0 }, examples: [], sourceQuotes: [] },
          };
        },
      },
    }, dbPath);
    const key = await issue(created.app);
    const accepted = await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: {
        request: "Check a policy",
        outputs: [{ name: "result.json", format: "json" }],
        expirySeconds: 3600,
        maxBudget: "10000",
      },
    }, auth(key));
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(0);
    expect(reservation(dbPath)).toMatchObject({ state: "released", dispatched_at: null, settled_micro_usd: null });
  });

  it("does not repair when the repair payload and supported completion maximum exceed the remaining ceiling", async () => {
    const feedback = "x".repeat(4000);
    const repairInput = {
      ...smallProviderInput,
      repair: {
        attempt: 1 as const,
        reason: "plan_invalid" as const,
        errors: [{ path: "/version", message: feedback }],
        counterexamples: [],
      },
    };
    const first = callCost(smallProviderInput, DRAFT_MAX_COMPLETION_TOKENS);
    const repair = callCost(repairInput, DRAFT_MAX_COMPLETION_TOKENS);
    expect(repair).toBeGreaterThan(first);
    const ceiling = repair - 1;
    expect(first).toBeLessThanOrEqual(ceiling);
    let calls = 0;
    let cap: number | undefined;
    const created = appFor({
      budget: {
        ...unitBudget,
        requestCeilingMicroUsd: ceiling,
      },
      engine: {
        ...simulatedEngine(),
        validate: async () => ({ ok: false as const, kind: "invalid" as const, errors: [{ path: "/version", message: feedback }] }),
      } as CreateAppOptions["engine"],
      draftModel: {
        async draft(input) {
          calls += 1;
          cap = input.maxCompletionTokens;
          return {
            model: "controlled-test-model",
            traceId: "test",
            usage: { promptTokens: 1, completionTokens: 0, cachedTokens: null, reasoningTokens: null, costInUsdTicks: null },
            result: { kind: "draft", plan: { version: 0 }, examples: [], sourceQuotes: [] },
          };
        },
      },
    });
    const key = await issue(created.app);
    expect((await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: {
        request: "Check a policy",
        outputs: [{ name: "result.json", format: "json" }],
        expirySeconds: 3600,
        maxBudget: "10000",
      },
    }, auth(key))).status).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(1);
    expect(cap).toBe(DRAFT_MAX_COMPLETION_TOKENS);
  });

  it("rejects a reference payload before dispatch when the full prompt cannot fit", async () => {
    const policy = "界".repeat(10_000);
    const withReference = {
      ...smallProviderInput,
      request: "Check the supplied policy",
      referenceNames: ["policy.txt"],
      referenceFiles: [{ name: "policy.txt", text: policy }],
    };
    expect(draftCallTokenBound(withReference, DRAFT_MAX_COMPLETION_TOKENS)).toBeGreaterThan(draftCallTokenBound(smallProviderInput, DRAFT_MAX_COMPLETION_TOKENS));
    expect(Buffer.byteLength(policy, "utf8")).toBe(30_000);
    const dir = mkdtempSync(join(tmpdir(), "ubc26-full-prompt-"));
    const dbPath = join(dir, "api.db");
    let calls = 0;
    const created = appFor({
      dbPath,
      budget: {
        requestCeilingMicroUsd: 1000,
        dailyCeilingMicroUsd: 10_000,
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 1_000_000,
      },
      draftModel: {
        async draft() {
          calls += 1;
          return { model: "controlled-test-model", traceId: "test", result: { kind: "clarification" as const, questions: ["Which policy?"] } };
        },
      },
    }, dbPath);
    const key = await issue(created.app);
    const accepted = await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: {
        request: "Check the supplied policy",
        outputs: [{ name: "result.json", format: "json" }],
        references: [{ name: "policy.txt", contentBase64: Buffer.from(policy, "utf8").toString("base64") }],
        expirySeconds: 3600,
        maxBudget: "10000",
      },
    }, auth(key));
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(0);
    expect(reservation(dbPath)).toMatchObject({ state: "released", dispatched_at: null, settled_micro_usd: null });
  });

  it("does not dispatch a public model that has no documented output bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-unbounded-"));
    const dbPath = join(dir, "api.db");
    let calls = 0;
    const created = appFor({
      dbPath,
      deployment: { mode: "public", serviceOrigin: ORIGIN },
      budget: unitBudget,
      draftModel: {
        async draft() {
          calls += 1;
          return { model: "controlled-test-model", traceId: "test", result: { kind: "clarification" as const, questions: ["Which file?"] } };
        },
      },
    }, dbPath);
    const key = await issue(created.app);
    const accepted = await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: {
        request: "Check a policy",
        outputs: [{ name: "result.json", format: "json" }],
        expirySeconds: 3600,
        maxBudget: "10000",
      },
    }, auth(key));
    const view = await accepted.json() as { id: string };
    expect(accepted.status, JSON.stringify(view)).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(0);
    const failed = await (await created.app.request(`/v1/tasks/${view.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as {
      state: string;
      error: { code: string; message: string };
    };
    expect(failed.state).toBe("failed");
    expect(failed.error.code).toBe("model_unavailable");
    expect(failed.error.message).toBe("Authoring output is not bounded");
    expect(reservation(dbPath)).toMatchObject({ state: "released", dispatched_at: null, settled_micro_usd: null });
  });

  it("does not dispatch when one prompt token and one completion token exceed the ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-min-"));
    const dbPath = join(dir, "api.db");
    let calls = 0;
    const created = appFor({
      dbPath,
      budget: {
        requestCeilingMicroUsd: 1,
        dailyCeilingMicroUsd: 100,
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 1_000_000,
      },
      draftModel: { async draft() { calls += 1; throw new Error("dispatched"); } },
    }, dbPath);
    const key = await issue(created.app);
    expect((await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: {
        request: "Check a policy",
        outputs: [{ name: "result.json", format: "json" }],
        expirySeconds: 3600,
        maxBudget: "10000",
      },
    }, auth(key))).status).toBe(202);
    await created.pumpTasks();
    expect(calls).toBe(0);
    expect(reservation(dbPath)).toMatchObject({ state: "released", dispatched_at: null, settled_micro_usd: null });
  });

  it("keeps token counts when ticks are unsafe and prices an actual tick charge above the tariff", () => {
    expect(readModelUsage({
      usage: { prompt_tokens: 3, completion_tokens: 1, cost_in_usd_ticks: 1.5 },
    })).toEqual({ promptTokens: 3, completionTokens: 1, cachedTokens: null, reasoningTokens: null, costInUsdTicks: null });
    expect(readModelUsage({
      usage: { prompt_tokens: 3, completion_tokens: 1, cost_in_usd_ticks: -5 },
    })?.costInUsdTicks).toBeNull();
    expect(ticksToMicroUsd(37_756_000)).toBe(3776);
    expect(ticksToMicroUsd(0)).toBe(0);
    expect(ticksToMicroUsd(1.5)).toBeNull();
    const budget = {
      requestCeilingMicroUsd: 5_000_000,
      dailyCeilingMicroUsd: 20_000_000,
      inputMicroUsdPerMillion: 1_250_000,
      outputMicroUsdPerMillion: 2_500_000,
    };
    const usage = { promptTokens: 1000, completionTokens: 1000, cachedTokens: null, reasoningTokens: null, costInUsdTicks: 37_756_000 };
    expect(authoringCharge(usage, budget)).toEqual({ microUsd: 3776, source: "actual", costInUsdTicks: 37_756_000 });
    expect(authoringCharge({ ...usage, costInUsdTicks: null }, budget)).toEqual({ microUsd: 3750, source: "tariff", costInUsdTicks: null });
  });

  it("preserves charged usage on a length stop and settles the actual ticks", async () => {
    const fetch = (async () => new Response(JSON.stringify({
      id: "trace-length",
      model: "grok-4-spec",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1000, completion_tokens: 4, cost_in_usd_ticks: 50_000 },
    }), { status: 200 })) as typeof globalThis.fetch;
    const model = grokDraftModel({ apiKey: "synthetic-test-api-key", model: "grok-4-spec", fetch });
    await expect(model.draft(input)).rejects.toMatchObject({
      reason: "finish_length",
      usage: { promptTokens: 1000, completionTokens: 4, costInUsdTicks: 50_000 },
    });

    const dir = mkdtempSync(join(tmpdir(), "ubc26-length-"));
    const dbPath = join(dir, "api.db");
    const created = appFor({
      dbPath,
      budget: {
        requestCeilingMicroUsd: 50_000,
        dailyCeilingMicroUsd: 100_000,
        inputMicroUsdPerMillion: 1_250_000,
        outputMicroUsdPerMillion: 2_500_000,
      },
      draftModel: model,
    }, dbPath);
    const key = await issue(created.app);
    const accepted = await post(created.app, "/v1/tasks", {
      operation: "draft",
      input: {
        request: "Check a policy",
        outputs: [{ name: "result.json", format: "json" }],
        expirySeconds: 3600,
        maxBudget: "10000",
      },
    }, auth(key));
    const view = await accepted.json() as { id: string };
    expect(accepted.status).toBe(202);
    await created.pumpTasks();
    const failed = await (await created.app.request(`/v1/tasks/${view.id}`, { headers: { authorization: `Bearer ${key}` } })).json() as { state: string; error: { message: string } };
    expect(failed.state).toBe("failed");
    expect(failed.error.message).toBe("The draft model failed");
    expect(JSON.stringify(failed)).not.toContain("synthetic-test-api-key");
    const row = reservation(dbPath);
    expect(row.state).toBe("settled");
    expect(row.settled_micro_usd).toBe(5);
    expect(row.breach).toBe(0);
    expect(row.usage_json).toContain("50000");
  });

  it("asks for a caller completion cap and does not raise it above the supported maximum", async () => {
    const seen: number[] = [];
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      const wire = JSON.parse(String(init?.body)) as { max_tokens?: number; max_completion_tokens?: number };
      expect(wire.max_completion_tokens).toBeUndefined();
      seen.push(wire.max_tokens ?? -1);
      return new Response(JSON.stringify({
        id: "trace-cap",
        model: "grok-4-spec",
        choices: [{ message: { content: JSON.stringify({ kind: "clarification", questions: ["Which file?"] }) }, finish_reason: "stop" }],
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const model = grokDraftModel({ apiKey: "synthetic-test-api-key", model: "grok-4-spec", fetch });
    await model.draft({ ...input, maxCompletionTokens: 10 });
    await model.draft({ ...input, request: "Check another policy", maxCompletionTokens: 999_999 });
    expect(seen).toEqual([10, 8192]);
  });
});
