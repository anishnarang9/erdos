import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";
import type { AppContext, AppEnv, Deps, Principal } from "./context.ts";

/** Wallet that owns new rows. Legacy buyer sessions stay null so old rows are not assigned. */
export function ownerWallet(c: AppContext): string | null {
  const principal = c.get("principal");
  return principal?.kind === "wallet" ? principal.wallet : null;
}

/**
 * Wallet callers can mutate only their own jobs.
 * A legacy buyer session keeps the previous shared-token behavior.
 * An ownerless legacy job is not mutable by a wallet key.
 */
export function requireOwnedJob(deps: Deps): MiddlewareHandler<AppEnv> {
  const load = deps.db.prepare("SELECT owner_wallet FROM jobs WHERE id = ?");
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "wallet") {
      await next();
      return;
    }
    const id = c.req.param("id") ?? "";
    const row = load.get(id) as { owner_wallet: string | null } | undefined;
    if (!row || row.owner_wallet !== principal.wallet) throw new ApiError("not_found", "Job not found");
    await next();
  };
}

/** Open-claim funding terms must name the authenticated buyer. Legacy sessions are unchanged. */
export function assertFundingBuyer(principal: Principal | undefined, buyer: string): void {
  if (principal?.kind !== "wallet") return;
  if (buyer.toLowerCase() !== principal.wallet) {
    throw new ApiError("validation_failed", "Funding terms must name the authenticated buyer wallet", {
      errors: [{ path: "/buyer", message: "must equal the authenticated wallet" }],
    });
  }
}
