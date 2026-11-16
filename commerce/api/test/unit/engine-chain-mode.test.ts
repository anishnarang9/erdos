import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { createApp } from "../../src/app.ts";
import { cliEngine, simulatedEngine, type Engine } from "../../src/engine.ts";
import { readChain, requireChain, type ApiChain, type ChainReader } from "../../src/chain.ts";

const config = { chainId: 31337, core: "0x1111111111111111111111111111111111111111", hook: "0x2222222222222222222222222222222222222222", usdc: "0x3333333333333333333333333333333333333333" } as const;
const reader: ChainReader = {
  decodeLogs: () => [],
  getJob: async () => { throw new Error("not called"); },
  getTerms: async () => null,
  getSnapshot: async () => { throw new Error("not called"); },
};
const chain: ApiChain = { mode: "arc", config, publicClient: {} as PublicClient, reader };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), "api-mode-"));
  dirs.push(dir);
  return { dir, dbPath: join(dir, "must-not-exist.db") };
}

describe("engine/chain execution provenance", () => {
  it("factories explicitly identify real and simulated execution without invoking them", () => {
    expect(simulatedEngine().mode).toBe("simulated");
    expect(cliEngine({ bin: "/does-not-exist" }).mode).toBe("real");
  });

  it.each(["omitted", "simulated", "unidentified", "validatePlan fallback"])("rejects Arc + %s engine before database creation", (kind) => {
    const { dir, dbPath } = databasePath();
    const sim = simulatedEngine();
    const unidentified: Engine & { label: string } = { validate: sim.validate, compile: sim.compile, label: "native:REAL" };
    expect(() => createApp({ dbPath, buyerToken: "0123456789abcdef", chain,
      ...(kind === "simulated" ? { engine: sim } : {}),
      ...(kind === "unidentified" ? { engine: unidentified } : {}),
      ...(kind === "validatePlan fallback" ? { validatePlan: sim.validate } : {}),
    })).toThrow(/explicitly real engine/);
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects missing Arc reader rather than falling back to stub reads", () => {
    const bad = { ...chain, reader: undefined };
    expect(() => readChain(bad)).toThrow(/stub fallback is forbidden/);
    const { dir, dbPath } = databasePath();
    expect(() => createApp({ dbPath, buyerToken: "0123456789abcdef", chain: bad, engine: cliEngine({ bin: "unused" }) })).toThrow(/getSnapshot/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("allows an explicitly identified embedded real engine on Arc", () => {
    const app = createApp({ dbPath: ":memory:", buyerToken: "0123456789abcdef", chain, engine: { ...simulatedEngine(), mode: "real" } });
    app.close();
    expect(readChain(chain)).toBe(reader);
  });

  it("preserves explicitly simulated chain mode", () => {
    const app = createApp({ dbPath: ":memory:", buyerToken: "0123456789abcdef", chain: { ...chain, mode: "simulated", reader: undefined } });
    app.close();
  });

  it("rejects omitted chain mode in embedding and readChain, even with a real engine", () => {
    const bad = { ...chain, mode: undefined } as unknown as ApiChain;
    const { dir, dbPath } = databasePath();
    expect(() => createApp({ dbPath, buyerToken: "0123456789abcdef", chain: bad, engine: cliEngine({ bin: "unused" }) })).toThrow(/Explicit chain.mode/);
    expect(() => createApp({ dbPath, buyerToken: "0123456789abcdef", chain: bad, engine: simulatedEngine() })).toThrow(/Explicit chain.mode/);
    expect(() => readChain(bad)).toThrow(/Explicit chain.mode/);
    expect(() => requireChain({ chain: bad, engine: simulatedEngine() } as Parameters<typeof requireChain>[0])).toThrow(/Explicit chain.mode/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
