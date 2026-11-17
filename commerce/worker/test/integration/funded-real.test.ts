// Explicit slow test. This is local Arc behavior, NOT live Arc settlement evidence.
// Prerequisites: build the engine, compile contracts/out with pinned Arc Foundry/solc 0.8.28,
// install r0vm 3.1.0, and load the digest-pinned Groth16 image documented in engine/README.md.
// Required: UBC26_ARC_ANVIL=<pinned-Arc-Foundry-executable>.
// Optional: UBC26_ENGINE_BIN (defaults to engine/target/debug/engine), UBC26_R0VM_BIN
// or RISC0_SERVER_PATH (otherwise r0vm on PATH), ENGINE_DOCKER (otherwise docker on PATH),
// UBC26_PYTHON_BIN (otherwise python3 on PATH), UBC26_SPRINT_SCRATCH (existing owned 0700 root).
// Optional workload: UBC26_FUNDED_WORKLOAD=legacy|meridian. Unset means legacy.
//   legacy: docs/core-sprint-input, report agents/anish/reports/core-sprint-local-2026-11-15.json
//   meridian: docs/fresh-exchange-input, report agents/anish/reports/fresh-exchange-local-2026-11-15.json
// Paths, RPC URLs, wallets, and fork endpoints are not selectors. The suite replays candidates/valid.
// It does not call Grok or run an autonomous solver.
// Local allowances only: legacy prove budget 900 seconds and expiry 3600; Meridian 1800 and 7200.
// Those values do not change production signing or expiry caps and are not a Groth16 SLA.
// Run from commerce/worker: pnpm exec vitest run --config vitest.funded.config.ts
// Meridian: UBC26_FUNDED_WORKLOAD=meridian plus the same required Arc binary.
// Preflight tests only, without tools or proving: append -t 'portable funded preflight'.
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { delimiter, dirname, join, matchesGlob } from "node:path";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import {
  bytesToHex, createPublicClient, custom, decodeErrorResult, decodeEventLog, encodeAbiParameters,
  encodeFunctionData, hexToBytes, sha256, toHex, zeroHash,
  type Abi, type Hex,
} from "viem";
import { arcCoreAbi, arcHookAbi, arcErc20Abi, encodeJournal, extractRevertData, parseProofJson } from "@ubc26/sdk";
import { cliEngine, createApp, createIndexer, referenceDigestOf } from "@ubc26/api";
import { createApiArcChain, type FundingTerms } from "../../../api/src/chain.ts";
import { openDb } from "../../../api/src/db.ts";
import { providerAuthHeaders, quoteBody } from "../../../api/test/unit/t7-t8-helpers.ts";
import { apiClient } from "../../src/client.ts";
import { engineRunner, type EngineRunner } from "../../src/engine.ts";
import { runFunded, type FundedState } from "../../src/funded.ts";
import { WorkerCheckError } from "../../src/run.ts";
import { createArcSettlementPort } from "../../src/arc-port.ts";
import { verifyArcDeployment } from "../../src/arc-deployment.ts";
import { createLocalBroadcaster } from "../../src/local-broadcaster.ts";
import { createPosterFunding } from "../../src/poster-funding.ts";
import { recoverArcDeliveryDual } from "../../src/buyer-recovery.ts";
import { startRealChain, stopOwned, FEES } from "../support/real-chain.ts";
import * as chainSupport from "../support/real-chain.ts";
import {
  assertAllowedProvenanceKey, fundedWorkloadEvidence, loadFundedWorkload, loadWorkloadDirectory,
  localPendingRestartEvidence, MERIDIAN_GUEST_EXECUTIONS, preservedReportRels, rehearsalStampFiles,
  rehearsalStampRoles, selectFundedWorkload, submittedSnapshotRefundEvidence, suiteAuthoringLabel,
  wellFormedInvalidDeliverable,
} from "../support/funded-workload.ts";
import engineSuite from "../../vitest.engine.config.ts";
import fundedSuite from "../../vitest.funded.config.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
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

  const onlyWorkload = (value?: string): NodeJS.ProcessEnv => {
    const source: NodeJS.ProcessEnv = {};
    if (value !== undefined) source.UBC26_FUNDED_WORKLOAD = value;
    return new Proxy(source, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop !== "UBC26_FUNDED_WORKLOAD") {
          throw new Error(`unexpected env read ${prop}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const manifestHash = (root: string, paths: string[]) => {
    const lines = paths.map(path => `${path}\t${fileHash(join(root, path))}`).sort();
    return createHash("sha256").update(lines.map(line => `${line}\n`).join("")).digest("hex");
  };

  it("defaults to the legacy workload and rejects every other selection", () => {
    expect(selectFundedWorkload(onlyWorkload())).toBe("legacy");
    expect(selectFundedWorkload(onlyWorkload("legacy"))).toBe("legacy");
    expect(selectFundedWorkload(onlyWorkload("meridian"))).toBe("meridian");
    for (const rejected of ["", "Legacy", "MERIDIAN", "fresh", "core-sprint", "meridian/oracle.py",
      "docs/fresh-exchange-input", "../docs/core-sprint-input", "/tmp/secret-workload",
      "C:\\docs\\fresh-exchange-input"]) {
      expect(() => selectFundedWorkload({ UBC26_FUNDED_WORKLOAD: rejected }), rejected).toThrow(/UBC26_FUNDED_WORKLOAD/);
      try {
        selectFundedWorkload({ UBC26_FUNDED_WORKLOAD: rejected });
      } catch (error) {
        if (rejected !== "") expect(String(error)).not.toContain(rejected);
      }
    }
  });

  it("does not read RPC, wallet, or fork settings while selecting a workload", () => {
    const env = onlyWorkload("meridian");
    Object.assign(env, {
      RPC_URL: "https://invalid.example", PRIVATE_KEY: "must-not-read-this-value",
      FOUNDRY_ETH_RPC_URL: "https://fork.example",
    });
    expect(selectFundedWorkload(env)).toBe("meridian");
  });

  it("loads plan-declared references and requires candidates to match deliverables", () => {
    const root = mkdtempSync(join(tmpdir(), "funded-workload-"));
    chmodSync(root, 0o700);
    const write = (rel: string, value: string) => {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, value, { mode: 0o600 });
    };
    const plan = {
      version: 1,
      references: [
        { name: "b.json", parser: "json/v1" },
        { name: "a.json", parser: "json/v1" },
      ],
      deliverables: [
        { name: "second.json", parser: "json/v1" },
        { name: "notes.txt", parser: "text/v1" },
      ],
      rules: [],
    };
    try {
      write("plan.json", JSON.stringify(plan));
      write("request.md", "synthetic request\n");
      const matchingOutputs = {
        files: [
          { name: "second.json", parser: "json/v1" },
          { name: "notes.txt", parser: "text/v1" },
        ],
      };
      write("outputs.json", JSON.stringify(matchingOutputs));
      write("reference/b.json", "{\"n\":2}\n");
      write("reference/a.json", "{\"n\":1}\n");
      write("candidates/valid/second.json", "{\"ok\":true}\n");
      write("candidates/valid/notes.txt", "notes\n");
      const loaded = loadWorkloadDirectory(root);
      expect(loaded.references.map(file => file.name)).toEqual(["b.json", "a.json"]);
      expect(loaded.outputs.map(file => ({ name: file.name, parser: file.parser, format: file.format })))
        .toEqual([
          { name: "second.json", parser: "json/v1", format: "json" },
          { name: "notes.txt", parser: "text/v1", format: "text" },
        ]);
      expect(Buffer.from(loaded.references[0]!.content)).toEqual(readFileSync(join(root, "reference/b.json")));
      expect(loaded.hashes.plan).toBe(fileHash(join(root, "plan.json")));
      expect(loaded.hashes.dataset).toEqual({
        "b.json": fileHash(join(root, "reference/b.json")),
        "a.json": fileHash(join(root, "reference/a.json")),
      });
      expect(Object.keys(loaded.hashes.dataset)).toEqual(["b.json", "a.json"]);
      expect(loaded.hashes.candidates).toEqual({
        "second.json": fileHash(join(root, "candidates/valid/second.json")),
        "notes.txt": fileHash(join(root, "candidates/valid/notes.txt")),
      });
      expect(loaded.hashes.input).toBe(manifestHash(root, [
        "plan.json", "request.md", "outputs.json", "reference/b.json", "reference/a.json",
        "candidates/valid/second.json", "candidates/valid/notes.txt",
      ]));
      write("outputs.json", JSON.stringify({ files: [
        { name: "other.json", parser: "json/v1" },
        { name: "notes.txt", parser: "text/v1" },
      ] }));
      expect(() => loadWorkloadDirectory(root)).toThrow("outputs.json must match the plan deliverables");
      write("outputs.json", JSON.stringify({ files: [], deliverable: { name: "second.json", parser: "json/v1" } }));
      expect(() => loadWorkloadDirectory(root)).toThrow("outputs.json must match the plan deliverables");
      write("outputs.json", JSON.stringify(matchingOutputs));
      write("candidates/valid/extra.json", "{}\n");
      expect(() => loadWorkloadDirectory(root)).toThrow(/exactly match/);
      rmSync(join(root, "candidates/valid/extra.json"));
      rmSync(join(root, "candidates/valid/notes.txt"));
      expect(() => loadWorkloadDirectory(root)).toThrow(/exactly match/);
      write("candidates/valid/notes.txt", "notes\n");
      write("reference/extra.json", "{}\n");
      expect(() => loadWorkloadDirectory(root)).toThrow(/exactly match/);
      const unsafe = { ...plan, references: [{ name: "../secret.json", parser: "json/v1" }] };
      write("plan.json", JSON.stringify(unsafe));
      expect(() => loadWorkloadDirectory(root)).toThrow(/file name/);
      const unknownParser = {
        ...plan,
        references: [{ name: "a.json", parser: "yaml/v1" }],
      };
      write("plan.json", JSON.stringify(unknownParser));
      expect(() => loadWorkloadDirectory(root)).toThrow(/parser/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("binds the legacy and meridian workloads to their recorded files and provenance", () => {
    const legacy = loadFundedWorkload(REPO, onlyWorkload());
    const meridian = loadFundedWorkload(REPO, onlyWorkload("meridian"));
    expect(legacy.id).toBe("legacy");
    expect(legacy.inputRel).toBe("docs/core-sprint-input");
    expect(legacy.reportRel).toBe("agents/anish/reports/core-sprint-local-2026-11-15.json");
    expect(legacy.oracleRel).toBe("docs/core-sprint-input/oracle.py");
    expect(legacy.scratchPrefix).toBe("core-sprint-local-");
    expect(legacy.proveBudgetSec).toBe(900);
    expect(legacy.expirySeconds).toBe(3600);
    expect(legacy.provenanceBound).toBe(true);
    expect(legacy.authoring.plan.planSha256).toBe(legacy.hashes.plan);
    expect(legacy.guest).toBeNull();
    expect(legacy.hashes.provenance["authoring.json"]).toBe(fileHash(join(legacy.inputDir, "authoring.json")));
    expect(legacy.hashes.provenance["tests/test_oracle.py"]).toBe(fileHash(join(legacy.inputDir, "tests/test_oracle.py")));
    expect(legacy.solverName).toBe("synthetic-known-feasible-candidate");
    const legacyPlan = JSON.parse(readFileSync(join(legacy.inputDir, "plan.json"), "utf8")) as {
      references: { name: string; parser: string }[];
      deliverables: { name: string; parser: string }[];
    };
    expect(legacy.references.map(file => file.name)).toEqual(legacyPlan.references.map(file => file.name));
    expect(legacy.outputs.map(file => ({ name: file.name, parser: file.parser })))
      .toEqual(legacyPlan.deliverables.map(file => ({ name: file.name, parser: file.parser })));
    expect(legacy.hashes.plan).toBe(fileHash(join(legacy.inputDir, "plan.json")));
    expect(legacy.hashes.dataset).toEqual(Object.fromEntries(legacyPlan.references.map(file => [
      file.name, fileHash(join(legacy.inputDir, "reference", file.name)),
    ])));
    expect(legacy.authoring.plan.grokUsed).toBe(false);
    expect(legacy.authoring.plan.nativeOrcaInference).toBe(false);
    expect(legacy.authoring.plan.httpDraftModel).toBe(null);
    expect(legacy.authoring.solver.model).toBe(null);
    expect(legacy.authoring.solver.materializedCandidate).toBe(true);
    expect(legacy.authoring.solver.runtimeAutonomousSolve).toBe(false);
    expect(legacy.authoring.liveGrokApiCallDuringSuite).toBe(false);
    expect(legacy.authoring.mainnetOrLiveWrites).toBe(false);
    expect(suiteAuthoringLabel(legacy)).toBeUndefined();

    expect(meridian.id).toBe("meridian");
    expect(meridian.inputRel).toBe("docs/fresh-exchange-input");
    expect(meridian.reportRel).toBe("agents/anish/reports/fresh-exchange-local-2026-11-15.json");
    expect(meridian.oracleRel).toBe("docs/fresh-exchange-input/oracle.py");
    expect(meridian.reportPath).toBe(join(REPO, meridian.reportRel));
    expect(meridian.scratchPrefix).toBe("fresh-exchange-local-");
    expect(meridian.proveBudgetSec).toBe(1800);
    expect(meridian.expirySeconds).toBe(7200);
    expect(meridian.provenanceBound).toBe(true);
    expect(meridian.authoring.plan.planSha256).toBe(meridian.hashes.plan);
    expect(meridian.authoring.plan.planSha256).toBe(fileHash(join(meridian.inputDir, "plan.json")));
    expect(meridian.guest?.compileSeconds).toBe(16);
    expect(meridian.guest?.groth16).toBe(false);
    expect(meridian.guest?.hostJournalMatches).toBe(true);
    expect(meridian.guest?.executions).toEqual([...MERIDIAN_GUEST_EXECUTIONS]);
    expect(meridian.timingUncertainty).toContain("1800");
    expect(meridian.timingUncertainty).toContain("not a production");
    expect(meridian.timingUncertainty.toLowerCase()).not.toContain("guaranteed");
    const guestReport = JSON.parse(readFileSync(join(REPO, meridian.guest!.reportRel), "utf8")) as {
      groth16: boolean; executions: { name: string; verdict: number; userCycles: number }[];
    };
    expect(guestReport.groth16).toBe(false);
    expect(guestReport.executions.map(row => ({ name: row.name, verdict: row.verdict, userCycles: row.userCycles })))
      .toEqual(meridian.guest?.executions);
    const meridianPlan = JSON.parse(readFileSync(join(meridian.inputDir, "plan.json"), "utf8")) as {
      references: { name: string; parser: string }[];
      deliverables: { name: string; parser: string }[];
    };
    expect(meridian.references.map(file => ({ name: file.name, parser: file.parser })))
      .toEqual(meridianPlan.references.map(file => ({ name: file.name, parser: file.parser })));
    expect(meridian.outputs.map(file => ({ name: file.name, parser: file.parser, format: file.format })))
      .toEqual(meridianPlan.deliverables.map(file => ({ name: file.name, parser: file.parser, format: "json" as const })));
    expect(meridian.hashes.plan).toBe(fileHash(join(meridian.inputDir, "plan.json")));
    expect(meridian.hashes.dataset).toEqual({
      "dataset.json": fileHash(join(meridian.inputDir, "reference/dataset.json")),
    });
    expect(meridian.hashes.candidates).toEqual({
      "schedule.json": fileHash(join(meridian.inputDir, "candidates/valid/schedule.json")),
    });
    expect(meridian.hashes.input).toBe(manifestHash(meridian.inputDir, [
      "plan.json", "request.md", "outputs.json", "reference/dataset.json", "candidates/valid/schedule.json",
    ]));
    expect(meridian.authoring.plan.model).toBe("grok-4.7-build-fast");
    expect(meridian.authoring.plan.effort).toBe("low");
    expect(meridian.authoring.plan.interface).toContain("Orca native");
    expect(meridian.authoring.plan.httpDraftModel).toBe(false);
    expect(meridian.authoring.plan.nativeOrcaInference).toBe(true);
    expect(meridian.authoring.plan.recordedFile).toBe("docs/fresh-exchange-input/authoring/provenance.json");
    expect(meridian.authoring.solver.model).toBe("grok-4.7");
    expect(meridian.authoring.solver.effort).toBe("high");
    expect(meridian.authoring.solver.recordedFile).toBe("docs/fresh-exchange-input/solver/provenance.json");
    expect(meridian.authoring.solver.materializedCandidate).toBe(true);
    expect(meridian.authoring.solver.runtimeAutonomousSolve).toBe(false);
    expect(meridian.authoring.liveGrokApiCallDuringSuite).toBe(false);
    expect(meridian.authoring.mainnetOrLiveWrites).toBe(false);
    expect(meridian.solverName).toBe("materialized-grok-4.7-high-candidate");
    const label = suiteAuthoringLabel(meridian);
    expect(label).toContain("grok-4.7-build-fast");
    expect(label).toContain("low");
    expect(label).toContain("httpDraftModel=false");
    expect(label).toContain("grok-4.7");
    expect(label).toContain("high");
    expect(label).toContain("materialized candidate");
    expect(label).toContain("does not call a model");
    expect(label?.toLowerCase()).not.toContain("autonomous agent solves");
    const evidence = JSON.stringify(fundedWorkloadEvidence(meridian));
    expect(evidence).not.toContain(REPO);
    expect(evidence).not.toContain("https://");
    expect(evidence).toContain("docs/fresh-exchange-input/oracle.py");
    expect(evidence).not.toContain(meridian.oraclePath);
    expect(evidence).toContain("docs/fresh-exchange-input");
    expect(fundedWorkloadEvidence(meridian).proveBudgetSec).toBe(1800);
    expect(fundedWorkloadEvidence(meridian).expirySeconds).toBe(7200);
    expect(fundedWorkloadEvidence(legacy).id).toBe("legacy");
  });

  it("stamps the selector and workload bytes without changing the default source list", () => {
    const legacy = loadFundedWorkload(REPO, onlyWorkload());
    const files = rehearsalStampFiles(chainSupport.REHEARSAL_SOURCE_FILES, legacy);
    expect(files.slice(0, chainSupport.REHEARSAL_SOURCE_FILES.length)).toEqual([...chainSupport.REHEARSAL_SOURCE_FILES]);
    expect(files).toContain("commerce/worker/test/support/funded-workload.ts");
    expect(files).toContain("docs/core-sprint-input/request.md");
    expect(files).toContain("docs/core-sprint-input/plan.json");
    expect(files).toContain("docs/core-sprint-input/outputs.json");
    expect(files).toContain("docs/core-sprint-input/reference/catalog.json");
    expect(files).toContain("docs/core-sprint-input/candidates/valid/allocations.json");
    expect(files).toContain("docs/core-sprint-input/candidates/valid/dispatch.json");
    expect(files).toContain("docs/core-sprint-input/oracle.py");
    expect(files).toContain("docs/core-sprint-input/tests/test_oracle.py");
    const stamp = chainSupport.rehearsalSource(REPO, files);
    expect(stamp.files.map(file => file.path)).toEqual(files);
    for (const file of stamp.files) {
      expect(file.sha256).toBe(fileHash(join(REPO, file.path)));
    }
    expect(chainSupport.rehearsalSource(REPO).files.map(file => file.path)).toEqual([...chainSupport.REHEARSAL_SOURCE_FILES]);
    expect(rehearsalStampRoles(files, legacy)["commerce/worker/test/support/funded-workload.ts"]).toBe("workload-selector");
    expect(rehearsalStampRoles(files, legacy)["docs/core-sprint-input/tests/test_oracle.py"]).toBe("oracle-provenance");
    expect(preservedReportRels("legacy")).toEqual(["agents/anish/reports/fresh-exchange-local-2026-11-15.json"]);
    expect(preservedReportRels("meridian")).toEqual(["agents/anish/reports/core-sprint-local-2026-11-15.json"]);
    expect(() => assertAllowedProvenanceKey("../secret.json", legacy.inputRel, ["catalog.json"])).toThrow("Unexpected provenance path");
    expect(() => assertAllowedProvenanceKey("/tmp/secret-workload", legacy.inputRel, ["catalog.json"])).toThrow("Unexpected provenance path");
    try { assertAllowedProvenanceKey("../secret.json", legacy.inputRel, ["catalog.json"]); }
    catch (error) { expect(String(error)).not.toContain("../secret.json"); }
    expect(() => submittedSnapshotRefundEvidence({
      snapshotId: "1", parentHash: "0xa", restoredHash: "0xb", parentNumber: 1n, restoredNumber: 1n,
      refundBlockTimestamp: 5n, expiry: 5n, amount: "1000000", kind: "Submitted", payoutOnThisBranch: null,
    })).toThrow(/parent block/);
    expect(() => localPendingRestartEvidence({
      rawSends: 2, pendingBlockNumber: null, observedHash: "0x1", resumedHash: "0x1", duplicateSubmits: 0,
    })).toThrow(/exactly once/);
    const invalid = wellFormedInvalidDeliverable(loadFundedWorkload(REPO, onlyWorkload("meridian")).outputs);
    const parsed = JSON.parse(Buffer.from(invalid[0]!.content).toString("utf8")) as { charges: { lot_id: string }[] };
    expect(parsed.charges[1]!.lot_id).toBe(parsed.charges[0]!.lot_id);
    expect(parsed.charges[0]!.lot_id).not.toBe("L-KA-03");
  });

  it("reads a local receipt that appears after the first lookup without sending again", async () => {
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const blockHash = `0x${"cd".repeat(32)}` as Hex;
    let reads = 0;
    let sends = 0;
    const block = {
      number: "0xc", hash: blockHash, parentHash: `0x${"11".repeat(32)}`,
      nonce: "0x0", sha3Uncles: `0x${"00".repeat(32)}`, logsBloom: `0x${"00".repeat(256)}`,
      transactionsRoot: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`,
      receiptsRoot: `0x${"00".repeat(32)}`, miner: "0x2222222222222222222222222222222222222222",
      difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1",
      gasUsed: "0x1", timestamp: "0x1", transactions: [], uncles: [],
    };
    const client = createPublicClient({
      chain: chainSupport.localArc, pollingInterval: 20,
      transport: custom({
        request: async ({ method }) => {
          if (method === "eth_sendRawTransaction") {
            sends += 1;
            throw new Error("local receipt wait must not send");
          }
          if (method === "eth_chainId") return toHex(chainSupport.localArc.id);
          if (method === "eth_blockNumber") return "0xc";
          if (method === "eth_getTransactionByHash") return null;
          if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") return block;
          if (method === "eth_getTransactionReceipt") {
            reads += 1;
            if (reads < 3) return null;
            return {
              transactionHash: hash, transactionIndex: "0x0", blockHash, blockNumber: "0xc",
              from: "0x1111111111111111111111111111111111111111",
              to: "0x2222222222222222222222222222222222222222",
              cumulativeGasUsed: "0x1", gasUsed: "0x1", contractAddress: null, logs: [],
              logsBloom: `0x${"00".repeat(256)}`, status: "0x1", effectiveGasPrice: "0x1", type: "0x2",
            };
          }
          throw new Error(`unexpected local receipt method ${method}`);
        },
      }),
    });
    const found = await chainSupport.readOwnedLocalReceipt(client, hash, 1_500);
    expect(found.transactionHash).toBe(hash);
    expect(found.status).toBe("success");
    expect(found.blockNumber).toBe(12n);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(sends).toBe(0);
  });
});

