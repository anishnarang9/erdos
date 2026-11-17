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
import { registerX402Routes, type X402Config } from "./x402.ts";
import { registerOpenClaimRoutes, type OpenClaimConfig } from "./open-claim.ts";
import { registerIdentityRoutes } from "./identity.ts";
import { requireOwnedJob } from "./ownership.ts";
import { assertAuthoringBudget, registerTaskRoutes } from "./tasks.ts";
import type { AuthoringBudget, DeploymentConfig, RateLimitConfig } from "./context.ts";
import type { ReadyReport } from "./ready.ts";

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
  /** Optional x402 service charge for the separate paid compile route. */
  x402?: X402Config;
  /** Optional open-claim registration and public discovery reader. */
  openClaim?: OpenClaimConfig;
  /** Local mode keeps the shared buyer token. Public mode accepts only wallet API keys. */
  deployment?: {
    mode: "local" | "public";
    serviceOrigin: string;
    trustProxy?: boolean;
  };
  /** Absent means expensive routes are not counted. */
  rateLimit?: RateLimitConfig;
  /** When true, model and compiler routes return 503. */
  expensiveDisabled?: boolean;
  /** Prices and ceilings for draft tasks. Required before a public draft task is accepted. */
  budget?: AuthoringBudget;
  /** Bearer token that may resolve a spend halt. Unset leaves a halt in force. */
  operatorToken?: string;
  /** Production readiness. Absent reports not configured and does not claim the process is ready. */
  ready?: (deps: Deps) => Promise<ReadyReport>;
}

export interface CreatedApp {
  app: Hono<AppEnv>;
  close: () => void;
  /** Marks interrupted drafts uncertain and requeues interrupted compiles. Call once before pumpTasks. */
  reconcileTasks: () => void;
  /** Runs queued work up to one compile and two drafts. Does not start a timer. */
  pumpTasks: () => Promise<void>;
  /**
   * Stops new claims, cancels owned compiler groups, and reconciles running work.
   * A compile returns to queued. A dispatched draft stays uncertain. The bound defaults to 2000 ms.
   */
  drainTasks: (boundMs?: number) => Promise<void>;
  /** Runs the readiness callback against the open database. It does not listen. */
  checkReady: () => Promise<ReadyReport>;
}

export function createApp(opts: CreateAppOptions): CreatedApp {
  if (typeof opts.buyerToken !== "string" || opts.buyerToken.length < 16) {
    throw new Error("createApp: buyerToken must be a string of at least 16 characters");
  }
  assertAuthoringBudget(opts.budget);
  const engine = opts.engine ?? (opts.validatePlan
    ? { mode: "simulated" as const, validate: opts.validatePlan, compile: simulatedEngine().compile }
    : simulatedEngine());
  // Fail before opening/migrating a database, including for embedded applications.
  assertChainEngine(opts.chain, engine);
  const now = opts.now ?? (() => Date.now());
  const db = openDb(opts.dbPath, now);
  const validatePlan = opts.validatePlan ?? simulatedValidatePlan;
  const deployment: DeploymentConfig = {
    mode: opts.deployment?.mode ?? "local",
    serviceOrigin: opts.deployment?.serviceOrigin ?? "http://localhost",
    trustProxy: opts.deployment?.trustProxy ?? false,
  };
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
    deployment,
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    expensiveDisabled: opts.expensiveDisabled ?? false,
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.operatorToken ? { operatorToken: opts.operatorToken } : {}),
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
  const owned = requireOwnedJob(deps);
  const notImplemented: MiddlewareHandler<AppEnv> = async () => {
    throw new ApiError("not_implemented", "Not implemented yet");
  };

  app.get("/healthz", (c) => c.json({ ok: true }));
  const loadReady = (): Promise<ReadyReport> => opts.ready ? opts.ready(deps) : Promise.resolve(unconfiguredReady());
  app.get("/readyz", async (c) => {
    const report = await loadReady();
    return c.json(report, report.ready ? 200 : 503);
  });

  const ulid = monotonicFactory();
  const newId = () => ulid();
  // Key issuance is not idempotent. A replay must not return the raw key again.
  registerIdentityRoutes(app, deps, newId);
  const jobs = jobRoutes(deps, idem.commit, ulid);
  app.post("/v1/jobs", readBody, buyer, parseJson, idem.middleware, jobs.create);
  app.post("/v1/jobs/:id/approve", readBody, buyer, parseJson, requireJobId, owned, idem.middleware, jobs.approve);

  // Route modules (one owner each): authoring.ts (T5/T6), market.ts (T7/T8). Register literal paths such as
  // GET /v1/jobs before the parameterised GET /v1/jobs/:id below.
  const ctx = { app, deps, buyer, provider, idem, notImplemented, newId };
  const authoring = registerAuthoringRoutes(ctx);
  const tasks = registerTaskRoutes(ctx, authoring);
  registerX402Routes(ctx, authoring, opts.x402, tasks.withCompileSlot);
  registerOpenClaimRoutes(ctx, opts.openClaim);
  registerMarketRoutes(ctx);

  app.get("/v1/jobs/:id", readBody, requireJobId, jobs.get);

  return {
    app,
    close: () => {
      if (db.isOpen) db.close();
    },
    reconcileTasks: tasks.reconcileTasks,
    pumpTasks: tasks.pumpTasks,
    drainTasks: tasks.drainTasks,
    checkReady: loadReady,
  };
}

function unconfiguredReady(): ReadyReport {
  return {
    ready: false,
    authoring: "required",
    checks: [{ name: "ready", ok: false, reason: "not_configured", blocksListen: false }],
  };
}
