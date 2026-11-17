// T5/T6 engine boundary. Wraps Anish's engine CLI (engine/README.md on codex/anish-engine, "Connect commerce").
// The CLI writes success JSON to stdout and error JSON `{ code, message, path?, request? }` to stderr.
// Exit 2: argument, input or output error. Exit 3: build, prover or randomness failure.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import type { Hex } from "viem";
import { encodeBundle, referenceHash, type BundleFile } from "@ubc26/sdk";
import { simulatedValidatePlan } from "./revision.ts";

/**
 * The package manifest. The four commitment hashes are required and lowercased; every other field the
 * engine writes (version, inputVersion, guestSha256, parametersSha256, structureSha256, guestBuilder,
 * riscZero, buildFingerprint) is kept as is.
 */
export type Manifest = {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  structureHash: Hex;
} & Record<string, unknown>;

/** Commitments returned by `engine validate`; the approval binds them. */
export interface PlanHashes {
  structureHash: string;
  rulesHash: string;
}

export type ValidateResult =
  | { ok: true; hashes?: PlanHashes; preview?: unknown }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };

export type EvalResult =
  | { ok: true; verdict: 0 | 1 }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };

// Private result identity: mode and manifest.toolchain are caller-writable and cannot attest CLI execution.
const cliCompileResults = new WeakSet<object>();
export function isCliCompileResult(result: CompileResult): boolean {
  return cliCompileResults.has(result);
}

export type CompileResult =
  | { ok: true; manifest: Manifest; packageDir?: string; cacheHit?: boolean; compileMillis?: number }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };

export interface CompileInput {
  plan: unknown;
  reference: BundleFile[];
  /**
   * Where to keep the compiled package. It must not exist yet; the engine publishes it atomically.
   * Omitted: the package is compiled in a temporary directory and deleted after the manifest is read.
   */
  packageDir?: string;
}

export interface Engine {
  /** Explicit execution provenance. Unidentified embedded engines are allowed only off real chains. */
  readonly mode?: "real" | "simulated";
  validate(plan: unknown): Promise<ValidateResult>;
  /** Host-side check of example deliverables (`engine eval`). Optional: absent means examples stay unlabelled. */
  eval?(input: { plan: unknown; deliverables: BundleFile[]; reference: BundleFile[] }): Promise<EvalResult>;
  /** Throws EngineError on a crash, a timeout, or a build failure. */
  compile(input: CompileInput): Promise<CompileResult>;
}

/** Engine crash, timeout, build or prover failure, or unparseable output. Routes map it to 502 engine_failed. */
export class EngineError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.reason = reason;
  }
}

const HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Shape check for a manifest (also used by the compile route as a backstop). Unknown fields are kept. */
export const manifestSchema = z.looseObject({
  imageId: HASH,
  rulesHash: HASH,
  referenceHash: HASH,
  structureHash: HASH,
});

/** Parses a manifest and lowercases the four commitment hashes; throws EngineError when malformed. */
export function parseManifest(raw: unknown): Manifest {
  const r = manifestSchema.safeParse(raw);
  if (!r.success) throw new EngineError("bad_manifest", "Engine manifest lacks imageId, rulesHash, referenceHash or structureHash");
  const m = r.data;
  const lower = (h: string) => h.toLowerCase() as Hex;
  return {
    ...m,
    imageId: lower(m.imageId),
    rulesHash: lower(m.rulesHash),
    referenceHash: lower(m.referenceHash),
    structureHash: lower(m.structureHash),
  };
}

// ---------------------------------------------------------------------------------------------------
// simulatedEngine (tests and offline demos only; every manifest says engine "simulated")

function sha(...parts: (Uint8Array | string)[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
  return h.digest();
}

function hex0x(b: Uint8Array): Hex {
  return ("0x" + Buffer.from(b).toString("hex")) as Hex;
}

function jcs(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) throw new EngineError("not_canonical", "plan cannot be canonicalized (JCS)");
  return s;
}

/**
 * SIMULATED. Hashes are NOT the engine's: structureHash = SHA256("UBC26/structure/v1" || JCS(structure ?? plan)),
 * rulesHash = SHA256("UBC26/rules/v1" || structureHash || SHA256(JCS(parameters ?? {}))). referenceHash is the
 * real SDK reference hash. Use cliEngine for anything that is proved.
 */
