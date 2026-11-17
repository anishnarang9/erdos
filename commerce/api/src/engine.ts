// T5/T6 engine boundary. Wraps Anish's engine CLI (engine/README.md on codex/anish-engine, "Connect commerce").
// The CLI writes success JSON to stdout and error JSON `{ code, message, path?, request? }` to stderr.
// Exit 2: argument, input or output error. Exit 3: build, prover or randomness failure.
import { spawn, type ChildProcess } from "node:child_process";
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

/** Pinned compiler PATH. The child does not receive the server PATH. */
export const COMPILER_PATH = "/opt/ubc26/docker-bin:/usr/local/bin:/usr/bin:/bin";
/** Pinned compiler temp directory when the caller does not pass a work or temp directory. */
export const COMPILER_TMPDIR = "/var/lib/ubc26/tmp";
const WSL_GUEST_PATH = "/usr/local/bin:/usr/bin:/bin";
const WSL_ENV_BIN = "/usr/bin/env";
const ENGINE_MAX_BUFFER = 16 * 1024 * 1024;
const ENGINE_KILL_GRACE_MS = 200;
const SSL_ENV_KEYS = ["SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"] as const;
export type SslEnvKey = (typeof SSL_ENV_KEYS)[number];

/**
 * Explicit compiler settings. Values are assigned into a new object.
 * process.env is never copied. Registry credentials and server secrets are not accepted here.
 */
export interface CompilerProcessSettings {
  path?: string;
  tmpDir?: string;
  cacheDir?: string;
  r0vmPath?: string;
  /** Named CA locations only. Other SSL or auth variables are not read. */
  ssl?: Partial<Record<SslEnvKey, string>>;
  /**
   * Extra explicit names. Local tests use this for fake-engine knobs.
   * Passing process.env is rejected. Undefined values are rejected.
   */
  extra?: Record<string, string | undefined>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ABSOLUTE_PIN = /^(?:\/|[A-Za-z]:[\\/])/;
const PIN_META = /[\0\n\r;|&`$<>]/;
const PUBLIC_ASSIGNMENT = /^(PATH|TMPDIR|UBC26_ENGINE_CACHE|RISC0_SERVER_PATH|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS)=([^\0\n\r;|&`$<>]*)$/;

function isAbsolutePin(value: string): boolean {
  return ABSOLUTE_PIN.test(value) && !PIN_META.test(value);
}

/** Rejects a relative command and any wrapper other than the pinned `wsl.exe -e /usr/bin/env -i` form. */
export function assertPublicExecutablePin(bin: EngineBin): void {
  const command = typeof bin === "string" ? bin : bin.command;
  const args = typeof bin === "string" ? [] : [...(bin.args ?? [])];
  if (!isAbsolutePin(command)) throw new Error("Public mode requires an absolute engine executable");
  if (args.length === 0) return;
  const distro = args[1];
  const rest = args.slice(5);
  const enginePath = rest[rest.length - 1];
  const pinnedShape = args[0] === "-d" && args[2] === "-e" && args[3] === WSL_ENV_BIN && args[4] === "-i";
  if (!pinnedShape || !distro || !/^[A-Za-z0-9._-]{1,64}$/.test(distro) || !enginePath || !isAbsolutePin(enginePath)) {
    throw new Error("Public mode rejects an unpinned engine wrapper");
  }
  for (const arg of rest.slice(0, -1)) {
    if (!PUBLIC_ASSIGNMENT.test(arg)) throw new Error("Public mode rejects an unpinned engine wrapper");
  }
}

/** Builds the child environment from explicit settings. It does not inherit the server environment. */
export function compilerProcessEnv(settings: CompilerProcessSettings = {}): Record<string, string> {
  if (settings.extra === process.env) throw new Error("Compiler environment cannot inherit process.env");
  const env: Record<string, string> = {};
  if (settings.extra) {
    for (const [key, value] of Object.entries(settings.extra)) {
      if (!ENV_NAME.test(key) || typeof value !== "string") throw new Error(`Compiler environment name ${key} is not explicit`);
      env[key] = value;
    }
  }
  const ssl = settings.ssl ?? {};
  for (const key of SSL_ENV_KEYS) {
    const value = ssl[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.PATH = settings.path ?? COMPILER_PATH;
  env.TMPDIR = settings.tmpDir ?? COMPILER_TMPDIR;
  if (settings.cacheDir) env.UBC26_ENGINE_CACHE = settings.cacheDir;
  if (settings.r0vmPath) env.RISC0_SERVER_PATH = settings.r0vmPath;
  return env;
}

/** Copies only named CA variables from a configuration map. It does not copy the rest of that map. */
export function explicitSsl(env: Record<string, string | undefined>): Partial<Record<SslEnvKey, string>> | undefined {
  const ssl: Partial<Record<SslEnvKey, string>> = {};
  for (const key of SSL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) ssl[key] = value;
  }
  return Object.keys(ssl).length > 0 ? ssl : undefined;
}

const liveChildren = new Set<ChildProcess>();
let exitHooked = false;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) return;
  // POSIX group id. Windows has no equivalent signal, so the direct child is signalled there.
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct process has already exited.
  }
}

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  const drop = () => liveChildren.delete(child);
  child.on("close", drop);
  child.on("error", drop);
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const current of liveChildren) killProcessGroup(current, "SIGKILL");
  });
}

