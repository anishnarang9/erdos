import type { MiddlewareHandler } from "hono";
import type { StatementSync } from "node:sqlite";
import { ApiError } from "./errors.ts";
import { tx } from "./db.ts";
import type { AppEnv, Deps } from "./context.ts";

/**
 * Blocks model and compiler calls when the operator disables them,
 * and counts the configured principal and IP windows.
 * A limit of 0 or less means that dimension is not enforced.
 */
export function expensiveGuard(deps: Deps): MiddlewareHandler<AppEnv> {
  const upsert = deps.db.prepare(
    "INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1",
  );
  const read = deps.db.prepare("SELECT count FROM rate_counters WHERE bucket = ? AND window_start = ?");
  return async (c, next) => {
    if (deps.expensiveDisabled) throw new ApiError("service_disabled", "Expensive operations are disabled");
    const limit = deps.rateLimit;
    if (limit) {
      const windowMs = limit.windowMs && limit.windowMs > 0 ? limit.windowMs : 60_000;
      const windowStart = Math.floor(deps.now() / windowMs);
      const principal = c.get("principal");
      const who = principal?.kind === "wallet" ? principal.wallet : "legacy";
      take(deps, upsert, read, `principal:${who}`, windowStart, limit.expensivePerPrincipal, "Rate limit exceeded");
      if (deps.deployment.trustProxy) {
        const ip = clientIp(c.req.header("x-forwarded-for")) ?? "direct";
        take(deps, upsert, read, `ip:${ip}`, windowStart, limit.expensivePerIp, "Rate limit exceeded");
      }
    }
    await next();
  };
}

/**
 * Counts POST /v1/auth/challenge and POST /v1/auth/keys by client IP.
 * A trusted proxy uses the first X-Forwarded-For hop. Any other hop shares `direct`.
 * Local mode without a trusted proxy does not count, so a developer can issue keys.
 * Public mode without a trusted proxy shares one direct bucket.
 */
export function authIpGuard(deps: Deps): MiddlewareHandler<AppEnv> {
  const upsert = deps.db.prepare(
    "INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1",
  );
  const read = deps.db.prepare("SELECT count FROM rate_counters WHERE bucket = ? AND window_start = ?");
  return async (c, next) => {
    const ip = authClientIp(deps, c.req.header("x-forwarded-for"));
    if (ip) {
      const windowMs = deps.authLimit.windowMs;
      const windowStart = Math.floor(deps.now() / windowMs);
      try {
        take(deps, upsert, read, `auth-ip:${ip}`, windowStart, deps.authLimit.perIp, "Auth rate limit exceeded");
      } catch (err) {
        if (err instanceof ApiError && err.code === "rate_limited") deps.metrics.authLimited += 1;
        throw err;
      }
    }
    await next();
  };
}

/** First forwarded hop, or undefined when it is not a bounded address. */
export function clientIp(forwarded: string | undefined): string | undefined {
  const hop = (forwarded ?? "").split(",")[0]?.trim() ?? "";
  return normalizeIp(hop);
}

function authClientIp(deps: Deps, forwarded: string | undefined): string | undefined {
  if (deps.deployment.trustProxy) return clientIp(forwarded) ?? "direct";
  if (deps.deployment.mode === "public") return "direct";
  return undefined;
}

function normalizeIp(value: string): string | undefined {
  if (value.length === 0 || value.length > 64) return undefined;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const parts = value.split(".").map((part) => Number(part));
    if (parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return value;
    return undefined;
  }
  if (/^[0-9a-f:.]{2,64}$/i.test(value) && value.includes(":")) return value.toLowerCase();
  return undefined;
}

function take(
  deps: Deps,
  upsert: StatementSync,
  read: StatementSync,
  bucket: string,
  windowStart: number,
  limit: number,
  message: string,
): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) return;
  const count = tx(deps.db, () => {
    upsert.run(bucket, windowStart);
    return Number((read.get(bucket, windowStart) as { count: number }).count);
  });
  if (count > limit) throw new ApiError("rate_limited", message);
}
