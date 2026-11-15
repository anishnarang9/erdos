// Runs the engine's prove, decrypt and eval commands (engine/README.md, "Compile, prove, and decrypt").
// Fixed argument lists, no shell. The release key is only ever read from the file the engine writes.
import { execFile } from "node:child_process";
import { parseEngineError, type EngineBin, type EngineErrorBody } from "@ubc26/api";

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
    run: (args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(
          command,
          [...prefix, ...args],
          { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8", shell: false },
          (err, stdout, stderr) => {
            if (!err) return resolve({ exit: 0, stdout, stderr });
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: unknown; code?: unknown };
            if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new WorkerEngineError("output_too_large", `engine ${args[0]} output exceeded the buffer`));
            else if (e.killed || e.signal) reject(new WorkerEngineError("timeout", `engine ${args[0]} timed out`));
            else if (typeof e.code === "number") resolve({ exit: e.code, stdout, stderr });
            else reject(new WorkerEngineError("spawn", `engine ${args[0]} could not be started`));
          },
        );
      }),
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
  a: { planFile: string; deliverablesDir: string; referenceDir: string },
  timeoutMs = 120_000,
): Promise<0 | 1> {
  const res = await r.run(["eval", "--plan", r.path(a.planFile), "--deliverables", r.path(a.deliverablesDir), "--reference", r.path(a.referenceDir)], timeoutMs);
  if (res.exit !== 0) throw failure("eval", res);
  const v = stdoutJson(res.stdout, "eval").verdict;
  if (v !== 0 && v !== 1) throw new WorkerEngineError("bad_output", "engine eval output has no verdict");
  return v;
}