function spawnEngine(command: string, args: string[], timeout: number, env: Record<string, string>, label: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let used = 0;
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new EngineError("spawn", `Engine ${label} could not be started`));
      return;
    }
    trackChild(child);
    const armKill = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), ENGINE_KILL_GRACE_MS);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      armKill();
    }, timeout);
    const onChunk = (kind: "out" | "err", chunk: Buffer) => {
      if (used + chunk.length > ENGINE_MAX_BUFFER) {
        timedOut = true;
        killProcessGroup(child, "SIGKILL");
        return;
      }
      used += chunk.length;
      const text = chunk.toString("utf8");
      if (kind === "out") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk: Buffer) => onChunk("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onChunk("err", chunk));
    child.on("error", () => {
      clearTimeout(killTimer);
      finish(() => reject(new EngineError("spawn", `Engine ${label} could not be started`)));
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) killProcessGroup(child, "SIGKILL");
      else {
        clearTimeout(killTimer);
        killProcessGroup(child, "SIGKILL");
      }
      if (timedOut || signal) finish(() => reject(new EngineError("timeout", `Engine ${label} timed out or was killed`)));
      else if (typeof code === "number") finish(() => resolve({ exit: code, stdout, stderr }));
      else finish(() => reject(new EngineError("spawn", `Engine ${label} could not be started`)));
    });
  });
}

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
  /** Public mode requires an absolute executable and the pinned WSL wrapper. Default local. */
  pin?: "public" | "local";
  /**
   * Explicit extra child variables, read at each spawn. Local tests pass fake-engine knobs here.
   * This is not an inheritance list. Do not pass process.env.
   */
  env?: Record<string, string>;
  /** Explicit PATH, temp, cache, prover, and CA settings. Omitted fields use pinned defaults. */
  processEnv?: CompilerProcessSettings;
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
  if (opts.pin === "public") {
    assertPublicExecutablePin(opts.bin);
    if (opts.env && Object.values(opts.env).some((value) => value !== undefined)) {
      throw new Error("Public mode rejects extra compiler environment names");
    }
  }
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const compileTimeoutMs = opts.compileTimeoutMs ?? 30 * 60_000;
  const command = typeof opts.bin === "string" ? opts.bin : opts.bin.command;
  const prefix = typeof opts.bin === "string" ? [] : (opts.bin.args ?? []);
  const ep = opts.toEnginePath ?? ((p: string) => p);
  const childEnv = (): Record<string, string> => {
    if (opts.env === process.env) throw new Error("Compiler environment cannot inherit process.env");
    return compilerProcessEnv({
      path: opts.processEnv?.path,
      tmpDir: opts.processEnv?.tmpDir ?? opts.workDir ?? tmpdir(),
      ...(opts.processEnv?.cacheDir ? { cacheDir: opts.processEnv.cacheDir } : {}),
      ...(opts.processEnv?.r0vmPath ? { r0vmPath: opts.processEnv.r0vmPath } : {}),
      ...(opts.processEnv?.ssl ? { ssl: opts.processEnv.ssl } : {}),
      ...(opts.env ? { extra: opts.env } : {}),
    });
  };

  const run = (args: string[], timeout: number): Promise<RunResult> =>
    spawnEngine(command, [...prefix, ...args], timeout, childEnv(), args[0] ?? "command");

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
  if (p.startsWith("/")) return p;
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
  /** Linux temp directory inside the guest. A non-POSIX value stays on the host side only. */
  tmpDir?: string;
  /** Named CA locations for the guest. */
  ssl?: Partial<Record<SslEnvKey, string>>;
  /** Absolute path of wsl.exe. The default name is a local PATH lookup and is not a public pin. */
  wslBin?: string;
  /** Public mode checks the executable and the wrapper before the first spawn. */
  pin?: "public" | "local";
  /** Host path for temporary directories. Prefer one on the WSL filesystem (case-sensitive, fast). */
  workDir?: string;
  timeoutMs?: number;
  compileTimeoutMs?: number;
}

