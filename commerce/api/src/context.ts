import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";
import type { Db } from "./db.ts";
import type { PlanValidator } from "./revision.ts";
import type { Engine } from "./engine.ts";
import type { DraftModel } from "./grok.ts";
import type { ApiChain } from "./chain.ts";

import type { CompileAdmission } from "./compile-admission.ts";
import type { BotReviewConfig } from "./bot-review-types.ts";

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export type Principal =
  | { kind: "legacy" }
  | { kind: "wallet"; wallet: string; keyId: string; scopes: string[] };

export interface DeploymentConfig {
  mode: "local" | "public";
  /** Origin bound into wallet challenge messages. */
  serviceOrigin: string;
  /** Exact browser origins. CORS does not authenticate a wallet. */
  browserOrigins: readonly string[];
  /** When true, the first X-Forwarded-For hop is the client IP for rate limits. */
  trustProxy: boolean;
}

export interface RateLimitConfig {
  /** 0 disables this dimension. */
  expensivePerPrincipal: number;
  expensivePerIp: number;
  windowMs?: number;
}

/** Caps queued and running tasks. Zero is not a supported unlimited setting. */
export interface TaskQueueConfig {
  globalPending: number;
  pendingPerWallet: number;
}

/** Caps challenge and key issuance per client IP. Zero is not a supported unlimited setting. */
export interface AuthLimitConfig {
  perIp: number;
  windowMs: number;
}

export interface RouteMetric {
  count: number;
  errors: number;
  latencyMsTotal: number;
}

/** Process counters. They do not enforce a host disk, CPU, or memory quota. */
export interface ServiceMetrics {
  requests: number;
  errors: number;
  latencyMsTotal: number;
  queueRejected: number;
  authLimited: number;
  tasksAccepted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  routes: Record<string, RouteMetric>;
}

/** Operator prices in micro-USD. Absent in local mode. Public mode must not run drafts without it. */
export interface AuthoringBudget {
  requestCeilingMicroUsd: number;
  dailyCeilingMicroUsd: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cachedInputMicroUsdPerMillion?: number;
}

export interface Deps {
  db: Db;
  buyerToken: string;
  now: () => number;
  validatePlan: PlanValidator;
  /** T6 engine boundary (CONTRACT-T5-T8 §1). */
  engine: Engine;
  /** T5 draft model; absent means POST /v1/drafts returns 503 model_unavailable. */
  draftModel?: DraftModel;
  /** Host directory where compiled packages are kept for workers. Unset: packages are not kept. */
  packagesDir?: string;
  /** T7/T8 chain; absent means chain routes return 503 chain_unavailable. */
  chain?: ApiChain;
  deployment: DeploymentConfig;
  rateLimit?: RateLimitConfig;
  /** Always set. Counts queued and running tasks only. */
  taskQueue: TaskQueueConfig;
  /** Always set. Applies to auth challenge and key issuance. */
  authLimit: AuthLimitConfig;
  compileAdmission: CompileAdmission;
  /** Process counters. Reset on restart. They do not enforce a host quota. */
  metrics: ServiceMetrics;
  /** One JSON line per request. The line uses a fixed route label. */
  requestLog: boolean;
  /** Local mode may print an unknown error value. Public mode ignores this flag. */
  requestLogDebug: boolean;
  expensiveDisabled: boolean;
  /** When set, a draft task reserves its ceiling before the handler runs. */
  budget?: AuthoringBudget;
  /** Bearer token for an audited spend-halt resolution. Unset means resolution is unavailable. */
  operatorToken?: string;
  botReview?: BotReviewConfig;
}

export interface IdempotencyScope {
  key: string;
  method: string;
  path: string;
  caller: string;
  requestHash: string;
  /** Set once the response has been stored, so the middleware does not store it twice. */
  stored: boolean;
}

export interface AppEnv {
  Variables: {
    rawBody: Uint8Array;
    /** Parsed JSON body; only set for POST. */
    json: unknown;
    /** "buyer", a lowercase wallet, or the lowercase provider address. */
    caller: string;
    /** Set by buyer or API-key authentication. */
    principal?: Principal;
    /** Set only by the task runner. HTTP routes leave this empty. */
    taskId?: string;
    idem: IdempotencyScope | undefined;
  };
}

export type AppContext = Context<AppEnv>;

export function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256hex0x(data: Uint8Array | string): string {
  return "0x" + sha256(data).toString("hex");
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Reads the raw body with a hard 1 MiB cap (413). Runs before auth because provider signatures cover
 * the body hash.
 */
export const readBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const declared = c.req.header("content-length");
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    throw tooLarge();
  }
  const bytes = await readCapped(c.req.raw);
  c.set("rawBody", bytes);
  await next();
};

/**
 * Decodes the raw body as strict UTF-8 and parses it as JSON (400 on either failure). Runs after auth,
 * so unauthenticated callers get 401.
 */
export const parseJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(c.get("rawBody"));
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid UTF-8");
  }
  try {
    c.set("json", JSON.parse(text) as unknown);
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON");
  }
  await next();
};

function tooLarge(): ApiError {
  return new ApiError("payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`, {
    limit: MAX_BODY_BYTES,
  });
}

async function readCapped(req: Request): Promise<Uint8Array> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 404 unless the raw (undecoded) `:id` path segment is exactly 26 upper-case Crockford ULID characters.
 * Runs before idempotency, so percent-encoded or lower-case variants of one id cannot form separate scopes.
 */
export const requireJobId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const segment = new URL(c.req.url).pathname.split("/")[3] ?? "";
  if (!ULID_RE.test(segment)) throw new ApiError("not_found", "Job not found");
  await next();
};
