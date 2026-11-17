// Public production readiness. File checks read bytes. They do not execute the compiler or call a model.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthoringBudget } from "./context.ts";
import type { OutputTokenBound } from "./grok.ts";

/** The only live model that advertises a total output bound. Reasoning models are not in this set. */
export const REVIEWED_MODEL_ID = "grok-4.20-0309-non-reasoning";
export const REVIEWED_PROMPT_TOKENS = 1_000_000;
export const REVIEWED_OUTPUT_TOKENS = 8192;
export const REVIEWED_INPUT_MICRO_USD_PER_MILLION = 2_500_000;
export const REVIEWED_OUTPUT_MICRO_USD_PER_MILLION = 5_000_000;
/** 1_000_000 input tokens at $2.50 per million plus 8192 output tokens at $5 per million. */
export const REVIEWED_CALL_MICRO_USD = 2_540_960;

export interface ProviderCostBound {
  maxPromptTokens: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
}

export const REVIEWED_PROVIDER_COST: ProviderCostBound = {
  maxPromptTokens: REVIEWED_PROMPT_TOKENS,
  inputMicroUsdPerMillion: REVIEWED_INPUT_MICRO_USD_PER_MILLION,
  outputMicroUsdPerMillion: REVIEWED_OUTPUT_MICRO_USD_PER_MILLION,
};

export interface ReadyCheck {
  name: string;
  ok: boolean;
  reason?: string;
  /** Set when a passing check is an explicit exception rather than a satisfied dependency. */
  state?: "disabled" | "not_used" | "not_required";
  blocksListen: boolean;
}

export interface ReadyReport {
  ready: boolean;
  authoring: "required" | "disabled";
  checks: ReadyCheck[];
}

export interface FilePin {
  path: string;
  /** 64 hex characters. No 0x prefix. Compared without case. */
  sha256?: string;
}

export interface ReadyInput {
  mode: "local" | "public";
  authoring: "required" | "disabled";
  origin: string;
  engine: {
    mode?: "real" | "simulated";
    executable?: FilePin;
    /** Present when public mode starts the compiler through a wrapper. */
    wrapper?: FilePin;
  };
  model: {
    state: "absent" | "replay" | "recording" | "live";
    id?: string;
    outputTokenBound?: OutputTokenBound;
    providerCostBound?: ProviderCostBound;
  };
  budget?: AuthoringBudget;
  chain: "absent" | "arc" | "simulated";
  rateLimit?: { expensivePerPrincipal: number; expensivePerIp: number };
  /** Omitted during the pre-database config gate. */
  database?: {
    durable: boolean;
    writable: boolean;
    applied: string[];
    expected: string[];
  };
  packages?: { path?: string };
  worker: "stopped" | "running" | "draining";
  requireWorker: boolean;
  expensiveDisabled: boolean;
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export function blocksPublicListen(report: ReadyReport): boolean {
  return report.checks.some((check) => check.blocksListen && !check.ok);
}

export function formatReadyFailure(report: ReadyReport): string {
  const failed = report.checks.filter((check) => !check.ok).map((check) => `${check.name} ${check.reason ?? "failed"}`);
  return `Public mode is not ready: ${failed.join(", ")}`;
}

/** Tariff for one reviewed call at the supplied per-million prices. Returns null when the product is not a safe integer. */
export function callMicroUsd(inputRate: number, outputRate: number): number | null {
  const prompt = ceilTokens(REVIEWED_PROMPT_TOKENS, inputRate);
  const output = ceilTokens(REVIEWED_OUTPUT_TOKENS, outputRate);
  if (prompt === null || output === null) return null;
  const sum = prompt + output;
  return Number.isSafeInteger(sum) ? sum : null;
}

function ceilTokens(tokens: number, microUsdPerMillion: number): number | null {
  if (tokens === 0) return 0;
  if (!Number.isSafeInteger(microUsdPerMillion) || microUsdPerMillion <= 0) return null;
  if (tokens > Math.floor(Number.MAX_SAFE_INTEGER / microUsdPerMillion)) return null;
  return Math.ceil((tokens * microUsdPerMillion) / 1_000_000);
}

function check(name: string, ok: boolean, reason: string | undefined, blocksListen: boolean, state?: ReadyCheck["state"]): ReadyCheck {
  return {
    name,
    ok,
    ...(ok ? {} : { reason: reason ?? "failed" }),
    ...(state ? { state } : {}),
    blocksListen: ok ? false : blocksListen,
  };
}

function positiveInt(value: number | undefined): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pinFile(name: string, pin: FilePin | undefined, required: boolean): Promise<ReadyCheck> {
  if (!pin) {
    return required
      ? check(name, false, "unpinned", true)
      : check(name, true, undefined, false, "not_used");
  }
  if (!ABSOLUTE.test(pin.path) || pin.path.includes("\0")) return check(name, false, "not_absolute", true);
  if (!pin.sha256 || !SHA256_HEX.test(pin.sha256)) return check(name, false, "unpinned", true);
  let actual: string;
  try {
    const info = await stat(pin.path);
    if (!info.isFile()) return check(name, false, "unreadable", true);
    actual = await hashFile(pin.path);
  } catch {
    return check(name, false, "unreadable", true);
  }
  if (actual.toLowerCase() !== pin.sha256.toLowerCase()) return check(name, false, "digest_mismatch", true);
  return check(name, true, undefined, false);
}

async function packagesWritable(path: string | undefined, required: boolean): Promise<ReadyCheck> {
  if (!path) {
    return required
      ? check("packages", false, "unconfigured", true)
      : check("packages", true, undefined, false, "not_required");
  }
  if (!ABSOLUTE.test(path) || path.includes("\0")) return check("packages", false, "not_absolute", true);
  const probe = join(path, `.ready-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 16)}`);
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return check("packages", false, "not_writable", true);
    await writeFile(probe, "ok", { flag: "wx" });
    await rm(probe, { force: true });
    return check("packages", true, undefined, false);
  } catch {
    await rm(probe, { force: true }).catch(() => undefined);
    return check("packages", false, "not_writable", true);
  }
}

