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
