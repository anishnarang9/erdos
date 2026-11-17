import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  openDb: vi.fn(),
  indexer: vi.fn(),
  serve: vi.fn(),
  // Test-only. Production chainFromEnv always returns an arc chain; this rewrites that result so the
  // startup ternary's simulated arm can be executed without adding a server mode switch.
  chainMode: undefined as "arc" | "simulated" | undefined,
}));
vi.mock("../../src/db.ts", async (original) => {
  const actual = await original<typeof import("../../src/db.ts")>();
  return { ...actual, openDb: (path: string, now: () => number) => calls.openDb(path, now) };
});
vi.mock("../../src/indexer.ts", () => ({ createIndexer: calls.indexer }));
vi.mock("../../src/chain.ts", async (original) => {
  const actual = await original<typeof import("../../src/chain.ts")>();
  return {
    ...actual,
    createApiArcChain: (...args: Parameters<typeof actual.createApiArcChain>) => {
      const chain = actual.createApiArcChain(...args);
      return calls.chainMode === "simulated" ? { ...chain, mode: "simulated" as const } : chain;
    },
  };
});
vi.mock("@hono/node-server", () => ({ serve: calls.serve }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => false }));

afterEach(() => {
  calls.chainMode = undefined;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  calls.openDb.mockReset();
  calls.indexer.mockReset();
  calls.serve.mockReset();
  vi.resetModules();
});

const chainEnv = (): void => {
  vi.stubEnv("BUYER_API_TOKEN", "startup-test-token-0123456789");
  vi.stubEnv("CHAIN_RPC_URL", "http://127.0.0.1:1");
  vi.stubEnv("CHAIN_ID", "31337");
  vi.stubEnv("CHAIN_CORE", "0x1111111111111111111111111111111111111111");
  vi.stubEnv("CHAIN_HOOK", "0x2222222222222222222222222222222222222222");
  vi.stubEnv("CHAIN_USDC", "0x3333333333333333333333333333333333333333");
  vi.stubEnv("DB_PATH", ":memory:");
};

/** Import the script entry and capture createIndexer options. Closes databases and timers it starts. */
async function bootIndexer(): Promise<Record<string, unknown>> {
  const actualDb = await vi.importActual<typeof import("../../src/db.ts")>("../../src/db.ts");
  const opened: { close: () => void; isOpen: boolean }[] = [];
  let opts: Record<string, unknown> | undefined;
  calls.openDb.mockImplementation((path: string, now: () => number) => {
    const db = actualDb.openDb(path, now);
    opened.push(db);
    return db;
  });
  calls.indexer.mockImplementation((value: Record<string, unknown>) => {
    opts = value;
    return { tick: async () => 0 };
  });
  calls.serve.mockImplementation(() => ({ close: () => undefined }));
  const interval = vi.spyOn(global, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit ${code ?? ""}`);
  }) as typeof process.exit);
  const signals = ["SIGINT", "SIGTERM"] as const;
  const before = new Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
  try {
    await import("../../src/server.ts");
    if (!opts) throw new Error("createIndexer was not called");
    return opts;
  } finally {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)?.has(listener)) process.removeListener(signal, listener);
      }
    }
    for (const db of opened) if (db.isOpen) db.close();
    interval.mockRestore();
    exit.mockRestore();
  }
}

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

describe("server indexer confirmation margin", () => {
  it("passes 3n for an arc chain and does not change the cursor start or log window", async () => {
    chainEnv();
    vi.stubEnv("ENGINE_MODE", "wsl");
    vi.stubEnv("ENGINE_PATH", "engine-bin-not-executed");
    const opts = await bootIndexer();
    expect(opts.chain).toMatchObject({ mode: "arc" });
    expect(opts.confirmations).toBe(3n);
    expect(opts.cursorStart).toBe(0n);
    expect(opts.maxRange).toBeUndefined();
  });

  it("passes 0n when the started chain mode is simulated", async () => {
    chainEnv();
    vi.stubEnv("ENGINE_MODE", "simulated");
    calls.chainMode = "simulated";
    const opts = await bootIndexer();
    expect(opts.chain).toMatchObject({ mode: "simulated" });
    expect(opts.confirmations).toBe(0n);
    expect(opts.maxRange).toBeUndefined();
  });
});
