// Runs the engine's prove, decrypt and eval commands (engine/README.md, "Compile, prove, and decrypt").
// Fixed argument lists, no shell. The release key is only ever read from the file the engine writes.
import { EngineError, parseEngineError, spawnEngine, type EngineBin, type EngineErrorBody } from "../../api/src/engine.ts";

export class WorkerEngineError extends Error {
  readonly code: string;
  readonly engineError: EngineErrorBody | null;
  constructor(code: string, message: string, engineError: EngineErrorBody | null = null) {
    super(message);
    this.name = "WorkerEngineError";
    this.code = code;
    this.engineError = engineError;
  }
}

export interface EngineRunner {
  /** Maps a path of this process to the path the engine sees. */
  path(hostPath: string): string;
  run(args: string[], timeoutMs: number): Promise<{ exit: number; stdout: string; stderr: string }>;
}

export function engineRunner(bin: EngineBin, toEnginePath: (p: string) => string): EngineRunner {
  const command = typeof bin === "string" ? bin : bin.command;
  const prefix = typeof bin === "string" ? [] : (bin.args ?? []);
  return {
    path: toEnginePath,
    run: async (args, timeoutMs) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid engine timeout");
      const label = args[0] ?? "command";
      try {
        return await spawnEngine(command, [...prefix, ...args], timeoutMs || undefined, process.env, label, undefined, 64 * 1024 * 1024);
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        if (err.reason === "output_too_large") throw new WorkerEngineError(err.reason, `engine ${label} output exceeded the buffer`);
        if (err.reason === "timeout") throw new WorkerEngineError(err.reason, `engine ${label} timed out`);
        throw new WorkerEngineError("spawn", `engine ${label} could not be started`);
      }
    },
  };
}

function stdoutJson(stdout: string, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(stdout.trim()) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new WorkerEngineError("bad_output", `engine ${what} output is not a JSON object`);
}

function failure(what: string, r: { exit: number; stderr: string }): WorkerEngineError {
  const e = parseEngineError(r.stderr);
  return new WorkerEngineError(e?.code ?? `exit_${r.exit}`, `engine ${what} failed${e ? `: ${e.message}` : ` (exit ${r.exit})`}`, e);
}

function outputName(v: unknown, expected: string): string {
  if (v === undefined || v === expected) return expected;
  throw new WorkerEngineError("bad_output", `engine prove reported an unexpected file name ${JSON.stringify(v)}`);
}

export interface ProveOutput {
  verdict: 0 | 1;
  proofFile: string;
  keyFile: string;
  proveMillis: number;
  userCycles: number;
}

/** `engine prove`; writes proof.json and release-key.hex into the new directory `out`. */
export async function prove(
  r: EngineRunner,
  a: { packageDir: string; jobFile: string; deliverablesDir: string; referenceDir: string; outDir: string; evidenceDir?: string },
  timeoutMs = 60 * 60_000,
): Promise<ProveOutput> {
  const args = [
    "prove",
    "--package", r.path(a.packageDir),
    "--job", r.path(a.jobFile),
    "--deliverables", r.path(a.deliverablesDir),
    "--reference", r.path(a.referenceDir),
    ...(a.evidenceDir ? ["--evidence", r.path(a.evidenceDir)] : []),
    "--out", r.path(a.outDir),
  ];
  const res = await r.run(args, timeoutMs);
  if (res.exit !== 0) throw failure("prove", res);
  const o = stdoutJson(res.stdout, "prove");
  if ((o.verdict !== 0 && o.verdict !== 1) || typeof o.proveMillis !== "number" || typeof o.userCycles !== "number") {
    throw new WorkerEngineError("bad_output", "engine prove output lacks verdict, proveMillis or userCycles");
  }
  return {
    verdict: o.verdict,
    // The engine reports file names relative to --out; only its two documented names are accepted.
    proofFile: outputName(o.proofFile, "proof.json"),
    keyFile: outputName(o.keyFile, "release-key.hex"),
    proveMillis: o.proveMillis,
    userCycles: o.userCycles,
  };
}

/** `engine decrypt`; the engine refuses verdict 0 and any key that does not match the commitment. */
export async function decrypt(r: EngineRunner, a: { submission: string; keyFile: string; outDir: string }, timeoutMs = 120_000): Promise<void> {
  const res = await r.run(["decrypt", "--submission", r.path(a.submission), "--key-file", r.path(a.keyFile), "--out", r.path(a.outDir)], timeoutMs);
  if (res.exit !== 0) throw failure("decrypt", res);
}

/** `engine eval`: host-side check before spending a proof. */
export async function evaluate(
  r: EngineRunner,
  a: { planFile: string; deliverablesDir: string; referenceDir: string; evidenceDir?: string; jobFile?: string },
  timeoutMs = 120_000,
): Promise<0 | 1> {
  const res = await r.run(["eval", "--plan", r.path(a.planFile), "--deliverables", r.path(a.deliverablesDir), "--reference", r.path(a.referenceDir),
    ...(a.evidenceDir ? ["--evidence", r.path(a.evidenceDir)] : []),
    ...(a.jobFile ? ["--job", r.path(a.jobFile)] : [])], timeoutMs);
  if (res.exit !== 0) throw failure("eval", res);
  const v = stdoutJson(res.stdout, "eval").verdict;
  if (v !== 0 && v !== 1) throw new WorkerEngineError("bad_output", "engine eval output has no verdict");
  return v;
}
