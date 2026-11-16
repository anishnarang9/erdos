// Explicit slow test. This is local Arc behavior, NOT live Arc settlement evidence.
// Prerequisites: build the engine, compile contracts/out with pinned Arc Foundry/solc 0.8.28,
// install r0vm 3.1.0, and load the digest-pinned Groth16 image documented in engine/README.md.
// Required: UBC26_ARC_ANVIL=<pinned-Arc-Foundry-executable>.
// Optional: UBC26_ENGINE_BIN (defaults to engine/target/debug/engine), UBC26_R0VM_BIN
// or RISC0_SERVER_PATH (otherwise r0vm on PATH), ENGINE_DOCKER (otherwise docker on PATH),
// UBC26_PYTHON_BIN (otherwise python3 on PATH), UBC26_SPRINT_SCRATCH (existing owned 0700 root).
// Run from commerce/worker: pnpm exec vitest run --config vitest.funded.config.ts
// Preflight tests only, without tools or proving: append -t 'portable funded preflight'.
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { delimiter, dirname, join, matchesGlob } from "node:path";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import {
  bytesToHex, encodeAbiParameters, encodeFunctionData, hexToBytes, sha256, zeroHash,
  type Hex,
} from "viem";
import { arcCoreAbi, arcHookAbi, arcErc20Abi, encodeJournal, extractRevertData, parseProofJson } from "@ubc26/sdk";
import { cliEngine, createApp, referenceDigestOf } from "@ubc26/api";
import { createApiArcChain, type FundingTerms } from "../../../api/src/chain.ts";
import { providerAuthHeaders, quoteBody } from "../../../api/test/unit/t7-t8-helpers.ts";
import { apiClient } from "../../src/client.ts";
import { engineRunner, type EngineRunner } from "../../src/engine.ts";
import { runFunded, type FundedState } from "../../src/funded.ts";
import { createArcSettlementPort } from "../../src/arc-port.ts";
import { verifyArcDeployment } from "../../src/arc-deployment.ts";
import { createLocalBroadcaster } from "../../src/local-broadcaster.ts";
import { createPosterFunding } from "../../src/poster-funding.ts";
import { recoverArcDeliveryDual } from "../../src/buyer-recovery.ts";
import { startRealChain, stopOwned, FEES } from "../support/real-chain.ts";
import * as chainSupport from "../support/real-chain.ts";
import engineSuite from "../../vitest.engine.config.ts";
import fundedSuite from "../../vitest.funded.config.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const INPUT = join(REPO, "docs/core-sprint-input");
const REPORT = join(REPO, "agents/anish/reports/core-sprint-local-2026-11-15.json");
const execute = promisify(execFile);
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? String(v) : v, 2) + "\n";

