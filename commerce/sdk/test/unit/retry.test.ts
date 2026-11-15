import { describe, expect, it } from "vitest";
import { isRateLimitError, withRetry } from "../../src/index.ts";

function rpcError(code: number, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

describe("withRetry", () => {
  it("retries -32005 then succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw rpcError(-32005, "request limit exceeded");
        return "ok";
      },
      { baseMs: 1 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("detects 429, nested causes and 'rate limit' messages", () => {
    expect(isRateLimitError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimitError(new Error("outer", { cause: rpcError(-32005) }))).toBe(true);
    expect(isRateLimitError(new Error("You hit a Rate Limit"))).toBe(true);
    expect(isRateLimitError(rpcError(-32000, "execution reverted"))).toBe(false);
  });

  it("rethrows other errors immediately", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw rpcError(-32000, "execution reverted");
      }, { baseMs: 1 }),
    ).rejects.toThrow("execution reverted");
    expect(calls).toBe(1);
  });

  it("gives up after `retries` retries", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw rpcError(-32005);
      }, { retries: 2, baseMs: 1 }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3);
  });
});
