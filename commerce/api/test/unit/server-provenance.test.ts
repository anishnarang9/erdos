import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ openDb: vi.fn(), indexer: vi.fn(), serve: vi.fn() }));
vi.mock("../../src/db.ts", () => ({ openDb: calls.openDb }));
vi.mock("../../src/indexer.ts", () => ({ createIndexer: calls.indexer }));
vi.mock("@hono/node-server", () => ({ serve: calls.serve }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => false }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.resetModules(); });

describe("server rejects unsafe provenance before side effects", () => {
  it.each([undefined, "simulated"])("Arc plus ENGINE_MODE=%s never opens DB, starts indexer, or listens", async (mode) => {
    vi.stubEnv("BUYER_API_TOKEN", "startup-test-token-0123456789");
    vi.stubEnv("CHAIN_RPC_URL", "http://127.0.0.1:1");
    vi.stubEnv("CHAIN_ID", "31337");
    vi.stubEnv("CHAIN_CORE", "0x1111111111111111111111111111111111111111");
    vi.stubEnv("CHAIN_HOOK", "0x2222222222222222222222222222222222222222");
    vi.stubEnv("CHAIN_USDC", "0x3333333333333333333333333333333333333333");
    vi.stubEnv("ENGINE_MODE", mode);
    await expect(import("../../src/server.ts")).rejects.toThrow(/explicitly real engine/);
    expect(calls.openDb).not.toHaveBeenCalled();
    expect(calls.indexer).not.toHaveBeenCalled();
    expect(calls.serve).not.toHaveBeenCalled();
  });
});