/** The `wsl.exe` invocation that runs the engine with a clean guest environment and no shell. */
export function wslEngineBin(o: Pick<WslEngineOptions, "distro" | "enginePath" | "r0vmPath" | "cacheDir" | "tmpDir" | "ssl" | "wslBin">): EngineBin {
  const guest = compilerProcessEnv({
    path: WSL_GUEST_PATH,
    tmpDir: o.tmpDir && o.tmpDir.startsWith("/") ? o.tmpDir : "/tmp",
    ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}),
    ...(o.r0vmPath ? { r0vmPath: o.r0vmPath } : {}),
    ...(o.ssl ? { ssl: o.ssl } : {}),
  });
  const assignments = ["PATH", "TMPDIR", "RISC0_SERVER_PATH", "UBC26_ENGINE_CACHE", ...SSL_ENV_KEYS]
    .filter((key) => Object.hasOwn(guest, key))
    .map((key) => `${key}=${guest[key]}`);
  return { command: o.wslBin ?? "wsl.exe", args: ["-d", o.distro, "-e", WSL_ENV_BIN, "-i", ...assignments, o.enginePath] };
}

export function wslEngine(o: WslEngineOptions): Engine {
  return cliEngine({
    bin: wslEngineBin(o),
    ...(o.pin ? { pin: o.pin } : {}),
    processEnv: {
      path: COMPILER_PATH,
      tmpDir: o.workDir ?? tmpdir(),
    },
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
  /** Explicit compiler temp directory (ENGINE_TMPDIR). Not inherited as part of the server environment. */
  tmpDir?: string;
  /** Absolute wsl.exe path (ENGINE_WSL_BIN). */
  wslBin?: string;
  ssl?: Partial<Record<SslEnvKey, string>>;
}

/**
 * Reads ENGINE_MODE (wsl | native | simulated), ENGINE_PATH, ENGINE_WSL_DISTRO (default Ubuntu), ENGINE_R0VM,
 * ENGINE_CACHE, ENGINE_WORK_DIR, ENGINE_TMPDIR, ENGINE_WSL_BIN, and named CA variables. Returns null for
 * simulated (the default). It does not copy the rest of `env`.
 */
export function engineConfigFromEnv(env: Record<string, string | undefined>): EngineEnvConfig | null {
  const mode = env.ENGINE_MODE ?? "simulated";
  if (mode === "simulated") return null;
  if (mode !== "wsl" && mode !== "native") throw new Error(`ENGINE_MODE must be wsl, native or simulated, not ${mode}`);
  if (!env.ENGINE_PATH) throw new Error(`ENGINE_PATH is required when ENGINE_MODE=${mode}`);
  const ssl = explicitSsl(env);
  return {
    mode,
    enginePath: env.ENGINE_PATH,
    distro: env.ENGINE_WSL_DISTRO ?? "Ubuntu",
    ...(env.ENGINE_R0VM ? { r0vmPath: env.ENGINE_R0VM } : {}),
    ...(env.ENGINE_CACHE ? { cacheDir: env.ENGINE_CACHE } : {}),
    ...(env.ENGINE_WORK_DIR ? { workDir: env.ENGINE_WORK_DIR } : {}),
    ...(env.ENGINE_TMPDIR ? { tmpDir: env.ENGINE_TMPDIR } : {}),
    ...(env.ENGINE_WSL_BIN ? { wslBin: env.ENGINE_WSL_BIN } : {}),
    ...(ssl ? { ssl } : {}),
  };
}

/** The engine for a configuration, and the path mapping its callers need for their own files. */
export function engineFromConfig(c: EngineEnvConfig, opts: { pin?: "public" | "local" } = {}): { engine: Engine; label: string; bin: EngineBin; toEnginePath: (p: string) => string } {
  const pin = opts.pin ?? "local";
  if (pin === "public" && !isAbsolutePin(c.enginePath)) throw new Error("ENGINE_PATH must be an absolute path in public mode");
  if (c.mode === "wsl") {
    if (pin === "public" && (!c.wslBin || !isAbsolutePin(c.wslBin))) throw new Error("ENGINE_WSL_BIN must be an absolute path in public mode");
    const toEnginePath = (p: string) => windowsToWslPath(p, c.distro);
    return { engine: wslEngine({ ...c, pin }), label: `wsl:${c.distro}:${c.enginePath}`, bin: wslEngineBin(c), toEnginePath };
  }
  const bin = c.enginePath;
  return {
    engine: cliEngine({
      bin,
      ...(pin === "public" ? { pin } : {}),
      processEnv: {
        path: COMPILER_PATH,
        tmpDir: c.tmpDir ?? c.workDir ?? tmpdir(),
        ...(c.cacheDir ? { cacheDir: c.cacheDir } : {}),
        ...(c.r0vmPath ? { r0vmPath: c.r0vmPath } : {}),
        ...(c.ssl ? { ssl: c.ssl } : {}),
      },
      ...(c.workDir ? { workDir: c.workDir } : {}),
    }),
    label: `native:${c.enginePath}`,
    bin,
    toEnginePath: (p) => p,
  };
}
