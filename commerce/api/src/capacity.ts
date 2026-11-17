import type { AuthLimitConfig, TaskQueueConfig } from "./context.ts";

/** Pending-task and auth-issuance caps. These are process admission limits, not host quotas. */

export const TASK_PENDING_GLOBAL_DEFAULT = 100;
export const TASK_PENDING_WALLET_DEFAULT = 20;
export const AUTH_IP_LIMIT_DEFAULT = 20;
export const AUTH_IP_WINDOW_MS = 60_000;

export type { AuthLimitConfig, TaskQueueConfig };

function isPositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Accepts a positive safe integer. Zero is not unlimited. The raw text is never included in the error. */
function readOptional(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive safe integer`);
  const value = Number(raw);
  if (!isPositive(value)) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export function resolveTaskQueue(input: Partial<TaskQueueConfig> | undefined): TaskQueueConfig {
  const config = {
    globalPending: input?.globalPending ?? TASK_PENDING_GLOBAL_DEFAULT,
    pendingPerWallet: input?.pendingPerWallet ?? TASK_PENDING_WALLET_DEFAULT,
  };
  if (!isPositive(config.globalPending) || !isPositive(config.pendingPerWallet)) {
    throw new Error("taskQueue limits must be positive safe integers");
  }
  if (config.pendingPerWallet > config.globalPending) {
    throw new Error("taskQueue.pendingPerWallet cannot exceed globalPending");
  }
  return config;
}

export function taskQueueFromEnv(env: NodeJS.ProcessEnv): TaskQueueConfig {
  return resolveTaskQueue({
    globalPending: readOptional(env, "TASK_PENDING_GLOBAL", TASK_PENDING_GLOBAL_DEFAULT),
    pendingPerWallet: readOptional(env, "TASK_PENDING_PER_WALLET", TASK_PENDING_WALLET_DEFAULT),
  });
}

export function resolveAuthLimit(input: Partial<AuthLimitConfig> | undefined): AuthLimitConfig {
  const config = {
    perIp: input?.perIp ?? AUTH_IP_LIMIT_DEFAULT,
    windowMs: input?.windowMs ?? AUTH_IP_WINDOW_MS,
  };
  if (!isPositive(config.perIp) || !isPositive(config.windowMs)) {
    throw new Error("authLimit.perIp and authLimit.windowMs must be positive safe integers");
  }
  return config;
}

export function authLimitFromEnv(env: NodeJS.ProcessEnv): AuthLimitConfig {
  return resolveAuthLimit({
    perIp: readOptional(env, "AUTH_LIMIT_IP", AUTH_IP_LIMIT_DEFAULT),
    windowMs: readOptional(env, "AUTH_LIMIT_WINDOW_MS", AUTH_IP_WINDOW_MS),
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function exactOrigin(raw: string, name: string, mode: "local" | "public"): string {
  if (raw.length === 0 || raw.includes("*") || /\s/.test(raw)) {
    throw new Error(`${name} must be an exact origin`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an exact origin`);
  }
  if (url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an exact origin`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (mode === "public") {
    if (url.protocol !== "https:" || url.hostname === "" || loopback) {
      throw new Error(`${name} must be an exact https origin in public mode`);
    }
  } else if (url.protocol === "http:") {
    if (!loopback) throw new Error(`${name} must be an exact loopback http origin or https origin in local mode`);
  } else if (url.protocol !== "https:" || url.hostname === "") {
    throw new Error(`${name} must be an exact origin`);
  }
  return url.origin;
}

/** Exact browser allowlist. The service origin is always included. One optional frontend origin may be added. */
export function resolveBrowserAllowlist(input: {
  mode: "local" | "public";
  serviceOrigin: string;
  browserOrigin?: string;
}): readonly string[] {
  const service = exactOrigin(input.serviceOrigin, "SERVICE_ORIGIN", input.mode);
  if (input.browserOrigin === undefined) return [service];
  const extra = exactOrigin(input.browserOrigin, "BROWSER_ORIGIN", input.mode);
  return extra === service ? [service] : [service, extra];
}

export function browserOriginFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.BROWSER_ORIGIN;
  if (raw === undefined) return undefined;
  if (raw.length === 0) throw new Error("BROWSER_ORIGIN must be an exact origin");
  return raw;
}

/** Counts active and waiting paid handlers. Zero is not unlimited. */
export const PAID_COMPILE_LIMIT_DEFAULT = 2;
export function resolvePaidCompileLimit(value = PAID_COMPILE_LIMIT_DEFAULT): number {
  if (!isPositive(value)) throw new Error("paidCompileLimit must be a positive safe integer");
  return value;
}
export function paidCompileLimitFromEnv(env: NodeJS.ProcessEnv): number {
  return readOptional(env, "PAID_COMPILE_LIMIT", PAID_COMPILE_LIMIT_DEFAULT);
}
