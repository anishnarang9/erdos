import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliEngine, COMPILER_PATH, compilerProcessEnv, engineFromConfig, wslEngineBin } from "../../src/index.ts";

afterEach(() => vi.unstubAllEnvs());

describe("compiler child boundary", () => {
  it("does not send model credentials or arbitrary server variables to an engine child", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-child-env-"));
    try {
      const script = join(root, "controlled-engine.mjs");
      await writeFile(
        script,
        `const h="0x"+"11".repeat(32);console.log(JSON.stringify({structureHash:h,rulesHash:h,preview:{modelCredentialPresent:Object.hasOwn(process.env,"XAI_API_KEY"),serverSecretPresent:Object.hasOwn(process.env,"UBC26_TEST_PARENT_SECRET_SENTINEL"),registryAuthPresent:Object.hasOwn(process.env,"DOCKER_AUTH_CONFIG")}}));`,
      );
      vi.stubEnv("XAI_API_KEY", "synthetic-only-child-test");
      vi.stubEnv("UBC26_TEST_PARENT_SECRET_SENTINEL", "synthetic-only-child-test");
      vi.stubEnv("DOCKER_AUTH_CONFIG", "synthetic-only-child-test");
      const engine = cliEngine({ bin: { command: process.execPath, args: [script] }, workDir: join(root, "work") });
      const result = await engine.validate({ version: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Controlled engine failed");
      expect(result.preview).toEqual({ modelCredentialPresent: false, serverSecretPresent: false, registryAuthPresent: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes explicit PATH, cache, work temp, and SSL locations only", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-child-explicit-"));
    try {
      const script = join(root, "controlled-engine.mjs");
      const cacheDir = join(root, "cache");
      const tempDir = join(root, "tmp");
      const cert = join(root, "ca.pem");
      await writeFile(
        script,
        `const h="0x"+"22".repeat(32);console.log(JSON.stringify({structureHash:h,rulesHash:h,preview:{path:process.env.PATH,tmp:process.env.TMPDIR,cache:process.env.UBC26_ENGINE_CACHE??null,cert:process.env.SSL_CERT_FILE??null,secret:Object.hasOwn(process.env,"XAI_API_KEY")}}));`,
      );
      vi.stubEnv("XAI_API_KEY", "synthetic-only-child-test");
      const engine = cliEngine({
        bin: { command: process.execPath, args: [script] },
        workDir: join(root, "work"),
        processEnv: { path: COMPILER_PATH, tmpDir: tempDir, cacheDir, ssl: { SSL_CERT_FILE: cert } },
      });
      const result = await engine.validate({ version: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Controlled engine failed");
      expect(result.preview).toEqual({ path: COMPILER_PATH, tmp: tempDir, cache: cacheDir, cert, secret: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops the owned engine process group after its deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-child-group-"));
    let descendant: number | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const marker = join(root, "descendant.pid");
      const script = join(root, "controlled-engine.mjs");
      await writeFile(
        script,
        `import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(marker)},String(child.pid),{flag:"wx"});setInterval(()=>{},1000);`,
      );
      const engine = cliEngine({ bin: { command: process.execPath, args: [script] }, workDir: join(root, "work"), timeoutMs: 500 });
      await expect(engine.validate({ version: 1 })).rejects.toMatchObject({ reason: "timeout" });
      descendant = Number(await readFile(marker, "utf8"));
      expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
      for (let n = 0; n < 40 && alive(descendant); n++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive(descendant)).toBe(false);
    } finally {
      if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a compiler environment that is the server environment object", () => {
    expect(() => compilerProcessEnv({ extra: process.env })).toThrow(/cannot inherit process.env/);
  });
});

describe("public executable pin", () => {
  it("accepts an absolute native executable and the pinned WSL wrapper", () => {
    expect(cliEngine({ bin: "/usr/local/bin/ubc26-engine", pin: "public" }).mode).toBe("real");
    const bin = wslEngineBin({ distro: "Ubuntu", enginePath: "/opt/ubc26/engine", wslBin: "/usr/local/bin/wsl.exe", cacheDir: "/var/lib/ubc26/cache" });
    expect(cliEngine({ bin, pin: "public" }).mode).toBe("real");
    expect(engineFromConfig({ mode: "native", enginePath: "/usr/local/bin/ubc26-engine", distro: "Ubuntu" }, { pin: "public" }).engine.mode).toBe("real");
  });

  it("rejects a relative executable, a PATH lookup, and an arbitrary wrapper", () => {
    expect(() => cliEngine({ bin: "ubc26-engine", pin: "public" })).toThrow(/absolute engine executable/);
    expect(() => cliEngine({ bin: { command: "/usr/local/bin/ubc26-engine", args: ["bash", "-lc", "echo"] }, pin: "public" })).toThrow(/unpinned engine wrapper/);
    expect(() => engineFromConfig({ mode: "native", enginePath: "relative-engine", distro: "Ubuntu" }, { pin: "public" })).toThrow(/ENGINE_PATH must be an absolute path/);
    expect(() => engineFromConfig({ mode: "wsl", enginePath: "/opt/ubc26/engine", distro: "Ubuntu" }, { pin: "public" })).toThrow(/ENGINE_WSL_BIN must be an absolute path/);
    expect(() => cliEngine({ bin: "/usr/local/bin/ubc26-engine", pin: "public", env: { FAKE_ENGINE_LOG: "/tmp/x" } })).toThrow(/extra compiler environment/);
  });
});

describe("engine cancellation and eval files", () => {
  it("does not spawn when the signal is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-abort-before-"));
    try {
      const marker = join(root, "spawned");
      const script = join(root, "controlled-engine.mjs");
      await writeFile(script, `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"spawned");`);
      const engine = cliEngine({ bin: { command: process.execPath, args: [script] }, workDir: join(root, "work") });
      const signal = AbortSignal.abort();
      await expect(engine.validate({ version: 1 }, { signal })).rejects.toMatchObject({ reason: "timeout" });
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates the owned process group when the signal aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-abort-group-"));
    let descendant: number | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const marker = join(root, "descendant.pid");
      const script = join(root, "controlled-engine.mjs");
      await writeFile(
        script,
        `import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(marker)},String(child.pid),{flag:"wx"});setInterval(()=>{},1000);`,
      );
      const engine = cliEngine({ bin: { command: process.execPath, args: [script] }, workDir: join(root, "work"), compileTimeoutMs: 60_000 });
      const controller = new AbortController();
      const pending = engine.compile({ plan: { version: 1 }, reference: [], signal: controller.signal });
      const started = Date.now();
      let text = "";
      while (Date.now() - started < 2_000) {
        try {
          text = await readFile(marker, "utf8");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      descendant = Number(text);
      expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ reason: "timeout" });
      for (let n = 0; n < 40 && alive(descendant); n++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive(descendant)).toBe(false);
    } finally {
      if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes bounded evidence and an exact funded context on the existing flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-eval-files-"));
    try {
      const log = join(root, "engine.log");
      const script = join(root, "controlled-engine.mjs");
      await writeFile(
        script,
        `import {appendFileSync,existsSync,readFileSync,readdirSync} from "node:fs";import {join} from "node:path";const flags=process.argv.slice(2);const flag=(name)=>{const i=flags.indexOf(name);return i>=0?flags[i+1]:undefined;};const evidence=flag("--evidence");const job=flag("--job");const files=evidence&&existsSync(evidence)?readdirSync(evidence).sort().map((n)=>({n,text:readFileSync(join(evidence,n),"utf8")})):[];appendFileSync(process.env.FAKE_ENGINE_LOG,JSON.stringify({flags,files,job:job&&existsSync(job)?readFileSync(job,"utf8"):null})+"\\n");console.log(JSON.stringify({verdict:1}));`,
      );
      const engine = cliEngine({
        bin: { command: process.execPath, args: [script] },
        workDir: join(root, "work"),
        env: { FAKE_ENGINE_LOG: log },
      });
      const context = `0x01${"ab".repeat(168)}`;
      const evidence = [{ name: "note.txt", content: new Uint8Array(Buffer.from("private", "utf8")) }];
      const result = await engine.eval?.({
        plan: { version: 1 },
        deliverables: [{ name: "out.json", content: new Uint8Array(Buffer.from("{}", "utf8")) }],
        reference: [{ name: "ledger.json", content: new Uint8Array(Buffer.from("[]", "utf8")) }],
        evidence,
        context,
      });
      expect(result).toEqual({ ok: true, verdict: 1 });
      const line = JSON.parse(await readFile(log, "utf8")) as { flags: string[]; files: { n: string; text: string }[]; job: string };
      expect(line.flags).toContain("--evidence");
      expect(line.flags).toContain("--job");
      expect(line.files).toEqual([{ n: "note.txt", text: "private" }]);
      expect(JSON.parse(line.job)).toEqual({ context });
      const aborted = AbortSignal.abort();
      await expect(engine.eval?.({
        plan: { version: 1 },
        deliverables: [],
        reference: [],
        evidence: [{ name: "late.txt", content: new Uint8Array([1]) }],
        context,
        signal: aborted,
      })).rejects.toMatchObject({ reason: "timeout" });
      await expect(engine.eval?.({
        plan: { version: 1 },
        deliverables: [],
        reference: [],
        context: "0x01" + "g".repeat(336),
      })).rejects.toMatchObject({ reason: "invalid_job" });
      await expect(engine.eval?.({
        plan: { version: 1 },
        deliverables: [],
        reference: [],
        evidence: Array.from({ length: 17 }, (_, i) => ({ name: `f${i}.txt`, content: new Uint8Array([1]) })),
      })).rejects.toMatchObject({ reason: "bad_file_name" });
      await expect(engine.eval?.({
        plan: { version: 1 },
        deliverables: [],
        reference: [],
        evidence: [{ name: "big.txt", content: new Uint8Array(32 * 1024 + 1) }],
      })).rejects.toMatchObject({ reason: "bad_file_name" });
      const logged = await readFile(log, "utf8");
      expect(logged).not.toContain("late.txt");
      expect(logged).not.toContain("big.txt");
      expect(logged).not.toContain("f16.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
