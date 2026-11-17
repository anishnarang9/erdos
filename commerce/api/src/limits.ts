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
      take(deps, upsert, read, `principal:${who}`, windowStart, limit.expensivePerPrincipal);
      if (deps.deployment.trustProxy) {
        const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
        if (ip) take(deps, upsert, read, `ip:${ip}`, windowStart, limit.expensivePerIp);
      }
    }
    await next();
  };
}

function take(
  deps: Deps,
  upsert: StatementSync,
  read: StatementSync,
  bucket: string,
  windowStart: number,
  limit: number,
): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) return;
  const count = tx(deps.db, () => {
    upsert.run(bucket, windowStart);
    return Number((read.get(bucket, windowStart) as { count: number }).count);
  });
  if (count > limit) throw new ApiError("rate_limited", "Rate limit exceeded");
}
