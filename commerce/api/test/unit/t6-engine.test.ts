import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeBundle } from "@ubc26/sdk";
import {
  EMPTY_REFERENCE_DIGEST,
  EngineError,
  cliEngine,
  parseEngineError,
  simulatedEngine,
  windowsToWslPath,
  wslEngineBin,
} from "../../src/index.ts";

const SCRIPT = fileURLToPath(new URL("../fixtures/engine/fake-engine.mjs", import.meta.url));
const childEnv: Record<string, string> = {};
let work: string;
let log: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ubc26-t6-engine-"));
  log = join(work, "calls.log");
  childEnv.FAKE_ENGINE_LOG = log;
});
afterAll(() => {
  delete childEnv.FAKE_ENGINE_LOG;
  delete childEnv.FAKE_REFERENCE_HASH;
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => {
  writeFileSync(log, "");
  delete childEnv.FAKE_REFERENCE_HASH;
});
const calls = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { cmd: string; flags: string[]; plan: string | null; reference: { n: string; b64: string }[]; deliverables: string[]; outExisted: boolean | null });

const fake = (mode: string, timeoutMs?: number) =>
  cliEngine({
    bin: { command: process.execPath, args: [SCRIPT, mode] },
    workDir: work,
    env: childEnv,
    ...(timeoutMs ? { timeoutMs, compileTimeoutMs: timeoutMs } : {}),
  });

const sha = (...parts: (string | Uint8Array)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
  return h.digest();
};
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const file = (name: string, s: string) => ({ name, content: new Uint8Array(Buffer.from(s, "utf8")) });
const PLAN = { version: 1, deliverables: [{ name: "out.json", parser: "json/v1" }], references: [], rules: [{ op: "literal", type: "bool", value: true }] };
const leftovers = () => readdirSync(work).filter((n) => n.startsWith("ubc26-engine-"));

