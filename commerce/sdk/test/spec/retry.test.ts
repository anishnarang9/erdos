// CONTRACT.md §2 withRetry (L195) and ChainError shape (L196). No chain needed.
import { describe, it, expect, vi } from "vitest";
import { withRetry, ChainError } from "../../src/index.ts";

function flaky(failures: number, err: () => unknown) {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= failures) throw err();
    return "done";
  };
  return { fn, calls: () => calls };
}

const rpc32005 = () => Object.assign(new Error("limit exceeded"), { code: -32005 });
const http429 = () => Object.assign(new Error("Too Many Requests"), { status: 429 });
const msgRate = () => new Error("upstream says: Rate Limit reached");

describe("CONTRACT §2 withRetry (L195)", () => {
  it("L195 retries JSON-RPC -32005 and then succeeds", async () => {
    const f = flaky(2, rpc32005);
    await expect(withRetry(f.fn, { retries: 5, baseMs: 1 })).resolves.toBe("done");
    expect(f.calls()).toBe(3);
  });
  it("L195 retries HTTP 429", async () => {
    const f = flaky(1, http429);
    await expect(withRetry(f.fn, { retries: 5, baseMs: 1 })).resolves.toBe("done");
    expect(f.calls()).toBe(2);
  });
  it("L195 retries a message containing 'rate limit' (case-insensitive reading)", async () => {
    const f = flaky(1, msgRate);
    await expect(withRetry(f.fn, { retries: 5, baseMs: 1 })).resolves.toBe("done");
    expect(f.calls()).toBe(2);
  });
  it("L195 any other error is rethrown immediately (one call)", async () => {
    const err = new Error("execution reverted");
    const f = flaky(10, () => err);
    await expect(withRetry(f.fn, { retries: 5, baseMs: 1 })).rejects.toBe(err);
    expect(f.calls()).toBe(1);
  });
  it("L195 gives up after `retries` retries and rethrows the rate-limit error", async () => {
    const f = flaky(100, rpc32005);
    await expect(withRetry(f.fn, { retries: 3, baseMs: 1 })).rejects.toMatchObject({ code: -32005 });
    expect(f.calls()).toBe(4);
  });
  it("L195 backoff is exponential (total wait >= base*(1+2+4))", async () => {
    const f = flaky(3, rpc32005);
    const t0 = Date.now();
    await withRetry(f.fn, { retries: 5, baseMs: 20 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20 * 7 - 5);
  });
});

describe("Round 2: withRetry nested causes and defaults", () => {
  const nested32005 = () => new Error("wrapped", { cause: Object.assign(new Error("inner"), { code: -32005 }) });
  const nested429 = () => new Error("outer", { cause: new Error("mid", { cause: Object.assign(new Error("x"), { status: 429 }) }) });
  it("retries when -32005 is on a nested cause", async () => {
    const f = flaky(2, nested32005);
    await expect(withRetry(f.fn, { retries: 5, baseMs: 1 })).resolves.toBe("done");
    expect(f.calls()).toBe(3);
  });
  it("retries when HTTP 429 is two causes deep", async () => {
    const f = flaky(1, nested429);
    await expect(withRetry(f.fn, { retries: 5, baseMs: 1 })).resolves.toBe("done");
    expect(f.calls()).toBe(2);
  });
  it("defaults: retries=5 (6 calls), first retry not before 250 ms", async () => {
    vi.useFakeTimers();
    try {
      const f = flaky(1000, rpc32005);
      const p = withRetry(f.fn);
      const settled = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(249);
      expect(f.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await settled).toMatchObject({ code: -32005 });
      expect(f.calls()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CONTRACT §2 ChainError (L196)", () => {
  it("L196 ChainError is a subclass of Error", () => {
    expect(Object.create(ChainError.prototype)).toBeInstanceOf(Error);
  });
});
