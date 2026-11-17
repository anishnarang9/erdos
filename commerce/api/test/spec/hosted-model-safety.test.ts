// Provider response bounds. No live model call.
import { describe, expect, it } from "vitest";
import { ModelError, grokDraftModel } from "../../src/grok.ts";

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