function originCheck(origin: string): ReadyCheck {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return check("origin", false, "not_https", true);
  }
  if (url.username !== "" || url.password !== "") return check("origin", false, "origin_has_credentials", true);
  if (url.protocol !== "https:" || url.hostname === "") return check("origin", false, "not_https", true);
  return check("origin", true, undefined, false);
}

function budgetCheck(budget: AuthoringBudget | undefined, required: boolean): ReadyCheck {
  if (!budget) {
    return required
      ? check("budget", false, "missing", true)
      : check("budget", true, undefined, false, "not_required");
  }
  const fields = [
    budget.requestCeilingMicroUsd,
    budget.dailyCeilingMicroUsd,
    budget.inputMicroUsdPerMillion,
    budget.outputMicroUsdPerMillion,
  ];
  if (fields.some((value) => !positiveInt(value))) return check("budget", false, "invalid", true);
  if (budget.cachedInputMicroUsdPerMillion !== undefined) {
    if (!positiveInt(budget.cachedInputMicroUsdPerMillion)) return check("budget", false, "invalid", true);
    if (budget.cachedInputMicroUsdPerMillion > budget.inputMicroUsdPerMillion) return check("budget", false, "cached_rate_above_input", true);
  }
  if (budget.inputMicroUsdPerMillion < REVIEWED_INPUT_MICRO_USD_PER_MILLION) return check("budget", false, "input_rate_below_provider", true);
  if (budget.outputMicroUsdPerMillion < REVIEWED_OUTPUT_MICRO_USD_PER_MILLION) return check("budget", false, "output_rate_below_provider", true);
  const call = callMicroUsd(budget.inputMicroUsdPerMillion, budget.outputMicroUsdPerMillion);
  if (call === null || budget.requestCeilingMicroUsd < call) return check("budget", false, "below_call", true);
  if (budget.dailyCeilingMicroUsd < budget.requestCeilingMicroUsd) return check("budget", false, "daily_below_request", true);
  return required
    ? check("budget", true, undefined, false)
    : check("budget", true, undefined, false, "not_required");
}

interface ProbeDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(): unknown };
  isTransaction: boolean;
}

/** Confirms a durable path, a write transaction, and applied migration names. It does not report the path. */
export function probeDatabase(db: ProbeDb, path: string): { durable: boolean; writable: boolean; applied: string[] } {
  const durable = path.length > 0 && path !== ":memory:";
  let writable = false;
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    db.exec("ROLLBACK");
    writable = true;
  } catch {
    if (began && db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The probe could not end the transaction it started.
      }
    }
    writable = false;
  }
  let applied: string[] = [];
  try {
    const rows = db.prepare("SELECT version FROM schema_migrations").all();
    if (Array.isArray(rows)) {
      applied = rows.flatMap((row) => {
        if (!row || typeof row !== "object" || !("version" in row)) return [];
        const version = (row as { version: unknown }).version;
        return typeof version === "string" ? [version] : [];
      });
    }
  } catch {
    applied = [];
  }
  return { durable, writable, applied };
}