describe("simulatedEngine", () => {
  it("validate mirrors simulatedValidatePlan and adds simulated hashes", async () => {
    const e = simulatedEngine();
    const ok = await e.validate({ version: 1 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.hashes?.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
    const r = await e.validate({});
    expect(r.ok === false && r.kind === "invalid" && r.errors[0]?.path).toBe("/plan/version");
  });

  it("compile hashes over raw bytes, files in bundle order, and agrees with validate", async () => {
    const plan = { version: 1, structure: { steps: ["a"] }, parameters: { n: 2 } };
    const files = [file("b.txt", "B"), file("a.txt", "A")];
    const r = await simulatedEngine().compile({ plan, reference: files });
    if (!r.ok) throw new Error("expected ok");
    const structure = sha("UBC26/structure/v1", canonicalize(plan.structure)!);
    const rules = sha("UBC26/rules/v1", structure, sha(canonicalize(plan.parameters)!));
    expect(r.manifest).toEqual({
      imageId: hex(sha("SIMULATED/image/v1", structure)),
      rulesHash: hex(rules),
      referenceHash: hex(sha("UBC26/reference/v1", encodeBundle(files))),
      structureHash: hex(structure),
      toolchain: { engine: "simulated" },
      files: [
        { name: "a.txt", sha256: hex(sha("A")) },
        { name: "b.txt", sha256: hex(sha("B")) },
      ],
    });
    const v = await simulatedEngine().validate(plan);
    expect(v.ok && v.hashes).toEqual({ structureHash: hex(structure), rulesHash: hex(rules) });
  });

  it("empty bundle hash is 0x010000's; an invalid plan compiles to kind invalid", async () => {
    const r = await simulatedEngine().compile({ plan: { version: "v" }, reference: [] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.manifest.referenceHash).toBe(EMPTY_REFERENCE_DIGEST);
    expect(EMPTY_REFERENCE_DIGEST).toBe(hex(sha("UBC26/reference/v1", Uint8Array.of(1, 0, 0))));
    expect((await simulatedEngine().compile({ plan: [], reference: [] })).ok).toBe(false);
  });
});

describe("cliEngine against the real CLI contract (fake script)", () => {
  it("creates configured compiler temp and cache directories from an empty state root", async () => {
    const state = join(work, "empty-state");
    const temp = join(state, "tmp");
    const cache = join(state, "cache");
    expect(existsSync(state)).toBe(false);
    const engine = cliEngine({
      bin: { command: process.execPath, args: [SCRIPT, "require-dirs"] },
      workDir: join(state, "work"),
      processEnv: { tmpDir: temp, cacheDir: cache },
    });
    const result = await engine.compile({plan: PLAN, reference: []});
    expect(result.ok).toBe(true);
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(cache)).toBe(true);
  });

  it("validate: success returns the engine hashes (lowercased) and preview", async () => {
    const r = await fake("ok").validate(PLAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hashes?.structureHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.hashes?.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.preview).toEqual({ rules: PLAN.rules, version: 1 });
    const c = calls()[0]!;
    expect(c.cmd).toBe("validate");
    expect(JSON.parse(c.plan!)).toEqual(PLAN);
    expect(leftovers()).toEqual([]);
  });

  it("validate: invalid_plan on stderr (exit 2) -> kind invalid with a /plan path", async () => {
    expect(await fake("ok").validate({})).toEqual({
      ok: false,
      kind: "invalid",
      errors: [{ path: "/plan", message: "missing field `version`" }],
    });
  });

  it("validate: unsupported_capability -> kind unsupported carrying the engine's error object verbatim", async () => {
    const plan = { ...PLAN, rules: [{ op: "regex_match" }] };
    expect(await fake("ok").validate(plan)).toEqual({
      ok: false,
      kind: "unsupported",
      capabilityError: {
        code: "unsupported_capability",
        message: 'Unsupported operation "regex_match"',
        path: "/rules/0/op",
        request: { kind: "operation", name: "regex_match" },
      },
    });
  });

  it("eval: writes deliverables and references as loose files and returns the verdict", async () => {
    const r = await fake("ok").eval!({ plan: { ...PLAN, fakeVerdict: 0 }, deliverables: [file("out.json", "{}")], reference: [file("ledger.json", "[]")] });
    expect(r).toEqual({ ok: true, verdict: 0 });
    const c = calls()[0]!;
    expect(c.cmd).toBe("eval");
    expect(c.deliverables).toEqual(["out.json"]);
    expect(c.reference.map((x) => x.n)).toEqual(["ledger.json"]);
  });

  it("eval: a deliverable the engine cannot read -> kind invalid at /deliverables", async () => {
    const r = await fake("ok").eval!({ plan: PLAN, deliverables: [file("bad.json", "{")], reference: [] });
    expect(r.ok === false && r.kind === "invalid" && r.errors[0]).toEqual({
      path: "/deliverables",
      message: "invalid_deliverable: Invalid JSON in bad.json",
    });
  });

  it("compile: writes the exact reference bytes, reads manifest.json, keeps unknown fields, deletes the temp dir", async () => {
    const files = [file("z.txt", "Z"), file("a.txt", "A\u00e9")];
    const r = await fake("ok").compile({ plan: PLAN, reference: files });
    if (!r.ok) throw new Error("expected ok");
    expect(r.manifest.riscZero).toBe("3.1.0");
    expect(r.manifest.inputVersion).toBe(2);
    expect(r.cacheHit).toBe(false);
    expect(r.compileMillis).toBe(7);
    expect(r.packageDir).toBeUndefined();
    const c = calls()[0]!;
    expect(c.reference).toEqual([
      { n: "a.txt", b64: Buffer.from("A\u00e9", "utf8").toString("base64") },
      { n: "z.txt", b64: Buffer.from("Z").toString("base64") },
    ]);
    expect(c.outExisted).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("compile: a reference file the engine rejects -> kind invalid at /references (400, not 502)", async () => {
    const r = await fake("ok").compile({ plan: PLAN, reference: [file("bad.json", "{")] });
    expect(r).toEqual({ ok: false, kind: "invalid", errors: [{ path: "/references", message: "invalid_reference: Invalid JSON in bad.json" }] });
    expect(leftovers()).toEqual([]);
  });

  it("compile with packageDir keeps the whole package there", async () => {
    const dir = join(work, "pkg-keep");
    const r = await fake("ok").compile({ plan: PLAN, reference: [], packageDir: dir });
    if (!r.ok) throw new Error("expected ok");
    expect(r.packageDir).toBe(dir);
    expect(readdirSync(dir).sort()).toEqual(["guest.elf", "manifest.json", "parameters.jcs", "source", "structure.jcs"]);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).imageId).toBe(r.manifest.imageId);
    expect(leftovers()).toEqual([]);
  });

  it("compile refuses an existing packageDir without running the engine", async () => {
    const dir = join(work, "pkg-exists");
    await fake("ok").compile({ plan: PLAN, reference: [], packageDir: dir });
    writeFileSync(log, "");
    const err = await fake("ok").compile({ plan: PLAN, reference: [], packageDir: dir }).then(() => null, (x: unknown) => x);
    expect((err as EngineError).reason).toBe("package_exists");
    expect(calls()).toEqual([]);
  });

  it("compile: uppercase manifest hashes are lowercased", async () => {
    childEnv.FAKE_REFERENCE_HASH = "0x" + "AB".repeat(32);
    const r = await fake("ok").compile({ plan: PLAN, reference: [] });
    expect(r.ok && r.manifest.referenceHash).toBe("0x" + "ab".repeat(32));
  });

  it("reference names that collide case-insensitively are refused before the engine runs", async () => {
    const err = await fake("ok")
      .compile({ plan: PLAN, reference: [file("A.txt", "1"), file("a.txt", "2")] })
      .then(() => null, (x: unknown) => x);
    expect((err as EngineError).reason).toBe("bad_file_name");
    expect(calls()).toEqual([]);
  });

  const failures: [string, string, "validate" | "compile", number?][] = [
    ["crash", "build_failure", "compile"],
    ["exit1", "exit_1", "validate"],
    ["garbage", "bad_output", "validate"],
    ["nomanifest", "no_manifest", "compile"],
    ["badmanifest", "bad_manifest", "compile"],
    ["sleep", "timeout", "validate", 500],
  ];
  for (const [mode, reason, op, timeout] of failures) {
    it(`${mode} -> throws EngineError(${reason})`, async () => {
      const e = fake(mode, timeout);
      const p = op === "validate" ? e.validate(PLAN) : e.compile({ plan: PLAN, reference: [] });
      const err = await p.then(() => null, (x: unknown) => x);
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).reason).toBe(reason);
    });
  }

  it("a missing executable -> EngineError(spawn)", async () => {
    const err = await cliEngine({ bin: SCRIPT + ".does-not-exist" }).validate(PLAN).then(() => null, (x: unknown) => x);
    expect((err as EngineError).reason).toBe("spawn");
  });
});

