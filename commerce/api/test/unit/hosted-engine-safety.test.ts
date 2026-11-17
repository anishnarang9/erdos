import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliEngine, COMPILER_PATH, compilerProcessEnv } from "../../src/index.ts";

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