function modelCheck(input: ReadyInput): ReadyCheck {
  const model = input.model;
  if (model.state === "replay") return check("model", false, "replay_model", true);
  if (model.state === "recording") return check("model", false, "recording_model", true);
  if (model.state === "absent") {
    return input.authoring === "disabled"
      ? check("model", true, undefined, false, "disabled")
      : check("model", false, "missing", true);
  }
  if (model.id !== REVIEWED_MODEL_ID) return check("model", false, "unreviewed_model", true);
  const output = model.outputTokenBound;
  if (!output || output.parameter !== "max_tokens" || output.maxTokens !== REVIEWED_OUTPUT_TOKENS) {
    return check("model", false, "output_bound_unreliable", true);
  }
  const cost = model.providerCostBound;
  if (!cost
    || cost.maxPromptTokens !== REVIEWED_PROVIDER_COST.maxPromptTokens
    || cost.inputMicroUsdPerMillion !== REVIEWED_PROVIDER_COST.inputMicroUsdPerMillion
    || cost.outputMicroUsdPerMillion !== REVIEWED_PROVIDER_COST.outputMicroUsdPerMillion) {
    return check("model", false, "context_bound_unreliable", true);
  }
  return check("model", true, undefined, false);
}

function databaseCheck(input: ReadyInput): ReadyCheck[] {
  if (!input.database) return [];
  const durable = input.database.durable
    ? check("database", true, undefined, false)
    : check("database", false, "not_durable", true);
  const writable = input.database.writable
    ? check("database_write", true, undefined, false)
    : check("database_write", false, "not_writable", true);
  const missing = input.database.expected.filter((version) => !input.database?.applied.includes(version));
  const migrations = missing.length === 0
    ? check("migrations", true, undefined, false)
    : check("migrations", false, `missing:${missing.join(",")}`, true);
  return [durable, writable, migrations];
}

/** Reads pinned files and the package directory. It does not spawn a compiler or call a model. Disk quotas are not judged. */
export async function evaluateReady(input: ReadyInput): Promise<ReadyReport> {
  const publicMode = input.mode === "public";
  const engineMode = input.engine.mode === "real"
    ? check("engine", true, undefined, false)
    : check("engine", false, "simulated_engine", true);
  const executable = await pinFile("engine_executable", input.engine.executable, publicMode && input.engine.mode === "real");
  const wrapper = await pinFile("compiler_wrapper", input.engine.wrapper, publicMode && input.engine.wrapper !== undefined);
  const origin = originCheck(input.origin);
  const chain = input.chain === "arc"
    ? check("chain", true, undefined, false)
    : check("chain", false, input.chain === "simulated" ? "simulated_chain" : "missing", true);
  const model = modelCheck(input);
  const budget = budgetCheck(input.budget, input.authoring === "required");
  const rates = input.rateLimit && positiveInt(input.rateLimit.expensivePerPrincipal) && positiveInt(input.rateLimit.expensivePerIp)
    ? check("rate_limit", true, undefined, false)
    : check("rate_limit", false, "invalid", true);
  const packages = await packagesWritable(input.packages?.path, publicMode);
  const expensive = input.expensiveDisabled
    ? check("expensive_ops", false, "disabled", false)
    : check("expensive_ops", true, undefined, false);
  const worker = !input.requireWorker || input.worker === "running"
    ? check("worker", true, undefined, false, input.worker === "running" ? undefined : "not_required")
    : check("worker", false, input.worker === "draining" ? "draining" : "stopped", false);
  const checks = [
    engineMode,
    executable,
    wrapper,
    origin,
    chain,
    model,
    budget,
    rates,
    packages,
    ...databaseCheck(input),
    expensive,
    worker,
  ].map((item) => publicMode ? item : { ...item, blocksListen: false });
  return {
    ready: checks.every((item) => item.ok),
    authoring: input.authoring,
    checks,
  };
}

/** Writes a throwaway file under the system temp directory. Tests use it to prove a pin without executing the file. */
export async function scratchFile(bytes: Buffer): Promise<{ dir: string; path: string; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ubc26-ready-"));
  const path = join(dir, "pinned.bin");
  await writeFile(path, bytes);
  return { dir, path, sha256: createHash("sha256").update(bytes).digest("hex") };
}
