// T5 §3 grokDraftModel — black-box with a fake fetch (no network).
import { afterEach, describe, expect, it } from "vitest";
import { grokDraftModel } from "../../src/index.ts";
import { expectError } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import { DRAFT_BODY, OUTPUTS, json, makeApp56, req } from "./helpers-t56.ts";
import type { DraftInput, SpecDraftModel } from "./helpers-t56.ts";

const API_KEY = "xai-SPEC-SECRET-KEY-9f8e7d6c5b4a";

type Captured = { url: string; method: string; headers: Headers; body: string };

function fakeFetch(respond: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    let url: string;
    let method = init?.method;
    let headers: Headers;
    let body: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = (input as Request).url;
    if (input instanceof Request) {
      method = method ?? input.method;
      headers = new Headers(init?.headers ?? input.headers);
      body = typeof init?.body === "string" ? init.body : await input.clone().text();
    } else {
      headers = new Headers(init?.headers);
      const b = init?.body;
      body = typeof b === "string" ? b : b instanceof Uint8Array ? Buffer.from(b).toString("utf8") : String(b ?? "");
    }
    const c: Captured = { url, method: (method ?? "GET").toUpperCase(), headers, body };
    calls.push(c);
    return await respond(c);
  };
  return { calls, fetch: f as unknown as typeof fetch };
}

function okResponse(content: unknown, id = "resp-trace-42", extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      model: "grok-4-spec",
      choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const INPUT: DraftInput = {
  request: "Count the words",
  outputs: OUTPUTS,
  referenceNames: ["a.txt"],
  clarifications: [{ question: "Which file?", answer: "a.txt" }],
  schema: { type: "object" },
};

const GOOD_DRAFT = {
  kind: "draft",
  plan: { version: 1 },
  examples: [{ name: "e1", files: [{ name: "a.txt", content: "hi" }], predictedVerdict: 1 }],
  sourceQuotes: [{ path: "a.txt", quote: "hi" }],
};

function model(f: typeof fetch, baseUrl?: string): SpecDraftModel {
  const o: Record<string, unknown> = { apiKey: API_KEY, model: "grok-4-spec", fetch: f };
  if (baseUrl) o.baseUrl = baseUrl;
  return grokDraftModel(o as unknown as Parameters<typeof grokDraftModel>[0]) as unknown as SpecDraftModel;
}

async function expectThrowsWithoutKey(p: Promise<unknown>): Promise<Error> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the call to throw").toBeDefined();
  const e = err as Error;
  expect(String(e?.message ?? e)).not.toContain(API_KEY);
  expect(String(e?.stack ?? "")).not.toContain(API_KEY);
  expect(String(e)).not.toContain(API_KEY);
  try {
    expect(JSON.stringify(e)).not.toContain(API_KEY);
  } catch (inner) {
    if (inner instanceof TypeError) return e; // circular, ignore
    throw inner;
  }
  return e;
}

