import { Hono, type MiddlewareHandler } from "hono";
import { monotonicFactory } from "ulid";
import { ApiError } from "./errors.ts";
import { openDb } from "./db.ts";
import { buyerAuth, providerAuth } from "./auth.ts";
import { idempotency } from "./idempotency.ts";
import { parseJson, readBody, requireJobId, type AppEnv, type Deps } from "./context.ts";
import { simulatedValidatePlan, type PlanValidator } from "./revision.ts";
import { jobRoutes } from "./jobs.ts";

export interface CreateAppOptions {
  dbPath: string;
  buyerToken: string;
  now?: () => number;
  validatePlan?: PlanValidator;
}

export interface CreatedApp {
  app: Hono<AppEnv>;
  close: () => void;
}

export function createApp(opts: CreateAppOptions): CreatedApp {
  if (typeof opts.buyerToken !== "string" || opts.buyerToken.length < 16) {
    throw new Error("createApp: buyerToken must be a string of at least 16 characters");
  }
  const now = opts.now ?? (() => Date.now());
  const db = openDb(opts.dbPath, now);
  const deps: Deps = {
    db,
    buyerToken: opts.buyerToken,
    now,
    validatePlan: opts.validatePlan ?? simulatedValidatePlan,
  };

  const app = new Hono<AppEnv>();

  app.notFound((c) =>
    c.json(new ApiError("not_found", `No route for ${c.req.method} ${c.req.path}`).toBody(), 404),
  );
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(err.toBody(), err.status as 400);
    }
    console.error("[api] unhandled error", err);
    return c.json(new ApiError("internal", "Internal server error").toBody(), 500);
  });

  // Middleware order per route: raw body (1 MiB cap) -> auth -> JSON parse (POST) -> :id check -> idempotency
  // (POST /v1/*) -> handler.
  const buyer = buyerAuth(deps);
  const provider = providerAuth(deps);
  const idem = idempotency(deps);
  const notImplemented: MiddlewareHandler<AppEnv> = async () => {
    throw new ApiError("not_implemented", "Not implemented yet");
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  const jobs = jobRoutes(deps, idem.commit, monotonicFactory());
  app.post("/v1/jobs", readBody, buyer, parseJson, idem.middleware, jobs.create);
  app.get("/v1/jobs/:id", readBody, requireJobId, jobs.get);
  app.post("/v1/jobs/:id/approve", readBody, buyer, parseJson, requireJobId, idem.middleware, jobs.approve);

  app.get("/v1/assignments", readBody, provider, (c) => c.json({ assignments: [] }));

  // Owned by later tasks: mounted so auth and idempotency still run, then 501.
  app.post("/v1/drafts", readBody, buyer, parseJson, idem.middleware, notImplemented);
  app.post("/v1/jobs/:id/compile", readBody, buyer, parseJson, requireJobId, idem.middleware, notImplemented);
  app.get("/v1/jobs", readBody, notImplemented);
  app.post("/v1/jobs/:id/quotes", readBody, provider, parseJson, requireJobId, idem.middleware, notImplemented);
  app.post("/v1/jobs/:id/select-quote", readBody, buyer, parseJson, requireJobId, idem.middleware, notImplemented);
  app.post("/v1/jobs/:id/funding-receipt", readBody, buyer, parseJson, requireJobId, idem.middleware, notImplemented);
  app.get("/v1/jobs/:id/submission", readBody, requireJobId, notImplemented);

  return {
    app,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