describe("portable funded preflight", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "funded-tool-config-"));
    chmodSync(root, 0o700);
    const env = {
      UBC26_ENGINE_BIN: process.execPath, UBC26_R0VM_BIN: process.execPath,
      UBC26_ARC_ANVIL: process.execPath, ENGINE_DOCKER: process.execPath,
      UBC26_PYTHON_BIN: process.execPath, UBC26_SPRINT_SCRATCH: root, PATH: "",
    };
    return { root, env, close: () => rmSync(root, { recursive: true, force: true }) };
  };
  it("keeps funded integration exclusive to its explicit suite", () => {
    const includes = (config: typeof engineSuite, file: string) =>
      config.test!.include!.some(pattern => matchesGlob(file, pattern)) &&
      !(config.test!.exclude ?? []).some(pattern => matchesGlob(file, pattern));
    expect(includes(engineSuite, "test/integration/funded-real.test.ts")).toBe(false);
    expect(includes(fundedSuite, "test/integration/funded-real.test.ts")).toBe(true);
    expect(includes(engineSuite, "test/integration/e2e-synthetic.test.ts")).toBe(true);
    expect(includes(engineSuite, "test/integration/e2e-grok.test.ts")).toBe(true);
  });
  for (const failure of ["setBalance", "artifact"] as const) {
    it(`stops only its owned child and closes its log after early ${failure} failure`, async () => {
      const f = fixture();
      let fd: number | undefined;
      const child = Object.assign(new EventEmitter(), {
        pid: 12345, exitCode: null as number | null, signalCode: null,
        kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); return true; }),
      });
      const spawnNode = vi.fn((_bin, _args, options) => {
        fd = options.stdio[1];
        writeSync(fd!, "Listening on 127.0.0.1\n");
        return child;
      });
      const request = vi.fn(async () => {
        if (failure === "setBalance") throw new Error("Injected early local balance failure");
        return null;
      });
      try {
        await expect(chainSupport.startRealChain(join(f.root, "missing-repository"), f.root, process.execPath, {
          spawnNode, makeClient: () => ({
            request, getChainId: async () => 5042002, getCode: async () => "0x00",
          }),
        } as any)).rejects.toThrow();
        expect(spawnNode).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(() => fstatSync(fd!)).toThrow();
      } finally {
        if (child.exitCode === null) child.kill();
        if (fd !== undefined) { try { closeSync(fd); } catch { /* Already closed by the helper. */ } }
        f.close();
      }
    });
  }
  it("uses explicit executable paths and canonical private scratch", () => {
    const f = fixture();
    try {
      const cfg = chainSupport.resolveFundedTools(REPO, f.env, "linux");
      expect(cfg.engineBin).toBeTruthy();
      expect(cfg.scratchRoot).toBeTruthy();
      expect(cfg.caffeinateBin).toBeUndefined();
    } finally { f.close(); }
  });
  it("requires an explicit Arc binary instead of ordinary anvil on PATH", () => {
    const f = fixture();
    try {
      expect(() => chainSupport.resolveFundedTools(REPO, { ...f.env, UBC26_ARC_ANVIL: "" }, "linux"))
        .toThrow("UBC26_ARC_ANVIL");
    } finally { f.close(); }
  });
  it("rejects missing executable files before any process starts", () => {
    const f = fixture();
    try {
      expect(() => chainSupport.resolveFundedTools(REPO, { ...f.env, ENGINE_DOCKER: join(f.root, "missing") }, "linux"))
        .toThrow("ENGINE_DOCKER");
    } finally { f.close(); }
  });
  it("rejects non-executable files and public persistent scratch", () => {
    const f = fixture();
    try {
      const file = join(f.root, "not-executable"); writeFileSync(file, "no\n", { mode: 0o600 });
      expect(() => chainSupport.resolveFundedTools(REPO, { ...f.env, UBC26_ENGINE_BIN: file }, "linux"))
        .toThrow("UBC26_ENGINE_BIN");
      chmodSync(f.root, 0o755);
      expect(() => chainSupport.resolveFundedTools(REPO, f.env, "linux")).toThrow("UBC26_SPRINT_SCRATCH");
    } finally { f.close(); }
  });
  it("resolves Docker from the actual supplied PATH without a shell", () => {
    const f = fixture();
    try {
      const docker = join(f.root, "docker");
      writeFileSync(docker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const cfg = chainSupport.resolveFundedTools(REPO, { ...f.env, ENGINE_DOCKER: "", PATH: f.root }, "linux");
      expect(cfg.dockerBin).toBe(realpathSync(docker));
    } finally { f.close(); }
  });
  it("accepts RISC0_SERVER_PATH when the test-specific r0vm setting is absent", () => {
    const f = fixture();
    try {
      const cfg = chainSupport.resolveFundedTools(REPO,
        { ...f.env, UBC26_R0VM_BIN: "", RISC0_SERVER_PATH: process.execPath }, "linux");
      expect(cfg.r0vmBin).toBeTruthy();
    } finally { f.close(); }
  });
  it("rejects a wrong Arc commit before any chain starts", async () => {
    const f = fixture();
    try {
      const cfg = chainSupport.resolveFundedTools(REPO, f.env, "linux");
      await expect(chainSupport.verifyFundedTools(cfg, async () => ({ stdout: "anvil ordinary build\n" })))
        .rejects.toThrow("Arc Foundry");
      await expect(chainSupport.verifyFundedTools(cfg, async () => ({
        stdout: `anvil\nCommit SHA: ${chainSupport.ARC_COMMIT}00\n`,
      }))).rejects.toThrow("Arc Foundry");
    } finally { f.close(); }
  });
  it("uses the repository engine default and canonical system scratch", () => {
    const f = fixture();
    try {
      const binDir = join(f.root, "engine/target/debug");
      mkdirSync(binDir, { recursive: true, mode: 0o700 });
      const engine = join(binDir, "engine"); writeFileSync(engine, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const cfg = chainSupport.resolveFundedTools(f.root,
        { ...f.env, UBC26_ENGINE_BIN: "", UBC26_SPRINT_SCRATCH: "" }, "linux");
      expect(cfg.engineBin).toBe(realpathSync(engine));
      expect(cfg.scratchRoot).toBe(realpathSync(tmpdir()));
    } finally { f.close(); }
  });
  it("uses optional macOS caffeinate only when the executable exists", () => {
    const f = fixture();
    try {
      expect(chainSupport.resolveFundedTools(REPO, f.env, "darwin").caffeinateBin).toBeUndefined();
      const file = join(f.root, "caffeinate"); writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const env = { ...f.env, PATH: f.root };
      expect(chainSupport.resolveFundedTools(REPO, env, "darwin").caffeinateBin).toBe(realpathSync(file));
      expect(chainSupport.resolveFundedTools(REPO, env, "linux").caffeinateBin).toBeUndefined();
    } finally { f.close(); }
  });
  it("ignores RPC, fork, and credential environment values", () => {
    const f = fixture();
    try {
      const cfg = chainSupport.resolveFundedTools(REPO, { ...f.env,
        RPC_URL: "https://invalid.example", FOUNDRY_ETH_RPC_URL: "https://invalid.example",
        PRIVATE_KEY: "must-not-read-this-value",
      }, "linux");
      expect(JSON.stringify(cfg)).not.toContain("invalid.example");
      expect(JSON.stringify(cfg)).not.toContain("must-not-read-this-value");
    } finally { f.close(); }
  });
  it("requires Arc network support and exact r0vm version, not only a commit string", async () => {
    const f = fixture();
    try {
      const cfg = chainSupport.resolveFundedTools(REPO, f.env, "linux");
      const version = `anvil\nCommit SHA: ${chainSupport.ARC_COMMIT}\n`;
      await expect(chainSupport.verifyFundedTools(cfg, async (_bin, args) => ({
        stdout: args[0] === "--version" ? version : "ordinary node help",
      }))).rejects.toThrow("Arc Foundry network support");
      let calls = 0;
      await expect(chainSupport.verifyFundedTools(cfg, async () => ({
        stdout: [version, "--network <NETWORK> possible values: ethereum, arc", "risc0-r0vm 3.0.0"][calls++]!,
      }))).rejects.toThrow("r0vm 3.1.0");
    } finally { f.close(); }
  });
  it("omits the missing-runner scaffold from new evidence and keeps older history", () => {
    const older = { status: "blocked-not-passed", tdd: { reason: "Missing real local integration runner" } };
    const previous = {
      status: "passed", proveMillis: 592426,
      tdd: { scaffold: "failed as expected", reason: "Missing real local integration runner" },
      attemptHistory: [older],
    };
    const source = { head: "a".repeat(40), files: [] as { path: string; sha256: string }[] };
    const evidence = chainSupport.nextAttemptEvidence(previous, source);
    expect(evidence).not.toHaveProperty("tdd");
    expect(evidence.status).toBe("running");
    expect(evidence.freshGroth16Proofs).toBe(0);
    expect(evidence.source).toEqual(source);
    expect(evidence.attemptHistory).toEqual([
      older,
      { status: "passed", proveMillis: 592426, tdd: previous.tdd },
    ]);
  });
  it("records observed r0vm and the exact Solidity version only after artifact validation", () => {
    const exact = "0.8.28+commit.7893614a";
    expect(chainSupport.observedToolPins(false, "risc0-r0vm 3.1.0", exact)).toBeUndefined();
    expect(chainSupport.observedToolPins(true, "risc0-r0vm 3.1.0", exact)).toEqual({
      r0vm: "risc0-r0vm 3.1.0", solc: exact,
    });
    expect(chainSupport.acceptedSolidityVersion(exact)).toBe(exact);
    for (const rejected of ["0.8.28", "0.8.280", "0.8.28-nightly", "0.8.29+commit.7893614a"]) {
      expect(() => chainSupport.acceptedSolidityVersion(rejected)).toThrow("Solidity");
    }
    expect(() => chainSupport.observedToolPins(true, "risc0-r0vm 3.0.0", exact)).toThrow("r0vm");
  });
  it("binds a later rehearsal to HEAD and the tested source bytes", () => {
    const stamp = chainSupport.rehearsalSource(REPO);
    const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(stamp.head).toBe(head);
    expect(stamp.files.map(file => file.path)).toEqual([
      "commerce/worker/test/integration/funded-real.test.ts",
      "commerce/worker/test/support/real-chain.ts",
      "commerce/worker/vitest.engine.config.ts",
      "commerce/worker/vitest.funded.config.ts",
    ]);
    for (const file of stamp.files) {
      expect(file.sha256).toBe(createHash("sha256").update(readFileSync(join(REPO, file.path))).digest("hex"));
    }
  });
  it("closes its log when spawn fails before a pid exists", async () => {
    const f = fixture();
    let fd: number | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: undefined as number | undefined, exitCode: null as number | null, signalCode: null,
      kill: vi.fn(),
    });
    const spawnNode = vi.fn((_bin: string, _args: string[], options: { stdio: number[] }) => {
      fd = options.stdio[1];
      process.nextTick(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
      return child;
    });
    try {
      await expect(chainSupport.startRealChain(join(f.root, "missing-repository"), f.root, join(f.root, "missing-anvil"), {
        spawnNode, makeClient: () => { throw new Error("client must not be constructed"); },
      } as never)).rejects.toThrow("Owned local Anvil startup failed");
      expect(child.kill).not.toHaveBeenCalled();
      expect(() => fstatSync(fd!)).toThrow();
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Already closed by the helper. */ } }
      f.close();
    }
  });
  it("does not signal an already exited child when startup fails", async () => {
    const f = fixture();
    let fd: number | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: 42, exitCode: 1 as number | null, signalCode: null,
      kill: vi.fn(),
    });
    const spawnNode = vi.fn((_bin: string, _args: string[], options: { stdio: number[] }) => {
      fd = options.stdio[1];
      return child;
    });
    try {
      await expect(chainSupport.startRealChain(join(f.root, "missing-repository"), f.root, process.execPath, {
        spawnNode, makeClient: () => { throw new Error("client must not be constructed"); },
      } as never)).rejects.toThrow("Owned local Anvil startup failed");
      expect(child.kill).not.toHaveBeenCalled();
      expect(() => fstatSync(fd!)).toThrow();
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Already closed by the helper. */ } }
      f.close();
    }
  });
  it("surfaces a kill failure and still closes its log", async () => {
    const f = fixture();
    let fd: number | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: 9, exitCode: null as number | null, signalCode: null,
      kill: () => { throw new Error("kill failed"); },
    });
    const spawnNode = vi.fn((_bin: string, _args: string[], options: { stdio: number[] }) => {
      fd = options.stdio[1];
      writeSync(fd!, "Listening on 127.0.0.1\n");
      return child;
    });
    try {
      await expect(chainSupport.startRealChain(join(f.root, "missing-repository"), f.root, process.execPath, {
        spawnNode, makeClient: () => { throw new Error("setup failed after listen"); },
      } as never)).rejects.toThrow("kill failed");
      expect(() => fstatSync(fd!)).toThrow();
    } finally {
      if (child.exitCode === null) { try { child.kill(); } catch { /* Kill is the injected failure. */ } }
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Already closed by the helper. */ } }
      f.close();
    }
  });
  it("drops the kill timer when the initial signal throws", async () => {
    vi.useFakeTimers();
    const leaks: unknown[] = [];
    const onRejection = (error: unknown) => { leaks.push(error); };
    const onException = (error: unknown) => { leaks.push(error); };
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
    try {
      const kill = vi.fn(() => { throw new Error("kill failed"); });
      const child = Object.assign(new EventEmitter(), {
        pid: 9, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        kill,
      });
      await expect(stopOwned(child as never)).rejects.toThrow("kill failed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(leaks).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
      vi.useRealTimers();
    }
  });
  it("rejects a SIGKILL callback error without claiming the child exited", async () => {
    vi.useFakeTimers();
    const leaks: unknown[] = [];
    const onRejection = (error: unknown) => { leaks.push(error); };
    const onException = (error: unknown) => { leaks.push(error); };
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
    try {
      const kill = vi.fn((signal?: NodeJS.Signals) => {
        if (signal === "SIGKILL") throw new Error("sigkill failed");
        return true;
      });
      const child = Object.assign(new EventEmitter(), {
        pid: 11, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        kill,
      });
      const captured: unknown[] = [];
      const pending = stopOwned(child as never).then(
        () => { captured.push("resolved"); },
        (error: unknown) => { captured.push(error); },
      );
      await Promise.resolve();
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(captured).toEqual([]);
      let timerLeak: unknown;
      try { await vi.advanceTimersByTimeAsync(5_000); } catch (error) { timerLeak = error; }
      await Promise.resolve();
      expect(timerLeak).toBeUndefined();
      expect(leaks).toEqual([]);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBeInstanceOf(Error);
      expect((captured[0] as Error).message).toBe("sigkill failed");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.listenerCount("exit")).toBe(0);
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
      vi.useRealTimers();
    }
  });
  it("returns immediately for a real child that has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
    const kill = vi.spyOn(child, "kill");
    const started = Date.now();
    await stopOwned(child);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(kill).not.toHaveBeenCalled();
    expect(child.exitCode).toBe(0);
    kill.mockRestore();
  }, 8_000);
  it("does not lose a real child exit that is already in flight", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const started = Date.now();
    await stopOwned(child);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 8_000);
  it("stops a live child only after the exit event, not on the kill timer", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      let text = "";
      child.stdout?.on("data", (chunk: Buffer) => { text += chunk; if (text.includes("ready")) resolve(); });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("child exited before ready")));
    });
    const started = Date.now();
    await stopOwned(child);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  }, 8_000);
  it("does not treat the SIGKILL timer as proof the child exited", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 7, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
      });
      let settled = false;
      const pending = stopOwned(child as never).then(() => { settled = true; });
      await Promise.resolve();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(settled).toBe(false);
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      await pending;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