describe("grokDraftModel request", () => {
  it("POST {default baseUrl}/chat/completions with Bearer key, model, temperature 0, strict json_schema ubc26_draft", async () => {
    const ff = fakeFetch(() => okResponse(GOOD_DRAFT));
    const out = await model(ff.fetch).draft(INPUT);
    expect(ff.calls.length).toBe(1);
    const c = ff.calls[0]!;
    expect(c.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(c.method).toBe("POST");
    expect(c.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(c.headers.get("content-type") ?? "").toMatch(/application\/json/i);
    const body = JSON.parse(c.body) as Record<string, any>;
    expect(body.model).toBe("grok-4-spec");
    expect(body.temperature).toBe(0);
    expect(body).not.toHaveProperty("search_parameters");
    expect(body).not.toHaveProperty("tools");
    expect(body.response_format?.type).toBe("json_schema");
    expect(body.response_format?.json_schema?.name).toBe("ubc26_draft");
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(typeof body.response_format?.json_schema?.schema).toBe("object");
    expect(body.response_format.json_schema.schema).not.toBeNull();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.some((m: { role: string }) => m.role === "system")).toBe(true);
    // the request text reaches the model somewhere in the messages
    expect(JSON.stringify(body.messages)).toContain("Count the words");
    // key never in the body
    expect(c.body).not.toContain(API_KEY);
    expect(out.result).toEqual(GOOD_DRAFT);
    expect(typeof out.model).toBe("string");
  });

  it("custom baseUrl is honoured", async () => {
    const ff = fakeFetch(() => okResponse(GOOD_DRAFT));
    await model(ff.fetch, "http://127.0.0.1:9/xai").draft(INPUT);
    expect(ff.calls[0]!.url).toBe("http://127.0.0.1:9/xai/chat/completions");
  });

  it("traceId is the response id", async () => {
    const ff = fakeFetch(() => okResponse(GOOD_DRAFT, "chatcmpl-abc-123"));
    const out = await model(ff.fetch).draft(INPUT);
    expect(out.traceId).toBe("chatcmpl-abc-123");
  });

  it("clarification and unsupported replies are returned as parsed ModelDraft", async () => {
    const clar = { kind: "clarification", questions: ["a?", "b?", "c?", "d?", "e?"] };
    const out1 = await model(fakeFetch(() => okResponse(clar)).fetch).draft(INPUT);
    expect(out1.result).toEqual(clar);
    const uns = { kind: "unsupported", reason: "needs GPU" };
    const out2 = await model(fakeFetch(() => okResponse(uns)).fetch).draft(INPUT);
    expect(out2.result).toEqual(uns);
  });
});

describe("grokDraftModel failures throw ModelError, never leaking the API key", () => {
  it("HTTP 500 throws", async () => {
    const ff = fakeFetch(() => new Response("internal error", { status: 500 }));
    await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT));
  });
  it("HTTP 401 whose body echoes the key throws without the key in the error", async () => {
    const ff = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: `Incorrect API key provided: ${API_KEY}` }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT));
  });
  it("retains only the HTTP status and a known provider code", async () => {
    const ff = fakeFetch(() => new Response(JSON.stringify({ error: {
      code: "insufficient_quota", message: `Private response ${API_KEY}`,
    } }), { status: 402, headers: { "content-type": "application/json" } }));
    const err = await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT)) as Error & {
      httpStatus?: number; providerCode?: string;
    };
    expect(err.httpStatus).toBe(402);
    expect(err.providerCode).toBe("insufficient_quota");
    expect(JSON.stringify(err)).not.toContain("Private response");
  });
  it("rejects an unrecognized provider code even when it is short", async () => {
    const ff = fakeFetch(() => new Response(JSON.stringify({ error: {
      code: "private_account_name", message: API_KEY,
    } }), { status: 400, headers: { "content-type": "application/json" } }));
    const err = await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT)) as Error & {
      httpStatus?: number; providerCode?: string;
    };
    expect(err.httpStatus).toBe(400);
    expect(err.providerCode).toBeUndefined();
  });
  it("fetch rejection (network error mentioning the key) throws without the key", async () => {
    const ff = fakeFetch(() => {
      throw new Error(`connect failed; auth=Bearer ${API_KEY}`);
    });
    await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT));
  });
  it("malformed content (not JSON) throws", async () => {
    await expectThrowsWithoutKey(model(fakeFetch(() => okResponse("{not json")).fetch).draft(INPUT));
  });
  it("missing content throws", async () => {
    const ff = fakeFetch(
      () => new Response(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant" } }] }), { status: 200 }),
    );
    await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT));
  });
  it("empty choices throws", async () => {
    const ff = fakeFetch(() => new Response(JSON.stringify({ id: "x", choices: [] }), { status: 200 }));
    await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT));
  });
  it("response body that is not JSON throws", async () => {
    const ff = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expectThrowsWithoutKey(model(ff.fetch).draft(INPUT));
  });

  const invalid: [string, unknown][] = [
    ["unknown kind", { kind: "bogus" }],
    ["clarification with 0 questions", { kind: "clarification", questions: [] }],
    ["clarification with 6 questions", { kind: "clarification", questions: ["1", "2", "3", "4", "5", "6"] }],
    ["clarification question not a string", { kind: "clarification", questions: [1] }],
    ["unsupported without reason", { kind: "unsupported" }],
    ["draft without examples", { kind: "draft", plan: { version: 1 }, sourceQuotes: [] }],
    ["draft with predictedVerdict 2", { ...GOOD_DRAFT, examples: [{ name: "e", files: [], predictedVerdict: 2 }] }],
    ["draft without sourceQuotes", { kind: "draft", plan: { version: 1 }, examples: [] }],
    ["top-level array", [GOOD_DRAFT]],
  ];
  for (const [name, content] of invalid) {
    it(`content failing ModelDraft validation throws: ${name}`, async () => {
      await expectThrowsWithoutKey(model(fakeFetch(() => okResponse(content)).fetch).draft(INPUT));
    });
  }
});

describe("grokDraftModel through POST /v1/drafts", () => {
  let s: SpecApp | undefined;
  afterEach(() => {
    s?.close();
    s = undefined;
  });
  it("upstream 500 -> 502 model_failed with no key in the response", async () => {
    const ff = fakeFetch(() => new Response(`bad key ${API_KEY}`, { status: 500 }));
    s = makeApp56({ draftModel: model(ff.fetch) });
    const res = await req(s, "POST", "/v1/drafts", DRAFT_BODY);
    const text = await res.clone().text();
    expect(text).not.toContain(API_KEY);
    await expectError(res, 502, "model_failed");
  });
  it("returns sanitized provider metadata with a failed draft", async () => {
    const ff = fakeFetch(() => new Response(JSON.stringify({ error: {
      code: "insufficient_quota", message: `Private response ${API_KEY}`,
    } }), { status: 402, headers: { "content-type": "application/json" } }));
    s = makeApp56({ draftModel: model(ff.fetch) });
    const res = await req(s, "POST", "/v1/drafts", DRAFT_BODY);
    const body = await json(res);
    expect(res.status).toBe(502);
    expect(body.error.details.attempts[0]).toMatchObject({
      reason: "http_error", httpStatus: 402, providerCode: "insufficient_quota",
    });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(JSON.stringify(body)).not.toContain("Private response");
  });
  it("success -> draft response with traceId from the response id", async () => {
    const ff = fakeFetch(() => okResponse(GOOD_DRAFT, "trace-through-route"));
    s = makeApp56({ draftModel: model(ff.fetch) });
    const res = await req(s, "POST", "/v1/drafts", DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("draft");
    expect(b.traceId).toBe("trace-through-route");
    const sent = JSON.parse(ff.calls[0]!.body) as Record<string, any>;
    expect(sent.temperature).toBe(0);
  });
});
