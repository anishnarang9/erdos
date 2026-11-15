import { Hono, type MiddlewareHandler } from "hono";
import { monotonicFactory } from "ulid";
import { ApiError } from "./errors.ts";
import { openDb } from "./db.ts";
import { buyerAuth, providerAuth } from "./auth.ts";
import { idempotency } from "./idempotency.ts";
import { parseJson, readBody, requireJobId, type AppEnv, type Deps } from "./context.ts";
import { simulatedValidatePlan, type PlanValidator } from "./revision.ts";
import { jobRoutes } from "./jobs.ts";
import { simulatedEngine, type Engine } from "./engine.ts";
import type { DraftModel } from "./grok.ts";
import { assertChainEngine, type ApiChain } from "./chain.ts";
import { registerAuthoringRoutes } from "./authoring.ts";
import { registerMarketRoutes } from "./market.ts";

export interface CreateAppOptions {
  dbPath: string;
  buyerToken: string;
  now?: () => number;
  validatePlan?: PlanValidator;
  /** Defaults to simulatedEngine(), or to `validatePlan` plus the simulated compile when validatePlan is given. */
  engine?: Engine;
  draftModel?: DraftModel;
  chain?: ApiChain;
  /** Keep compiled packages here (see Deps.packagesDir). */
  packagesDir?: string;
}

export interface CreatedApp {
  app: Hono<AppEnv>;
  close: () => void;
}

export function createApp(opts: CreateAppOptions): CreatedApp {
  if (typeof opts.buyerToken !== "string" || opts.buyerToken.length < 16) {
    throw new Error("createApp: buyerToken must be a string of at least 16 characters");
  }
  const engine = opts.engine ?? (opts.validatePlan
    ? { mode: "simulated" as const, validate: opts.validatePlan, compile: simulatedEngine().compile }
    : simulatedEngine());
  // Fail before opening/migrating a database, including for embedded applications.
  assertChainEngine(opts.chain, engine);
  const now = opts.now ?? (() => Date.now());
  const db = openDb(opts.dbPath, now);
  const validatePlan = opts.validatePlan ?? simulatedValidatePlan;
  const deps: Deps = {
    db,
    buyerToken: opts.buyerToken,
    now,
    validatePlan,
    // Default: the simulated engine (fake hashes, never provable). server.ts passes the real one.
    engine,
    ...(opts.draftModel ? { draftModel: opts.draftModel } : {}),
    ...(opts.chain ? { chain: opts.chain } : {}),
    ...(opts.packagesDir ? { packagesDir: opts.packagesDir } : {}),
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

  const ulid = monotonicFactory();
  const newId = () => ulid();
  const jobs = jobRoutes(deps, idem.commit, ulid);
  app.post("/v1/jobs", readBody, buyer, parseJson, idem.middleware, jobs.create);
  app.post("/v1/jobs/:id/approve", readBody, buyer, parseJson, requireJobId, idem.middleware, jobs.approve);

  // Route modules (one owner each): authoring.ts (T5/T6), market.ts (T7/T8). Register literal paths such as
  // GET /v1/jobs before the parameterised GET /v1/jobs/:id below.
  const ctx = { app, deps, buyer, provider, idem, notImplemented, newId };
  registerAuthoringRoutes(ctx);
  registerMarketRoutes(ctx);

  app.get("/v1/jobs/:id", readBody, requireJobId, jobs.get);

  return {
    app,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