export function simulatedEngine(): Engine {
  const hashesOf = (plan: unknown): PlanHashes => {
    const p = plan as Record<string, unknown>;
    const structure = sha("UBC26/structure/v1", jcs(p.structure ?? p));
    const params = sha(jcs(p.parameters ?? {}));
    return { structureHash: hex0x(structure), rulesHash: hex0x(sha("UBC26/rules/v1", structure, params)) };
  };
  return {
    mode: "simulated",
    async validate(plan) {
      const v = await simulatedValidatePlan(plan);
      return v.ok ? { ok: true, hashes: hashesOf(plan) } : v;
    },
    async compile({ plan, reference }) {
      const v = await simulatedValidatePlan(plan);
      if (!v.ok) return v;
      const { structureHash, rulesHash } = hashesOf(plan);
      const sorted = [...reference].sort((a, b) => Buffer.compare(Buffer.from(a.name, "latin1"), Buffer.from(b.name, "latin1")));
      return {
        ok: true,
        manifest: {
          imageId: hex0x(sha("SIMULATED/image/v1", Buffer.from(structureHash.slice(2), "hex"))),
          rulesHash: rulesHash as Hex,
          referenceHash: referenceHash(encodeBundle(reference)).toLowerCase() as Hex,
          structureHash: structureHash as Hex,
          toolchain: { engine: "simulated" },
          files: sorted.map((f) => ({ name: f.name, sha256: hex0x(sha(f.content)) })),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// cliEngine

/**
 * How to start the engine CLI. A string is the path of an executable run directly. The object form runs
 * `command` with `args` before the engine arguments, e.g. `{ command: "wsl.exe", args: ["-e", "/path/engine"] }`.
 * No shell is ever used.
 */
export type EngineBin = string | { command: string; args?: string[] };

export interface CliEngineOptions {
  bin: EngineBin;
  /** Parent directory for per-call temporary directories, as a path this process can write. Defaults to os.tmpdir(). */
  workDir?: string;
  /** Maps a path of this process to the path the engine sees (e.g. Windows to WSL). Defaults to identity. */
  toEnginePath?: (hostPath: string) => string;
  /** validate and eval timeout. Default 60 s. */
  timeoutMs?: number;
  /** compile timeout (a cold guest build runs Docker). Default 30 min. */
  compileTimeoutMs?: number;
}

/** One engine error object from stderr. */
export interface EngineErrorBody {
  code: string;
  message: string;
  path?: string;
  request?: { kind: string; name: string };
}

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Parses the last JSON object on stderr; null when there is none. */
export function parseEngineError(stderr: string): EngineErrorBody | null {
  const lines = stderr.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as unknown;
      if (typeof v === "object" && v !== null && typeof (v as EngineErrorBody).code === "string") {
        const o = v as Record<string, unknown>;
        return {
          code: o.code as string,
          message: typeof o.message === "string" ? o.message : "",
          ...(typeof o.path === "string" ? { path: o.path } : {}),
          ...(typeof o.request === "object" && o.request !== null ? { request: o.request as EngineErrorBody["request"] } : {}),
        };
      }
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

function parseStdoutObject(stdout: string, what: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new EngineError("bad_output", `Engine ${what} output is not JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EngineError("bad_output", `Engine ${what} output is not a JSON object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Maps a failed run. Plan errors become typed results; anything else (exit 3, unknown codes, no JSON)
 * throws EngineError with the engine's code as the reason. `inputErrorPath` names where input errors
 * (bad deliverable or reference files) are reported, or undefined to treat them as engine failures.
 */
function planFailure(
  r: RunResult,
  what: string,
  inputErrorPath?: string,
): { ok: false; kind: "invalid"; errors: { path: string; message: string }[] } | { ok: false; kind: "unsupported"; capabilityError: unknown } {
  const e = parseEngineError(r.stderr);
  if (r.exit === 2 && e) {
    if (e.code === "unsupported_capability") return { ok: false, kind: "unsupported", capabilityError: e };
    if (e.code === "invalid_plan") {
      return { ok: false, kind: "invalid", errors: [{ path: "/plan" + (e.path ?? ""), message: e.message }] };
    }
    if (inputErrorPath && ["invalid_deliverable", "invalid_reference", "bundle_input"].includes(e.code)) {
      return { ok: false, kind: "invalid", errors: [{ path: inputErrorPath, message: `${e.code}: ${e.message}` }] };
    }
  }
  throw new EngineError(e?.code ?? `exit_${r.exit}`, `Engine ${what} failed${e ? `: ${e.message}` : ` with exit code ${r.exit}`}`);
}

function hashOf(o: Record<string, unknown>, key: string): Hex {
  const v = o[key];
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new EngineError("bad_output", `Engine validate output has no ${key}`);
  }
  return v.toLowerCase() as Hex;
}

/** Writes files into a new directory `dir`. Names must already satisfy the bundle name rule. */
async function writeFiles(dir: string, files: BundleFile[]): Promise<void> {
  await mkdir(dir);
  const seen = new Set<string>();
  for (const f of files) {
    const folded = f.name.toLowerCase();
    if (!SAFE_NAME.test(f.name) || f.name === "." || f.name === ".." || seen.has(folded)) {
      throw new EngineError("bad_file_name", `File name ${JSON.stringify(f.name)} cannot be written for the engine`);
    }
    seen.add(folded);
    await writeFile(join(dir, f.name), f.content);
  }
}

/** Runs the real engine CLI. Each call works in a fresh temporary directory that is deleted afterwards. */
export function cliEngine(opts: CliEngineOptions): Engine {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const compileTimeoutMs = opts.compileTimeoutMs ?? 30 * 60_000;
  const command = typeof opts.bin === "string" ? opts.bin : opts.bin.command;
  const prefix = typeof opts.bin === "string" ? [] : (opts.bin.args ?? []);
  const ep = opts.toEnginePath ?? ((p: string) => p);

  const run = (args: string[], timeout: number): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...prefix, ...args],
        { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8", shell: false },
        (err, stdout, stderr) => {
          if (!err) return resolve({ exit: 0, stdout, stderr });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown; signal?: unknown };
          if (e.killed || e.signal) reject(new EngineError("timeout", `Engine ${args[0]} timed out or was killed`));
          else if (typeof e.code === "number") resolve({ exit: e.code, stdout, stderr });
          else reject(new EngineError("spawn", `Engine ${args[0]} could not be started`));
        },
      );
    });

  const withTemp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const parent = opts.workDir ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, "ubc26-engine-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const writePlan = async (dir: string, plan: unknown): Promise<string> => {
    const file = join(dir, "plan.json");
    await writeFile(file, JSON.stringify(plan), "utf8");
    return file;
  };

  return {
    mode: "real",
    validate: (plan) =>
      withTemp(async (dir) => {
        const r = await run(["validate", "--plan", ep(await writePlan(dir, plan))], timeoutMs);
        if (r.exit !== 0) return planFailure(r, "validate");
        const o = parseStdoutObject(r.stdout, "validate");
        return { ok: true, hashes: { structureHash: hashOf(o, "structureHash"), rulesHash: hashOf(o, "rulesHash") }, preview: o.preview };
      }),

    eval: ({ plan, deliverables, reference }) =>
      withTemp(async (dir) => {
        const planFile = await writePlan(dir, plan);
        const del = join(dir, "deliverables");
        const ref = join(dir, "reference");
        await writeFiles(del, deliverables);
        await writeFiles(ref, reference);
        const r = await run(["eval", "--plan", ep(planFile), "--deliverables", ep(del), "--reference", ep(ref)], timeoutMs);
        if (r.exit !== 0) return planFailure(r, "eval", "/deliverables");
        const v = parseStdoutObject(r.stdout, "eval").verdict;
        if (v !== 0 && v !== 1) throw new EngineError("bad_output", "Engine eval output has no verdict 0 or 1");
        return { ok: true, verdict: v };
      }),

    compile: ({ plan, reference, packageDir }) =>
      withTemp(async (dir) => {
        const planFile = await writePlan(dir, plan);
        const ref = join(dir, "reference");
        await writeFiles(ref, reference);
        const out = packageDir ?? join(dir, "package");
        if (await stat(out).then(() => true, () => false)) {
          throw new EngineError("package_exists", "The package directory already exists");
        }
        const r = await run(["compile", "--plan", ep(planFile), "--reference", ep(ref), "--out", ep(out)], compileTimeoutMs);
        if (r.exit !== 0) return planFailure(r, "compile", "/references");
        const report = parseStdoutObject(r.stdout, "compile");
        let text: string;
        try {
          text = await readFile(join(out, "manifest.json"), "utf8");
        } catch {
          throw new EngineError("no_manifest", "Engine compile did not write manifest.json");
        }
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new EngineError("bad_manifest", "manifest.json is not JSON");
        }
        const result: CompileResult = {
          ok: true,
          manifest: parseManifest(raw),
          ...(packageDir ? { packageDir } : {}),
          ...(typeof report.cacheHit === "boolean" ? { cacheHit: report.cacheHit } : {}),
          ...(typeof report.compileMillis === "number" ? { compileMillis: report.compileMillis } : {}),
        };
        cliCompileResults.add(result);
        return result;
      }),
  };
}

// ---------------------------------------------------------------------------------------------------
// WSL2 (the engine and prover run in Linux; the API may run on Windows)

/**
 * Maps a Windows path to the path WSL sees: `\\wsl.localhost\<distro>\a\b` and `\\wsl$\<distro>\a\b` to
 * `/a/b`, and `C:\a\b` to `/mnt/c/a/b`. POSIX paths pass through. Anything else throws.
 */
export function windowsToWslPath(p: string, distro: string): string {
  if (p.startsWith("/") && !p.startsWith("//")) return p;
  const unc = p.replace(/\//g, "\\");
  for (const root of [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]) {
    if (unc.toLowerCase() === root.toLowerCase()) return "/";
    if (unc.toLowerCase().startsWith(root.toLowerCase() + "\\")) return unc.slice(root.length).replace(/\\/g, "/");
  }
  const drive = /^([A-Za-z]):\\(.*)$/.exec(unc);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}`;
  throw new EngineError("bad_path", `Cannot map ${p} into WSL`);
}

export interface WslEngineOptions {
  distro: string;
  /** Linux path of the engine binary. */
  enginePath: string;
  /** Linux path of r0vm 3.1.0 (needed by prove only). */
  r0vmPath?: string;
  /** Linux path of the engine build cache (UBC26_ENGINE_CACHE). */
  cacheDir?: string;
  /** Host path for temporary directories. Prefer one on the WSL filesystem (case-sensitive, fast). */
  workDir?: string;
  timeoutMs?: number;
  compileTimeoutMs?: number;
}

/** The `wsl.exe` invocation that runs the engine with a fixed environment and no shell. */
export function wslEngineBin(o: Pick<WslEngineOptions, "distro" | "enginePath" | "r0vmPath" | "cacheDir">): EngineBin {
  const env = [
    ...(o.r0vmPath ? [`RISC0_SERVER_PATH=${o.r0vmPath}`] : []),
    ...(o.cacheDir ? [`UBC26_ENGINE_CACHE=${o.cacheDir}`] : []),
  ];
  return { command: "wsl.exe", args: ["-d", o.distro, "-e", "env", "-u", "RISC0_DEV_MODE", "-u", "RUST_LOG", ...env, o.enginePath] };
}

export function wslEngine(o: WslEngineOptions): Engine {
  return cliEngine({
    bin: wslEngineBin(o),
    toEnginePath: (p) => windowsToWslPath(p, o.distro),
    ...(o.workDir ? { workDir: o.workDir } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.compileTimeoutMs ? { compileTimeoutMs: o.compileTimeoutMs } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------
// Configuration from the environment (server, integration tests, worker)

export interface EngineEnvConfig {
  mode: "wsl" | "native";
  enginePath: string;
  distro: string;
  r0vmPath?: string;
  cacheDir?: string;
  workDir?: string;
}

/**
 * Reads ENGINE_MODE (wsl | native | simulated), ENGINE_PATH, ENGINE_WSL_DISTRO (default Ubuntu), ENGINE_R0VM,
 * ENGINE_CACHE and ENGINE_WORK_DIR. Returns null for simulated (the default); throws on a bad configuration.
 */
export function engineConfigFromEnv(env: Record<string, string | undefined>): EngineEnvConfig | null {
  const mode = env.ENGINE_MODE ?? "simulated";
  if (mode === "simulated") return null;
  if (mode !== "wsl" && mode !== "native") throw new Error(`ENGINE_MODE must be wsl, native or simulated, not ${mode}`);
  if (!env.ENGINE_PATH) throw new Error(`ENGINE_PATH is required when ENGINE_MODE=${mode}`);
  const wd = env.ENGINE_WORK_DIR;
  // A .env parser can collapse a leading "\\" to "\", which silently turns a UNC path into a drive-relative one.
  if (wd && /^[\\/](?![\\/])wsl(\.localhost|\$)/i.test(wd)) {
    throw new Error(`ENGINE_WORK_DIR ${wd} lost its leading UNC separator; write it as //wsl.localhost/<distro>/...`);
  }
  return {
    mode,
    enginePath: env.ENGINE_PATH,
    distro: env.ENGINE_WSL_DISTRO ?? "Ubuntu",
    ...(env.ENGINE_R0VM ? { r0vmPath: env.ENGINE_R0VM } : {}),
    ...(env.ENGINE_CACHE ? { cacheDir: env.ENGINE_CACHE } : {}),
    ...(env.ENGINE_WORK_DIR ? { workDir: env.ENGINE_WORK_DIR } : {}),
  };
}

/** The engine for a configuration, and the path mapping its callers need for their own files. */
export function engineFromConfig(c: EngineEnvConfig): { engine: Engine; label: string; bin: EngineBin; toEnginePath: (p: string) => string } {
  if (c.mode === "wsl") {
    const toEnginePath = (p: string) => windowsToWslPath(p, c.distro);
    return { engine: wslEngine(c), label: `wsl:${c.distro}:${c.enginePath}`, bin: wslEngineBin(c), toEnginePath };
  }
  const bin = c.enginePath;
  return { engine: cliEngine({ bin, ...(c.workDir ? { workDir: c.workDir } : {}) }), label: `native:${c.enginePath}`, bin, toEnginePath: (p) => p };
}
