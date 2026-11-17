import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("public engine startup pin", () => {
  async function expectExit(message: RegExp, options?: { openDb?: boolean }): Promise<string> {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${code ?? ""}`);
    }) as typeof process.exit);
    try {
      await expect(import("../../src/server.ts")).rejects.toThrow(/process.exit 1/);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(message));
      expect(calls.serve).not.toHaveBeenCalled();
      if (options?.openDb) expect(calls.openDb).toHaveBeenCalled();
      else expect(calls.openDb).not.toHaveBeenCalled();
      return error.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  }

  it("exits before listen when public mode has no real engine", async () => {
    vi.stubEnv("BUYER_API_TOKEN", "startup-test-token-0123456789");
    vi.stubEnv("DEPLOYMENT_MODE", "public");
    vi.stubEnv("DB_PATH", ":memory:");
    await expectExit(/absolute executable/);
  });

  it("exits before listen when the public engine path is relative", async () => {
    vi.stubEnv("BUYER_API_TOKEN", "startup-test-token-0123456789");
    vi.stubEnv("DEPLOYMENT_MODE", "public");
    vi.stubEnv("DB_PATH", ":memory:");
    vi.stubEnv("ENGINE_MODE", "native");
    vi.stubEnv("ENGINE_PATH", "relative-engine");
    await expectExit(/ENGINE_PATH must be an absolute path/);
  });

  it("exits before openDb when an absolute engine has no matching digest", async () => {
    const pin = await publicPin();
    try {
      stubPublic(pin);
      const text = await expectExit(/engine_executable unpinned/);
      expect(text).not.toContain(pin.enginePath);
    } finally {
      await rm(pin.root, { recursive: true, force: true });
    }
  });

  it("exits before openDb when the digest does not match the on-disk bytes", async () => {
    const pin = await publicPin();
    try {
      stubPublic(pin);
      vi.stubEnv("ENGINE_SHA256", "ab".repeat(32));
      const text = await expectExit(/digest_mismatch/);
      expect(text).not.toContain(pin.enginePath);
      expect(text).not.toContain("ab".repeat(32));
    } finally {
      await rm(pin.root, { recursive: true, force: true });
    }
  });

  it("exits before openDb when the WSL wrapper is not pinned", async () => {
    const pin = await publicPin();
    try {
      stubPublic(pin);
      vi.stubEnv("ENGINE_MODE", "wsl");
      vi.stubEnv("ENGINE_SHA256", pin.sha256);
      vi.stubEnv("ENGINE_WSL_BIN", pin.wrapperPath);
      const text = await expectExit(/compiler_wrapper unpinned/);
      expect(text).not.toContain(pin.wrapperPath);
      expect(text).not.toContain(pin.enginePath);
    } finally {
      await rm(pin.root, { recursive: true, force: true });
    }
  });

  it("exits before openDb when the configured model is not reviewed", async () => {
    const pin = await publicPin();
    try {
      stubPublic(pin);
      vi.stubEnv("ENGINE_SHA256", pin.sha256);
      vi.stubEnv("AUTHORING_REQUIRED", "1");
      vi.stubEnv("XAI_API_KEY", "synthetic-ready-secret-value");
      vi.stubEnv("XAI_MODEL", "grok-4.7");
      vi.stubEnv("AUTHORING_REQUEST_CEILING_MICRO_USD", "2540960");
      vi.stubEnv("AUTHORING_DAILY_CEILING_MICRO_USD", "2540960");
      vi.stubEnv("AUTHORING_INPUT_MICRO_USD_PER_MILLION", "2500000");
      vi.stubEnv("AUTHORING_OUTPUT_MICRO_USD_PER_MILLION", "5000000");
      const text = await expectExit(/unreviewed_model/);
      expect(text).not.toContain("synthetic-ready-secret-value");
      expect(text).not.toContain(pin.enginePath);
    } finally {
      await rm(pin.root, { recursive: true, force: true });
    }
  });

  it("opens the database and still refuses listen when the database is not durable", async () => {
    const pin = await publicPin();
    const opened: { close: () => void; isOpen: boolean }[] = [];
    const actualDb = await vi.importActual<typeof import("../../src/db.ts")>("../../src/db.ts");
    calls.openDb.mockImplementation((path: string, now: () => number) => {
      const db = actualDb.openDb(path, now);
      opened.push(db);
      return db;
    });
    const interval = vi.spyOn(global, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    try {
      stubPublic(pin);
      vi.stubEnv("ENGINE_SHA256", pin.sha256);
      vi.stubEnv("AUTHORING_REQUIRED", "0");
      vi.stubEnv("DB_PATH", ":memory:");
      const text = await expectExit(/not_durable/, { openDb: true });
      expect(text).not.toContain(pin.enginePath);
      expect(text).not.toContain(pin.packages);
    } finally {
      interval.mockRestore();
      for (const db of opened) if (db.isOpen) db.close();
      await rm(pin.root, { recursive: true, force: true });
    }
  });

  it("listens when public authoring is explicitly disabled and every pin matches", async () => {
    const pin = await publicPin();
    const opened: { close: () => void; isOpen: boolean }[] = [];
    const actualDb = await vi.importActual<typeof import("../../src/db.ts")>("../../src/db.ts");
    calls.openDb.mockImplementation((path: string, now: () => number) => {
      const db = actualDb.openDb(path, now);
      opened.push(db);
      return db;
    });
    calls.serve.mockImplementation(() => ({ close: () => undefined }));
    const interval = vi.spyOn(global, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${code ?? ""}`);
    }) as typeof process.exit);
    const signals = ["SIGINT", "SIGTERM"] as const;
    const before = new Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
    try {
      stubPublic(pin);
      vi.stubEnv("ENGINE_SHA256", pin.sha256);
      vi.stubEnv("AUTHORING_REQUIRED", "0");
      vi.stubEnv("DB_PATH", join(pin.root, "service.db"));
      await import("../../src/server.ts");
      expect(exit).not.toHaveBeenCalled();
      expect(calls.serve).toHaveBeenCalled();
      expect(calls.openDb).toHaveBeenCalled();
    } finally {
      for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
          if (!before.get(signal)?.has(listener)) process.removeListener(signal, listener);
        }
      }
      for (const db of opened) if (db.isOpen) db.close();
      interval.mockRestore();
      exit.mockRestore();
      await rm(pin.root, { recursive: true, force: true });
    }
  });
});