describe("parseEngineError", () => {
  it("takes the last JSON object line on stderr and ignores build noise", () => {
    const stderr = '#12 exporting\nnot json\n{"code":"build_failure","message":"Guest build failed"}\n';
    expect(parseEngineError(stderr)).toEqual({ code: "build_failure", message: "Guest build failed" });
    expect(parseEngineError("plain text")).toBeNull();
  });
});

describe("WSL mapping", () => {
  it("maps \\\\wsl.localhost, \\\\wsl$ and drive paths; passes POSIX paths through", () => {
    expect(windowsToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\neil\\x y\\a.json", "Ubuntu")).toBe("/home/neil/x y/a.json");
    expect(windowsToWslPath("\\\\wsl$\\Ubuntu\\tmp", "Ubuntu")).toBe("/tmp");
    expect(windowsToWslPath("C:\\Users\\Neil\\a.json", "Ubuntu")).toBe("/mnt/c/Users/Neil/a.json");
    expect(windowsToWslPath("/home/neil", "Ubuntu")).toBe("/home/neil");
    expect(() => windowsToWslPath("\\\\wsl.localhost\\Debian\\x", "Ubuntu")).toThrow(EngineError);
    expect(() => windowsToWslPath("relative\\x", "Ubuntu")).toThrow(EngineError);
  });

  it("runs the engine through wsl.exe -e env with a fixed environment and no shell", () => {
    expect(wslEngineBin({ distro: "Ubuntu", enginePath: "/e/engine", r0vmPath: "/r/r0vm", cacheDir: "/c" })).toEqual({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "-e",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "TMPDIR=/tmp",
        "RISC0_SERVER_PATH=/r/r0vm",
        "UBC26_ENGINE_CACHE=/c",
        "/e/engine",
      ],
    });
  });
});

it("fixture sanity: no stray files are left in the work dir by successful calls", () => {
  expect(existsSync(work)).toBe(true);
});