it("fresh real-context funded local integration", async () => {
  process.umask(0o077);
  const workload = loadFundedWorkload(REPO, process.env);
  // Validate every executable and storage setting before starting any child.
  const configTools = chainSupport.resolveFundedTools(REPO);
  const { anvilVersion, r0vmVersion } = await chainSupport.verifyFundedTools(configTools);
  const root = mkdtempSync(join(configTools.scratchRoot, workload.scratchPrefix));
  chmodSync(root, 0o700);
  const privateWrite = (name: string, value: string) => writeFileSync(join(root, name), value, { mode: 0o600 });
  const directory = (name: string) => { const p = join(root, name); mkdirSync(p, { mode: 0o700 }); return p; };
  const errors = vi.spyOn(console, "error").mockImplementation((...args) => {
    privateWrite(`console-${randomUUID()}.log`, inspect(args, { depth: 12 }));
  });
  let stage = "preflight";
  const previous = existsSync(workload.reportPath) ? JSON.parse(readFileSync(workload.reportPath, "utf8")) as Record<string, unknown> : undefined;
  const preservedReports = preservedReportRels(workload.id).map(rel => ({
    rel, bytes: existsSync(join(REPO, rel)) ? readFileSync(join(REPO, rel)) : null,
  }));
  const stampFiles = rehearsalStampFiles(chainSupport.REHEARSAL_SOURCE_FILES, workload);
  const source = chainSupport.rehearsalSource(REPO, stampFiles);
  const evidence: Record<string, unknown> = chainSupport.nextAttemptEvidence(previous, source);
  evidence.source = { ...source, roles: rehearsalStampRoles(stampFiles, workload) };
  evidence.workload = fundedWorkloadEvidence(workload);
  const authoringLabel = suiteAuthoringLabel(workload);
  if (authoringLabel) evidence.authoring = authoringLabel;
  const checkpoint = (next: string, fields: Record<string, unknown> = {}) => {
    stage = next;
    Object.assign(evidence, fields, { stage });
    writeFileSync(workload.reportPath, json(evidence), { mode: 0o644 });
    privateWrite("stage.json", json({ stage, at: new Date().toISOString() }));
  };
  let chain: Awaited<ReturnType<typeof startRealChain>> | undefined;
  let server: ServerType | undefined;
  let closeApp: (() => void) | undefined;
  let indexDb: ReturnType<typeof openDb> | undefined;
  let funding: Awaited<ReturnType<typeof createPosterFunding>> | undefined;
  let replayFunding: Awaited<ReturnType<typeof createPosterFunding>> | undefined;
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
    const proofLimit = workload.id === "meridian" ? 2 : 1;
    let proveCalls = 0;
    const runner: EngineRunner = {
      path: originalRunner.path,
      run: async (args, timeout) => {
        if (args[0] === "prove") {
          if (++proveCalls > proofLimit) throw new Error("Unexpected duplicate proving within one funded attempt");
          checkpoint(workload.id === "meridian" && proveCalls === 1 ? "fresh-verdict0-proving" : "fresh-groth16-proving");
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
    const dbPath = join(directory("db"), "api.sqlite");
    const apiChain = createApiArcChain(addresses, pub);
    const app = createApp({
      dbPath, buyerToken: token, engine, packagesDir, chain: apiChain,
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
    const reference = workload.references.map(file => ({ name: file.name, content: file.content }));
    const expectedOutputs = workload.outputs.map(file => ({ name: file.name, content: file.content }));
    const revision = {
      plan: workload.plan,
      referenceDigest: referenceDigestOf(reference),
      outputs: workload.outputs.map(file => ({ name: file.name, format: file.format })),
      expirySeconds: workload.expirySeconds, maxBudget: "1000000",
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
      solver: { name: workload.solverName, solve: async () => expectedOutputs },
      attemptDir: join(root, "provider-attempt"), proveBudgetSec: workload.proveBudgetSec, releaseMarginSec: 120, submitBudgetSec: 60,
    };
    const balanceOf = (account: `0x${string}`) => pub.readContract({
      address: addresses.usdc, abi: arcErc20Abi, functionName: "balanceOf", args: [account],
    });
    let verdict0Key = "";
    if (workload.id === "meridian") {
      const invalid = wellFormedInvalidDeliverable(workload.outputs);
      const invalidDir = directory("invalid-schedule");
      for (const file of invalid) writeFileSync(join(invalidDir, file.name), file.content, { mode: 0o600 });
      let oracleStdout = "";
      try {
        const result = await execute(configTools.pythonBin, ["-B", workload.oraclePath, invalidDir], {
          cwd: root, timeout: 30_000, encoding: "utf8", env: { PATH: dirname(configTools.pythonBin) },
        });
        oracleStdout = result.stdout;
      } catch (error) {
        const stdout = (error as { stdout?: unknown }).stdout;
        if (typeof stdout !== "string" || stdout.length === 0) throw error;
        oracleStdout = stdout;
      }
      const oracleVerdict = JSON.parse(oracleStdout) as { accepted?: unknown; encoded_bytes?: unknown };
      if (oracleVerdict.accepted !== false || typeof oracleVerdict.encoded_bytes !== "number") {
        throw new Error("Duplicate-lot schedule was not a verdict-class oracle rejection");
      }
      const verdict0 = await runFunded({
        ...options,
        attemptDir: join(root, "provider-attempt-verdict0"),
        solver: { name: workload.solverName, solve: async () => invalid },
        stopAfterProof: true,
      });
      proofCompleted = true;
      expect(verdict0.phase).toBe("rejected");
      expect(verdict0.verdict).toBe(0);
      expect(verdict0.submitTx).toBeUndefined();
      const proof0 = parseProofJson(readFileSync(join(root, "provider-attempt-verdict0/attempt/proof.json"), "utf8"));
      verdict0Key = readFileSync(join(root, "provider-attempt-verdict0/attempt/release-key.hex"), "utf8").trim();
      expect(proof0.seal.startsWith("0xe71e6620")).toBe(true);
      const before = {
        buyer: await balanceOf(buyer.address), provider: await balanceOf(provider.address), escrow: await balanceOf(addresses.core),
      };
      const verdict0Data = encodeFunctionData({
        abi: arcCoreAbi, functionName: "submit",
        args: [id, sha256(bytesToHex(proof0.envelope)), encodeAbiParameters(
          [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }],
          [bytesToHex(proof0.envelope), proof0.seal, proof0.keyCommitment],
        )],
      });
      let revertData: Hex | undefined;
      try { await pub.call({ to: addresses.core, data: verdict0Data, account: provider.address, gas: 2_000_000n }); }
      catch (error) { revertData = extractRevertData(error); }
      expect(revertData).toBeTruthy();
      expect(decodeErrorResult({
        abi: [{ type: "error", name: "VerificationFailed", inputs: [] }] as const, data: revertData!,
      }).errorName).toBe("VerificationFailed");
      expect(await balanceOf(buyer.address)).toBe(before.buyer);
      expect(await balanceOf(provider.address)).toBe(before.provider);
      expect(await balanceOf(addresses.core)).toBe(before.escrow);
      expect((await readonlyPort.snapshot(id)).job.status).toBe("Funded");
      checkpoint("fresh-verdict0-rejected", {
        freshGroth16Proofs: 1,
        verdict0: { verdict: 0, sealSelector: "0xe71e6620", candidate: "duplicate-lot", oracleEncodedBytes: oracleVerdict.encoded_bytes },
      });
    }
    const proved = await runFunded({ ...options, stopAfterProof: true });
    proofCompleted = true;
    expect(proved.phase).toBe("proved");
    expect(proved.verdict).toBe(1);
    const proof = parseProofJson(readFileSync(join(options.attemptDir, "attempt/proof.json"), "utf8"));
    const key = readFileSync(join(options.attemptDir, "attempt/release-key.hex"), "utf8").trim() as Hex;
    expect(proveCalls).toBe(proofLimit);
    checkpoint("local-proof-negative-calls", { freshGroth16Proofs: proveCalls, proof: {
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
    replayFunding = await createPosterFunding({
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
    let providerRawSends = 0;
    broadcaster = await createLocalBroadcaster({
      account: provider, provider: provider.address, ...addresses, jobId: id, expiresAt: expiry,
      submitDeadline: expiry - 180n, releaseDeadline: expiry - 60n, validUntil: expiry - 30n,
      maxGas: 2_000_000n, releaseGas: 500_000n, ...FEES, totalBudget: 1n * 10n ** 18n,
      journalRoot: directory("provider-journal"), public: signerPublic,
      rawSend: async (args, options) => { providerRawSends += 1; return rawSend(args, options); },
      authorizations: [
        { kind: "submit", jobId: id, envelope, envelopeHash: proof.envelopeHash, seal: proof.seal, keyCommitment: proof.keyCommitment },
        { kind: "release", jobId: id, key, context: proof.contextBytes, keyCommitment: proof.keyCommitment },
      ],
    });
    const port = createArcSettlementPort({ ...config, allowBroadcast: true }, { public: pub, broadcaster });
    let pendingRestart: Record<string, unknown> | undefined;
    let submittedRefund: Record<string, unknown> | undefined;
    const claimData = encodeFunctionData({ abi: arcCoreAbi, functionName: "claimRefund", args: [id] });
    const dummyRelease = encodeFunctionData({ abi: arcHookAbi, functionName: "release", args: [id, zeroHash] });
    const namedRevert = async (to: Hex, data: Hex, abi: Abi, errorName: string, account: `0x${string}`, time?: bigint) => {
      let dataHex: Hex | undefined;
      try {
        await pub.call({ to, data, account, gas: 2_000_000n, ...(time === undefined ? {} : { blockOverrides: { time } }) });
      } catch (error) { dataHex = extractRevertData(error); }
      if (!dataHex) throw new Error(`Expected ${errorName}`);
      if (decodeErrorResult({ abi, data: dataHex }).errorName !== errorName) throw new Error(`Expected ${errorName}`);
    };
    // The refund branch is reverted before the real release. The indexer later reads that kept payout history.
    const observedPort = {
      ...port,
      submit: async (job: bigint, pkg: Parameters<typeof port.submit>[1]) => {
        await port.submit(job, pkg);
        throw new Error("submit RPC failed after the local raw send");
      },
      release: async (job: bigint, releaseKey: Hex) => {
        const localChain = chain;
        if (!localChain) throw new Error("Local chain is not open");
        if (!submittedRefund) {
          const parent = await pub.getBlock();
          if (!parent.hash || parent.number === null) throw new Error("Parent block has no identity");
          const snapshotId = await localChain.request({ method: "evm_snapshot", params: [] });
          await namedRevert(addresses.core, claimData, arcCoreAbi, "WrongStatus", localChain.admin.address);
          if (!Number.isSafeInteger(Number(expiry))) throw new Error("Expiry is not a safe timestamp");
          await namedRevert(addresses.hook, dummyRelease, arcHookAbi, "Expired", provider.address, expiry);
          const buyerBefore = await balanceOf(buyer.address);
          const providerBefore = await balanceOf(provider.address);
          const sendsBefore = providerRawSends;
          await localChain.request({ method: "evm_setNextBlockTimestamp", params: [Number(expiry)] });
          const refund = await localChain.send(localChain.admin, addresses.core, claimData, 500_000n);
          const refundBlock = await pub.getBlock({ blockNumber: refund.blockNumber });
          if ((await balanceOf(buyer.address)) !== buyerBefore + 1_000_000n) throw new Error("Buyer refund balance mismatch");
          if ((await balanceOf(provider.address)) !== providerBefore) throw new Error("Provider balance changed on the refund branch");
          const branched = await readonlyPort.snapshot(id);
          if (branched.job.status === "Completed" || branched.job.status !== "Expired") throw new Error("Submitted refund did not expire the job");
          const reverted = await localChain.request({ method: "evm_revert", params: [snapshotId] });
          if (reverted !== true) throw new Error("Snapshot revert failed");
          const restored = await pub.getBlock();
          if (!restored.hash || restored.number === null) throw new Error("Restored block has no identity");
          await expect(pub.getTransactionReceipt({ hash: refund.transactionHash })).rejects.toThrow();
          if ((await readonlyPort.snapshot(id)).job.status !== "Submitted") throw new Error("Canonical job is not Submitted after revert");
          if (providerRawSends !== sendsBefore) throw new Error("Refund branch sent a provider transaction");
          submittedRefund = submittedSnapshotRefundEvidence({
            snapshotId: String(snapshotId), parentHash: parent.hash, restoredHash: restored.hash,
            parentNumber: parent.number, restoredNumber: restored.number, refundBlockTimestamp: refundBlock.timestamp,
            expiry, amount: "1000000", kind: "Submitted", payoutOnThisBranch: null,
          });
        }
        return port.release(job, releaseKey);
      },
    };
    checkpoint("submit-real-interruption");
    await chain.request({ method: "evm_setAutomine", params: [false] });
    let pendingHash: Hex | undefined;
    try {
      await expect(runFunded({ ...options, port: observedPort })).rejects.toBeInstanceOf(WorkerCheckError);
      expect(providerRawSends).toBe(1);
      const journal = JSON.parse(readFileSync(broadcaster.journalPath, "utf8")) as { entries: { kind: string; stage: string; hash?: string }[] };
      const submitEntry = journal.entries.find(entry => entry.kind === "submit");
      expect(submitEntry?.stage).toBe("intent");
      pendingHash = submitEntry?.hash as Hex;
      expect(pendingHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      const pendingTx = await pub.getTransaction({ hash: pendingHash });
      expect(pendingTx.blockNumber).toBeNull();
      const pool = await chain.request({ method: "txpool_content", params: [] }) as { pending?: Record<string, Record<string, { hash?: string }>> };
      const pooled = Object.values(pool.pending ?? {}).flatMap(byNonce => Object.values(byNonce).map(tx => tx.hash?.toLowerCase()));
      expect(pooled).toContain(pendingHash.toLowerCase());
      const uncertain = await runFunded({ ...options, port: observedPort }).then(() => {
        throw new Error("Uncertain restart returned instead of refusing");
      }, (error: unknown) => error);
      expect(uncertain).toBeInstanceOf(WorkerCheckError);
      expect((uncertain as WorkerCheckError).check).toBe("broadcast_uncertain");
      expect(providerRawSends).toBe(1);
      const statePath = join(options.attemptDir, "state.json");
      const durable = JSON.parse(readFileSync(statePath, "utf8")) as FundedState;
      expect(durable.phase).toBe("submit_broadcasting");
      expect(durable.submitTx).toBeUndefined();
      durable.phase = "submit_sent";
      durable.submitTx = pendingHash;
      writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);
      const restarted = await runFunded({ ...options, port: observedPort });
      expect(restarted.phase).toBe("submit_sent");
      expect(restarted.submitTx).toBe(pendingHash);
      expect(providerRawSends).toBe(1);
      expect((await pub.getTransaction({ hash: pendingHash })).blockNumber).toBeNull();
      pendingRestart = localPendingRestartEvidence({
        rawSends: providerRawSends, pendingBlockNumber: null, observedHash: pendingHash, resumedHash: restarted.submitTx!, duplicateSubmits: 0,
      });
      await chain.request({ method: "evm_mine", params: [] });
    } finally {
      await chain.request({ method: "evm_setAutomine", params: [true] });
    }
    if (!pendingHash) throw new Error("Pending submit hash missing");
    const observedSubmitReceipt = await pub.getTransactionReceipt({ hash: pendingHash });
    privateWrite("submit-receipt.private.json", json(observedSubmitReceipt));
    await chain.dump();
    const providerNonce = await pub.getTransactionCount({ address: provider.address, blockTag: "pending" });
    await rejected("wrong-dummy-key-before-release", addresses.hook, dummyRelease);
    expect((await broadcaster.reconcile(pendingHash)).status).toBe("success");
    checkpoint("resume-release-real");
    const settled = await runFunded({ ...options, port: observedPort });
    expect(settled.phase).toBe("released");
    expect(settled.paymentConfirmed).toBe(true);
    expect(settled.submitTx).toBe(pendingHash);
    expect(providerRawSends).toBe(2);
    expect(await pub.getTransactionCount({ address: provider.address, blockTag: "pending" })).toBe(providerNonce + 1);
    await broadcaster.reconcile(settled.submitTx!);
    await broadcaster.reconcile(settled.releaseTx!);
    const observedReleaseReceipt = await pub.getTransactionReceipt({ hash: settled.releaseTx! });
    privateWrite("release-receipt.private.json", json(observedReleaseReceipt));
    while (await pub.getBlockNumber({ cacheTime: 0 }) < observedReleaseReceipt.blockNumber + 3n) {
      await chain.request({ method: "evm_mine", params: [] });
    }
    indexDb = openDb(dbPath, () => Date.now());
    const indexedEvents = await createIndexer({ db: indexDb, chain: apiChain, cursorStart: 0n, confirmations: 3n }).tick();
    expect(indexedEvents).toBeGreaterThan(0);
    const submissionResponse = await fetch(`${base}/v1/jobs/${jobId}/submission`);
    const submissionBody = await submissionResponse.json() as {
      status?: string; submitTx?: string; releaseTx?: string; envelopeHash?: string; keyCommitment?: string; key?: string; statusSource?: string;
    };
    if (submissionResponse.status !== 200) throw new Error("Submission readout was not accepted");
    const sameHex = (left?: string, right?: string) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
    expect(sameHex(submissionBody.submitTx, settled.submitTx)).toBe(true);
    expect(sameHex(submissionBody.releaseTx, settled.releaseTx)).toBe(true);
    expect(sameHex(submissionBody.envelopeHash, proof.envelopeHash)).toBe(true);
    expect(sameHex(submissionBody.keyCommitment, proof.keyCommitment)).toBe(true);
    expect(submissionBody.status).toBe("Completed");
    expect(submissionBody.statusSource).toBe("index");
    const jobResponse = await fetch(`${base}/v1/jobs/${jobId}`);
    const jobBody = await jobResponse.json() as { state?: string; chain?: { status?: string; statusSource?: string } };
    expect(jobResponse.status).toBe(200);
    expect(jobBody.state).toBe("linked");
    expect(jobBody.chain?.status).toBe("Completed");
    expect(jobBody.chain?.statusSource).toBe("index");
    let chainKey = "";
    for (const log of observedReleaseReceipt.logs) {
      if (log.address.toLowerCase() !== addresses.hook.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: arcHookAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "KeyReleased" && decoded.args && "key" in decoded.args && typeof decoded.args.key === "string") {
          chainKey = decoded.args.key;
        }
      } catch { /* unrelated log */ }
    }
    if (!chainKey || submissionBody.key?.toLowerCase() !== chainKey.toLowerCase() || chainKey.toLowerCase() !== key.toLowerCase()) {
      throw new Error("Indexed released key does not match the chain KeyReleased event");
    }
    const indexedDelivery = {
      status: submissionBody.status, statusSource: submissionBody.statusSource, jobState: jobBody.state,
      submitTx: submissionBody.submitTx, releaseTx: submissionBody.releaseTx,
      envelopeHash: submissionBody.envelopeHash, keyCommitment: submissionBody.keyCommitment,
      confirmations: "3", releasedKeyMatchesChain: true, indexedEvents,
    };
    checkpoint("release-confirmed", {
      submitReceipt: { hash: observedSubmitReceipt.transactionHash, block: observedSubmitReceipt.blockNumber,
        blockHash: observedSubmitReceipt.blockHash, status: observedSubmitReceipt.status, gasUsed: observedSubmitReceipt.gasUsed },
      releaseReceipt: { hash: observedReleaseReceipt.transactionHash, block: observedReleaseReceipt.blockNumber,
        blockHash: observedReleaseReceipt.blockHash, status: observedReleaseReceipt.status, gasUsed: observedReleaseReceipt.gasUsed },
      indexedDelivery, pendingRestart, submittedRefund,
    });
    await chain.dump();
    checkpoint("buyer-independent-dual-recovery");
    const recovered = await recoverArcDeliveryDual(pub, {
      ...addresses, jobId: id, provider: provider.address, budget: 1_000_000n, expiry,
      imageId: proof.imageId, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash,
      submitTx: settled.submitTx!, releaseTx: settled.releaseTx!, expectedOutputs, deploymentPolicy: policy,
    }, { runner, directory: join(root, "buyer-recovery") });
    expect(recovered.evidence.engineDecryptMatches).toBe(true);
    const oracle = await execute(configTools.pythonBin, ["-B", workload.oraclePath, recovered.engineDirectory],
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
    // The refund transaction's own block timestamp is the expiry. An empty block at expiry would make this later.
    if (!Number.isSafeInteger(Number(expiry))) throw new Error("Expiry is not a safe timestamp");
    const buyerBeforeFundedRefund = await balanceOf(buyer.address);
    const providerBeforeFundedRefund = await balanceOf(provider.address);
    await chain.request({ method: "evm_setNextBlockTimestamp", params: [Number(expiry)] });
    const refund = await chain.send(chain.admin, addresses.core, encodeFunctionData({
      abi: arcCoreAbi, functionName: "claimRefund", args: [refundId],
    }), 500_000n);
    const fundedRefundBlock = await pub.getBlock({ blockNumber: refund.blockNumber });
    if (fundedRefundBlock.timestamp !== expiry) throw new Error("Funded refund block timestamp is not the job expiry");
    expect(await balanceOf(buyer.address)).toBe(buyerBeforeFundedRefund + 1_000_000n);
    expect(await balanceOf(provider.address)).toBe(providerBeforeFundedRefund);
    if ((await readonlyPort.snapshot(refundId)).job.status !== "Expired") throw new Error("Funded refund job did not expire");
    if ((await readonlyPort.snapshot(id)).job.status !== "Completed") throw new Error("Canonical payout job changed during the other job's refund");
    await rejected("duplicate-refund", addresses.core, encodeFunctionData({
      abi: arcCoreAbi, functionName: "claimRefund", args: [refundId],
    }));
    const submitReceipt = await pub.getTransactionReceipt({ hash: settled.submitTx! });
    const releaseReceipt = await pub.getTransactionReceipt({ hash: settled.releaseTx! });
    expect(proveCalls).toBe(proofLimit);
    if (!pendingRestart || !submittedRefund || !indexedDelivery) throw new Error("Canonical payout evidence is incomplete");
    if (submittedRefund.sameHistoryAsCanonicalPayout !== false) throw new Error("Submitted refund shares history with the canonical payout");
    const notClaimed = ["Live Arc settlement", "Live Grok"];
    if (workload.id !== "meridian") notClaimed.push("Fresh failing-verdict proof");
    checkpoint("complete", {
      status: "passed", negatives, recovery: recovered.evidence, oracle: JSON.parse(oracle.stdout),
      exactRecoveredFiles: expectedOutputs.map(f => ({ name: f.name, bytes: f.content.length,
        sha256: createHash("sha256").update(f.content).digest("hex") })),
      settlementReceipts: [submitReceipt, releaseReceipt].map(r => ({
        hash: r.transactionHash, block: r.blockNumber, blockHash: r.blockHash, status: r.status, gasUsed: r.gasUsed,
      })),
      pendingRestart, submittedRefund, indexedDelivery,
      fundedJobRefund: {
        type: "actual independent Funded job; exact-expiry refund after a different job's canonical payout",
        jobId: refundId, hash: refund.transactionHash, block: refund.blockNumber,
        blockTimestamp: fundedRefundBlock.timestamp, amount: "1000000", kind: "Funded",
        sameJobAsCanonicalPayout: false,
      },
      notClaimed,
    });
    for (const item of preservedReports) {
      const now = existsSync(join(REPO, item.rel)) ? readFileSync(join(REPO, item.rel)) : null;
      expect(now).toEqual(item.bytes);
    }
    // A public report must never contain any release key, private account key, or raw signed data.
    const publicReport = readFileSync(workload.reportPath, "utf8");
    const secretBody = (value: string) => value.startsWith("0x") ? value.slice(2) : value;
    expect(publicReport).not.toContain(secretBody(key));
    if (verdict0Key) expect(publicReport).not.toContain(secretBody(verdict0Key));
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
    writeFileSync(workload.reportPath, json(evidence), { mode: 0o644 });
    throw new Error(`Local funded integration failed at stage: ${stage}. Diagnostics remain private.`);
  } finally {
    await broadcaster?.close();
    try { await replayFunding?.close(); }
    finally { await funding?.close(); }
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (indexDb?.isOpen) indexDb.close();
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