async function publicPin(): Promise<{ root: string; enginePath: string; wrapperPath: string; packages: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "ubc26-public-pin-"));
  const enginePath = join(root, "engine.bin");
  const wrapperPath = join(root, "wsl.bin");
  const packages = join(root, "packages");
  const bytes = Buffer.from("public-engine-bytes");
  await writeFile(enginePath, bytes);
  await writeFile(wrapperPath, Buffer.from("public-wrapper-bytes"));
  await mkdir(packages);
  return { root, enginePath, wrapperPath, packages, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function stubPublic(pin: { enginePath: string; packages: string }): void {
  vi.stubEnv("BUYER_API_TOKEN", "startup-test-token-0123456789");
  vi.stubEnv("DEPLOYMENT_MODE", "public");
  vi.stubEnv("SERVICE_ORIGIN", "https://api.example.test");
  vi.stubEnv("ENGINE_MODE", "native");
  vi.stubEnv("ENGINE_PATH", pin.enginePath);
  vi.stubEnv("PACKAGES_DIR", pin.packages);
  vi.stubEnv("RATE_LIMIT_PRINCIPAL", "4");
  vi.stubEnv("RATE_LIMIT_IP", "8");
  vi.stubEnv("CHAIN_RPC_URL", "http://127.0.0.1:1");
  vi.stubEnv("CHAIN_ID", "31337");
  vi.stubEnv("CHAIN_CORE", "0x1111111111111111111111111111111111111111");
  vi.stubEnv("CHAIN_HOOK", "0x2222222222222222222222222222222222222222");
  vi.stubEnv("CHAIN_USDC", "0x3333333333333333333333333333333333333333");
  vi.stubEnv("DB_PATH", ":memory:");
}