it("fresh real-context funded local integration", async () => {
  process.umask(0o077);
  // Validate every executable and storage setting before starting any child.
  const configTools = chainSupport.resolveFundedTools(REPO);
  const { anvilVersion, r0vmVersion } = await chainSupport.verifyFundedTools(configTools);
  const root = mkdtempSync(join(configTools.scratchRoot, "core-sprint-local-"));
  chmodSync(root, 0o700);
  const privateWrite = (name: string, value: string) => writeFileSync(join(root, name), value, { mode: 0o600 });
  const directory = (name: string) => { const p = join(root, name); mkdirSync(p, { mode: 0o700 }); return p; };
  const errors = vi.spyOn(console, "error").mockImplementation((...args) => {
    privateWrite(`console-${randomUUID()}.log`, inspect(args, { depth: 12 }));
  });
  let stage = "preflight";
  const previous = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, "utf8")) as Record<string, unknown> : undefined;
  const evidence: Record<string, unknown> = chainSupport.nextAttemptEvidence(previous, chainSupport.rehearsalSource(REPO));
  const checkpoint = (next: string, fields: Record<string, unknown> = {}) => {
    stage = next;
    Object.assign(evidence, fields, { stage });
    writeFileSync(REPORT, json(evidence), { mode: 0o644 });
    privateWrite("stage.json", json({ stage, at: new Date().toISOString() }));
  };
  let chain: Awaited<ReturnType<typeof startRealChain>> | undefined;
  let server: ServerType | undefined;
  let closeApp: (() => void) | undefined;
  let funding: Awaited<ReturnType<typeof createPosterFunding>> | undefined;
  let broadcaster: Awaited<ReturnType<typeof createLocalBroadcaster>> | undefined;
  let proofCompleted = false;
  let allChecksCompleted = false;
  const caffeinate = configTools.caffeinateBin
    ? spawn(configTools.caffeinateBin, ["-i", "-w", String(process.pid)],
      { stdio: "ignore", env: { PATH: dirname(configTools.caffeinateBin) } })
    : undefined;
  const oldEnv = { PATH: process.env.PATH, ENGINE_DOCKER: process.env.ENGINE_DOCKER,
    RISC0_R0VM_PATH: process.env.RISC0_R0VM_PATH, RISC0_SERVER_PATH: process.env.RISC0_SERVER_PATH,
    DOCKER_DEFAULT_PLATFORM: process.env.DOCKER_DEFAULT_PLATFORM };
  try {
    checkpoint("tool-preflight");
    const tools = directory("tools");
    copyFileSync(join(REPO, "engine/tests/low-memory-docker.sh"), join(tools, "docker"));
    chmodSync(join(tools, "docker"), 0o700);
    process.env.ENGINE_DOCKER = configTools.dockerBin;
    process.env.PATH = [tools, dirname(configTools.r0vmBin), oldEnv.PATH ?? ""].join(delimiter);
    process.env.RISC0_R0VM_PATH = configTools.r0vmBin;
    process.env.RISC0_SERVER_PATH = configTools.r0vmBin;
    process.env.DOCKER_DEFAULT_PLATFORM = "linux/amd64";
    // Trusted fixed launcher tees all engine diagnostics into this run's private directory.
    const launcher = join(root, "engine-launcher.cjs");
    privateWrite("engine-launcher.cjs", `
const fs = require("node:fs"), cp = require("node:child_process");
const name = process.argv[2], args = process.argv.slice(2);
const base = ${JSON.stringify(root)};
const id = require("node:crypto").randomUUID();
const out = fs.openSync(base + "/engine-" + name + "-" + id + ".stdout", "wx", 0o600);
const err = fs.openSync(base + "/engine-" + name + "-" + id + ".stderr", "wx", 0o600);
const child = cp.spawn(${JSON.stringify(configTools.engineBin)}, args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", b => { fs.writeSync(out, b); process.stdout.write(b); });
child.stderr.on("data", b => { fs.writeSync(err, b); process.stderr.write(b); });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", code => { fs.closeSync(out); fs.closeSync(err); process.exit(code ?? 1); });
`);
    const bin = { command: process.execPath, args: [launcher] };
    const engine = cliEngine({ bin, workDir: directory("engine-work"), compileTimeoutMs: 1_800_000 });
    const originalRunner = engineRunner(bin, p => p);
    let proveCalls = 0;
    const runner: EngineRunner = {
      path: originalRunner.path,
      run: async (args, timeout) => {
        if (args[0] === "prove") {
          if (++proveCalls !== 1) throw new Error("Unexpected duplicate proving within one funded attempt");
          checkpoint("fresh-groth16-proving");
        }
        return originalRunner.run(args, timeout);
      },
    };
    const sleepPrevention = caffeinate ? "owned macOS caffeinate" : "Operator must prevent sleep outside this suite";
    checkpoint("deploy-local-actual-contracts", { tools: { anvilVersion, sleepPrevention } });
    chain = await startRealChain(REPO, root, configTools.arcAnvil);
    const pins = chainSupport.observedToolPins(true, r0vmVersion, chain.solidityVersion);
    if (!pins) throw new Error("Artifact pins missing after validation");
    checkpoint("artifact-pins", { tools: { anvilVersion, r0vm: pins.r0vm, solc: pins.solc, sleepPrevention } });
    const { pub, signerPublic, buyer, provider, addresses, policy, rawSend } = chain;
    await verifyArcDeployment(pub, addresses, policy, await pub.getBlockNumber({ cacheTime: 0 }));
    await chain.dump();
    checkpoint("real-api-create", {
      deployment: { ...addresses, verifier: policy.verifier, implementation: policy.implementation,
        deploymentBlock: policy.deploymentBlock, runtimeHashes: policy.runtimeHashes,
        setupReceipts: chain.setupReceipts.map(r => ({ hash: r.transactionHash, block: r.blockNumber,
          blockHash: r.blockHash, status: r.status, gasUsed: r.gasUsed })) },
      identities: { buyer: buyer.address, provider: provider.address, type: "fresh synthetic LOCAL test accounts" },
      tokenBehavior: "Forkless Arc Anvil native USDC predeploy 0x3600...; anvil_setBalance seeds synthetic native funds. No mock ERC20.",
    });
    const token = randomUUID() + randomUUID();
    const packagesDir = directory("packages");
    const app = createApp({
      dbPath: join(directory("db"), "api.sqlite"), buyerToken: token, engine, packagesDir,
      chain: createApiArcChain(addresses, pub),
    });
    closeApp = app.close;
    let base = "";
    await new Promise<void>(resolve => {
      server = serve({ fetch: app.app.fetch, port: 0, hostname: "127.0.0.1" }, info => {
        base = `http://127.0.0.1:${info.port}`; resolve();
      });
    });
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}, status = 200) => {
      const res = await fetch(base + path, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
          "idempotency-key": randomUUID(), ...headers }, body: JSON.stringify(body),
      });
      const value = await res.json() as any;
      privateWrite(`api-${randomUUID()}.json`, json({ path, status: res.status, body: value }));
      if (res.status !== status) throw new Error(`API status mismatch at ${path}: ${res.status}`);
      return value;
    };
    const reference = [{ name: "catalog.json", content: new Uint8Array(readFileSync(join(INPUT, "reference/catalog.json"))) }];
    const expectedOutputs = readdirSync(join(INPUT, "candidates/valid")).sort().map(name => ({
      name, content: new Uint8Array(readFileSync(join(INPUT, "candidates/valid", name))),
    }));
    const revision = {
      plan: JSON.parse(readFileSync(join(INPUT, "plan.json"), "utf8")),
      referenceDigest: referenceDigestOf(reference),
      outputs: expectedOutputs.map(f => ({ name: f.name, format: "json" })),
      expirySeconds: 3600, maxBudget: "1000000",
    };
    const created = await post("/v1/jobs", { revision, source: "import",
      references: reference.map(f => ({ name: f.name, contentBase64: Buffer.from(f.content).toString("base64") })) }, {}, 201);
    const jobId = created.jobId as string;
    const revisionHash = created.revision.revisionHash as Hex;
    await post(`/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest: revision.referenceDigest }, { "if-match": revisionHash });
    checkpoint("real-api-compile");
    const compiled = await post(`/v1/jobs/${jobId}/compile`, { revisionHash });
    checkpoint("real-api-quote-select", { apiJobId: jobId, revisionHash, manifest: compiled.manifest });
    const qb = await quoteBody(provider, 5042002, { revisionHash }, Date.now());
    const quotePath = `/v1/jobs/${jobId}/quotes`;
    const quote = await post(quotePath, qb, await providerAuthHeaders(provider, {
      method: "POST", pathWithQuery: quotePath, body: JSON.stringify(qb), nowMs: Date.now(),
    }), 201);
    const selected = await post(`/v1/jobs/${jobId}/select-quote`, { quoteId: quote.quoteId, revisionHash });
    const terms = selected.fundingTerms as FundingTerms;
    checkpoint("poster-funding-real-receipts", { selectedTerms: terms });
    funding = await createPosterFunding({
      terms, buyer: buyer.address, apiJobId: jobId, revisionHash, account: buyer, public: signerPublic, rawSend,
      journalRoot: directory("poster-journal"), maxGas: 1_500_000n, ...FEES,
      nativeGasBudget: 1n * 10n ** 18n, operationalReserveSeconds: 1080n, hookMarginSeconds: 120n,
      link: async value => {
        const linked = await post(`/v1/jobs/${jobId}/funding-receipt`, { txHash: value.fundTxHash });
        privateWrite("linked-api.json", json(linked));
      },
    });
    const funded = await funding.run();
    await funding.close();
    expect(funded.remainingAllowance).toBe(0n);
    const id = funded.jobId, expiry = BigInt(terms.expiredAt);
    privateWrite("continuation-context.private.json", json({
      root, api: { jobId, revisionHash, token, packagesDir, dbPath: join(root, "db/api.sqlite") },
      addresses, policy, terms, funded,
    }));
    const fundReceipt = await pub.getTransactionReceipt({ hash: funded.fundTxHash });
    checkpoint("fresh-funded-context", { funding: { jobId: id, fundTx: funded.fundTxHash,
      block: fundReceipt.blockNumber, blockHash: fundReceipt.blockHash, status: fundReceipt.status, remainingAllowance: "0" } });
    const config = { ...addresses, self: provider.address, maxGas: 2_000_000n, ...FEES,
      submitGas: 1_500_000n, releaseGas: 500_000n, releaseMarginSec: 120, submitBudgetSec: 60, deploymentPolicy: policy };
    const readonlyPort = createArcSettlementPort(config, { public: pub });
    const client = apiClient(base);
    const options = {
      client, runner, port: readonlyPort, jobId, chainJobId: id,
      solver: { name: "synthetic-known-feasible-candidate", solve: async () => expectedOutputs },
      attemptDir: join(root, "provider-attempt"), proveBudgetSec: 900, releaseMarginSec: 120, submitBudgetSec: 60,
    };
    const proved = await runFunded({ ...options, stopAfterProof: true });
    proofCompleted = true;
    expect(proved.phase).toBe("proved");
    expect(proved.verdict).toBe(1);
    const proof = parseProofJson(readFileSync(join(options.attemptDir, "attempt/proof.json"), "utf8"));
    const key = readFileSync(join(options.attemptDir, "attempt/release-key.hex"), "utf8").trim() as Hex;
    expect(proveCalls).toBe(1);
    checkpoint("local-proof-negative-calls", { freshGroth16Proofs: 1, proof: {
      context: bytesToHex(proof.contextBytes), imageId: proof.imageId, envelopeHash: proof.envelopeHash,
      keyCommitment: proof.keyCommitment, journalDigest: proof.journalDigest, sealBytes: (proof.seal.length - 2) / 2,
      proveMillis: proved.proveMillis, userCycles: proved.userCycles,
    } });
    await chain.dump();
    // Independent actual EVM calls. No release key is ever simulated or estimated.
    const negatives: Record<string, string> = {};
    const rejected = async (name: string, to: Hex, data: Hex) => {
      let reverted = false;
      try { await pub.call({ to, data, account: provider.address, gas: 2_000_000n }); }
      catch (error) {
        privateWrite(`negative-${name}.log`, inspect(error, { depth: 8 }));
        const data = extractRevertData(error);
        expect(data, `${name}: actual EVM revert data required`).toMatch(/^0x[0-9a-fA-F]{8}/);
        reverted = true;
      }
      expect(reverted, name).toBe(true);
      negatives[name] = "actual forkless local eth_call reverted; no transaction";
    };
    const submitData = (envelope: Hex, seal: Hex, job = id) => encodeFunctionData({
      abi: arcCoreAbi, functionName: "submit", args: [job, sha256(envelope), encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [envelope, seal, proof.keyCommitment])],
    });
    const envelope = bytesToHex(proof.envelope);
    const changedEnvelope = hexToBytes(envelope); changedEnvelope[12] = changedEnvelope[12]! ^ 1;
    await rejected("changed-ciphertext", addresses.core, submitData(bytesToHex(changedEnvelope), proof.seal));
    const changedSeal = hexToBytes(proof.seal); changedSeal[20] = changedSeal[20]! ^ 1;
    await rejected("changed-seal", addresses.core, submitData(envelope, bytesToHex(changedSeal)));
    const verifierAbi = [{ type: "function", name: "verify", stateMutability: "view", inputs: [
      { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }], outputs: [] }] as const;
    await rejected("changed-image", policy.verifier, encodeFunctionData({
      abi: verifierAbi, functionName: "verify", args: [proof.seal, zeroHash, proof.journalDigest],
    }));
    const falseJournal = encodeJournal({ context: proof.context, verdict: 0, envelopeHash: proof.envelopeHash, keyCommitment: proof.keyCommitment });
    await rejected("verdict-journal-mutation-not-fresh-failing-proof", policy.verifier, encodeFunctionData({
      abi: verifierAbi, functionName: "verify", args: [proof.seal, proof.imageId, sha256(falseJournal)],
    }));
    // Create a second actual funded job for cross-job replay/refund without generating another proof.
    let refundId = 0n;
    const replayFunding = await createPosterFunding({
      terms: { ...terms, description: terms.description + "-local-refund" }, buyer: buyer.address,
      apiJobId: jobId + "-local-refund", revisionHash, account: buyer, public: signerPublic, rawSend,
      journalRoot: join(root, "poster-journal"), maxGas: 1_500_000n, ...FEES,
      nativeGasBudget: 1n * 10n ** 18n, operationalReserveSeconds: 180n, hookMarginSeconds: 120n,
      // This independent contract-only negative job intentionally has no API listing.
      link: async value => { refundId = value.jobId; },
    });
    const refundJob = await replayFunding.run();
    await replayFunding.close();
    expect(refundId).toBe(refundJob.jobId);
    privateWrite("refund-job.private.json", json(refundJob));
    await rejected("cross-job-replay", addresses.core, submitData(envelope, proof.seal, refundId));
    expect((await readonlyPort.snapshot(id)).job.status).toBe("Funded");
    checkpoint("provider-exact-authorization", { negatives });
    broadcaster = await createLocalBroadcaster({
      account: provider, provider: provider.address, ...addresses, jobId: id, expiresAt: expiry,
      submitDeadline: expiry - 180n, releaseDeadline: expiry - 60n, validUntil: expiry - 30n,
      maxGas: 2_000_000n, releaseGas: 500_000n, ...FEES, totalBudget: 1n * 10n ** 18n,
      journalRoot: directory("provider-journal"), public: signerPublic, rawSend,
      authorizations: [
        { kind: "submit", jobId: id, envelope, envelopeHash: proof.envelopeHash, seal: proof.seal, keyCommitment: proof.keyCommitment },
        { kind: "release", jobId: id, key, context: proof.contextBytes, keyCommitment: proof.keyCommitment },
      ],
    });
    const port = createArcSettlementPort({ ...config, allowBroadcast: true }, { public: pub, broadcaster });
    // Intercept only the observation. The transaction is real and auto-mined. This tests a lost
    // receipt response after a durable hash, NOT an actually pending mempool transaction.
    let hidden = false;
    const delayedReceiptPort = { ...port, receipt: async (hash: Hex) => {
      if (!hidden) { hidden = true; return null; }
      return port.receipt(hash);
    } };
    checkpoint("submit-real-interruption");
    const interrupted = await runFunded({ ...options, port: delayedReceiptPort });
    expect(interrupted.phase).toBe("submit_sent");
    expect(interrupted.submitTx).toMatch(/^0x[0-9a-f]{64}$/);
    const durable = JSON.parse(readFileSync(join(options.attemptDir, "state.json"), "utf8")) as FundedState;
    expect(durable.submitTx).toBe(interrupted.submitTx);
    expect(durable.releaseTx).toBeUndefined();
    const observedSubmitReceipt = await pub.getTransactionReceipt({ hash: interrupted.submitTx! });
    privateWrite("submit-receipt.private.json", json(observedSubmitReceipt));
    await chain.dump();
    const providerNonce = await pub.getTransactionCount({ address: provider.address, blockTag: "pending" });
    await rejected("wrong-dummy-key-before-release", addresses.hook, encodeFunctionData({
      abi: arcHookAbi, functionName: "release", args: [id, zeroHash],
    }));
    // runFunded confirms lifecycle receipts, but it does not reconcile the separate
    // broadcaster's durable budget/nonce journal. Do that before its next write.
    expect((await broadcaster.reconcile(interrupted.submitTx!)).status).toBe("success");
    checkpoint("resume-release-real");
    const settled = await runFunded({ ...options, port });
    expect(settled.phase).toBe("released");
    expect(settled.paymentConfirmed).toBe(true);
    expect(settled.submitTx).toBe(interrupted.submitTx);
    expect(await pub.getTransactionCount({ address: provider.address, blockTag: "pending" })).toBe(providerNonce + 1);
    await broadcaster.reconcile(settled.submitTx!);
    await broadcaster.reconcile(settled.releaseTx!);
    const observedReleaseReceipt = await pub.getTransactionReceipt({ hash: settled.releaseTx! });
    privateWrite("release-receipt.private.json", json(observedReleaseReceipt));
    checkpoint("release-confirmed", {
      submitReceipt: { hash: observedSubmitReceipt.transactionHash, block: observedSubmitReceipt.blockNumber,
        blockHash: observedSubmitReceipt.blockHash, status: observedSubmitReceipt.status, gasUsed: observedSubmitReceipt.gasUsed },
      releaseReceipt: { hash: observedReleaseReceipt.transactionHash, block: observedReleaseReceipt.blockNumber,
        blockHash: observedReleaseReceipt.blockHash, status: observedReleaseReceipt.status, gasUsed: observedReleaseReceipt.gasUsed },
    });
    await chain.dump();
    checkpoint("buyer-independent-dual-recovery");
    const recovered = await recoverArcDeliveryDual(pub, {
      ...addresses, jobId: id, provider: provider.address, budget: 1_000_000n, expiry,
      imageId: proof.imageId, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash,
      submitTx: settled.submitTx!, releaseTx: settled.releaseTx!, expectedOutputs, deploymentPolicy: policy,
    }, { runner, directory: join(root, "buyer-recovery") });
    expect(recovered.evidence.engineDecryptMatches).toBe(true);
    const oracle = await execute(configTools.pythonBin, ["-B", join(INPUT, "oracle.py"), recovered.engineDirectory],
      { cwd: root, timeout: 30_000, env: { PATH: dirname(configTools.pythonBin) } });
    privateWrite("oracle.json", oracle.stdout);
    expect(JSON.parse(oracle.stdout).accepted).toBe(true);
    for (const file of expectedOutputs) {
      expect(readFileSync(join(recovered.engineDirectory, file.name))).toEqual(Buffer.from(file.content));
      expect(readFileSync(join(recovered.sdkDirectory, file.name))).toEqual(Buffer.from(file.content));
    }
    // After release, use a dummy key again. Never send the real key to an estimator/simulator.
    await rejected("duplicate-release-dummy-key", addresses.hook, encodeFunctionData({
      abi: arcHookAbi, functionName: "release", args: [id, zeroHash],
    }));
    await rejected("duplicate-submit", addresses.core, submitData(envelope, proof.seal));
    checkpoint("actual-local-expiry-refund");
    await chain.request({ method: "evm_setNextBlockTimestamp", params: [Number(expiry)] });
    await chain.request({ method: "evm_mine", params: [] });
    const balance = () => pub.readContract({ address: addresses.usdc, abi: arcErc20Abi,
      functionName: "balanceOf", args: [buyer.address] });
    const beforeRefund = await balance();
    const refund = await chain.send(chain.admin, addresses.core, encodeFunctionData({
      abi: arcCoreAbi, functionName: "claimRefund", args: [refundId],
    }), 500_000n);
    expect(await balance()).toBe(beforeRefund + 1_000_000n);
    await rejected("duplicate-refund", addresses.core, encodeFunctionData({
      abi: arcCoreAbi, functionName: "claimRefund", args: [refundId],
    }));
    const submitReceipt = await pub.getTransactionReceipt({ hash: settled.submitTx! });
    const releaseReceipt = await pub.getTransactionReceipt({ hash: settled.releaseTx! });
    expect(proveCalls).toBe(1);
    checkpoint("complete", {
      status: "passed", negatives, recovery: recovered.evidence, oracle: JSON.parse(oracle.stdout),
      exactRecoveredFiles: expectedOutputs.map(f => ({ name: f.name, bytes: f.content.length,
        sha256: createHash("sha256").update(f.content).digest("hex") })),
      settlementReceipts: [submitReceipt, releaseReceipt].map(r => ({
        hash: r.transactionHash, block: r.blockNumber, blockHash: r.blockHash, status: r.status, gasUsed: r.gasUsed,
      })),
      restart: { type: "real auto-mined submit; one receipt observation suppressed",
        durableHash: settled.submitTx, resumedSameHash: true, duplicateSubmits: 0, additionalProviderTransactions: 1 },
      refund: { type: "actual independent Funded job expiry refund; no proof for refund job",
        jobId: refundId, hash: refund.transactionHash, block: refund.blockNumber, amount: "1000000" },
      notClaimed: ["Live Arc settlement", "Live Grok", "Fresh failing-verdict proof",
        "Actually pending mempool interruption", "Submitted-state refund"],
    });
    // A public report must never contain any release key, private account key, or raw signed data.
    expect(readFileSync(REPORT, "utf8")).not.toContain(key.slice(2));
    await chain.dump();
    allChecksCompleted = true;
  } catch (error) {
    privateWrite("failure.private.log", inspect(error, { depth: 20 }));
    Object.assign(evidence, { status: "failed", stage });
    if (proofCompleted && chain) {
      try { await chain.dump(); } catch (dumpError) {
        privateWrite("dump-failure.private.log", inspect(dumpError, { depth: 8 }));
      }
      evidence.ownedLocalNodeRetainedForDebug = true;
    }
    writeFileSync(REPORT, json(evidence), { mode: 0o644 });
    throw new Error(`Local funded integration failed at stage: ${stage}. Diagnostics remain private.`);
  } finally {
    await broadcaster?.close();
    await funding?.close();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    closeApp?.();
    if (proofCompleted && !allChecksCompleted) chain?.retainForDebug();
    else await chain?.close();
    if (caffeinate) await stopOwned(caffeinate);
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    errors.mockRestore();
  }
});
