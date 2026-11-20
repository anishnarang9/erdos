import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { ApiError } from "./errors.ts";
import type { AppEnv, Deps, ServiceMetrics } from "./context.ts";

const ROUTE_LABELS: { method: string; pattern: RegExp; label: string }[] = [
  { method: "GET", pattern: /^\/healthz$/, label: "GET /healthz" },
  { method: "GET", pattern: /^\/readyz$/, label: "GET /readyz" },
  { method: "POST", pattern: /^\/v1\/auth\/challenge$/, label: "POST /v1/auth/challenge" },
  { method: "POST", pattern: /^\/v1\/auth\/keys$/, label: "POST /v1/auth/keys" },
  { method: "GET", pattern: /^\/v1\/auth\/keys\/current$/, label: "GET /v1/auth/keys/current" },
  { method: "POST", pattern: /^\/v1\/auth\/keys\/[^/]+\/revoke$/, label: "POST /v1/auth/keys/:id/revoke" },
  { method: "POST", pattern: /^\/v1\/jobs$/, label: "POST /v1/jobs" },
  { method: "GET", pattern: /^\/v1\/jobs$/, label: "GET /v1/jobs" },
  { method: "POST", pattern: /^\/v1\/drafts$/, label: "POST /v1/drafts" },
  { method: "GET", pattern: /^\/v1\/assignments$/, label: "GET /v1/assignments" },
  { method: "GET", pattern: /^\/v1\/open-jobs$/, label: "GET /v1/open-jobs" },
  { method: "GET", pattern: /^\/v1\/open-jobs\/[^/]+$/, label: "GET /v1/open-jobs/:id" },
  { method: "POST", pattern: /^\/v1\/tasks$/, label: "POST /v1/tasks" },
  { method: "GET", pattern: /^\/v1\/tasks\/[^/]+$/, label: "GET /v1/tasks/:id" },
  { method: "GET", pattern: /^\/v1\/operator\/metrics$/, label: "GET /v1/operator/metrics" },
  { method: "POST", pattern: /^\/v1\/operator\/spend-halts\/[^/]+\/resolve$/, label: "POST /v1/operator/spend-halts/:id/resolve" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/attempts$/, label: "POST /v1/jobs/:id/attempts" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/attempts$/, label: "GET /v1/jobs/:id/attempts" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/attempts\/[^/]+$/, label: "GET /v1/jobs/:id/attempts/:attemptId" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/open-claim-terms$/, label: "POST /v1/jobs/:id/open-claim-terms" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/open-claim-link$/, label: "POST /v1/jobs/:id/open-claim-link" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/approve$/, label: "POST /v1/jobs/:id/approve" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/revisions$/, label: "POST /v1/jobs/:id/revisions" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/compile$/, label: "POST /v1/jobs/:id/compile" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/paid-compile$/, label: "POST /v1/jobs/:id/paid-compile" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/package\/file$/, label: "GET /v1/jobs/:id/package/file" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/package$/, label: "GET /v1/jobs/:id/package" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/references$/, label: "GET /v1/jobs/:id/references" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/quotes$/, label: "POST /v1/jobs/:id/quotes" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/select-quote$/, label: "POST /v1/jobs/:id/select-quote" },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/funding-receipt$/, label: "POST /v1/jobs/:id/funding-receipt" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/submission$/, label: "GET /v1/jobs/:id/submission" },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+$/, label: "GET /v1/jobs/:id" },
];

const ALLOWED = new Set(ROUTE_LABELS.map((item) => item.label));
ALLOWED.add("unknown");
ALLOWED.add("OPTIONS preflight");

const INTERNAL_LABELS = new Set(["paid-compile", "chain-read", "task-pump", "indexer"]);
const TASK_EVENTS = new Set(["accepted", "rejected", "finished"]);
const TASK_STATES = new Set(["queued", "running", "succeeded", "failed", "uncertain"]);

export function emptyMetrics(): ServiceMetrics {
  return {
    requests: 0,
    errors: 0,
    latencyMsTotal: 0,
    queueRejected: 0,
    authLimited: 0,
    tasksAccepted: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    routes: {},
  };
}

export function routeLabel(method: string, pathname: string): string {
  if (method === "OPTIONS") return "OPTIONS preflight";
  for (const item of ROUTE_LABELS) {
    if (item.method === method && item.pattern.test(pathname)) return item.label;
  }
  return "unknown";
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function boundedMs(elapsed: number): number {
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.min(Math.floor(elapsed), 300_000));
}

function addLatency(current: number, elapsed: number): number {
  const next = current + boundedMs(elapsed);
  return Number.isSafeInteger(next) ? next : current;
}

function record(metrics: ServiceMetrics, label: string, status: number, elapsed: number): void {
  const route = ALLOWED.has(label) ? label : "unknown";
  metrics.requests += 1;
  if (status >= 400) metrics.errors += 1;
  metrics.latencyMsTotal = addLatency(metrics.latencyMsTotal, elapsed);
  const row = metrics.routes[route] ?? { count: 0, errors: 0, latencyMsTotal: 0 };
  row.count += 1;
  if (status >= 400) row.errors += 1;
  row.latencyMsTotal = addLatency(row.latencyMsTotal, elapsed);
  metrics.routes[route] = row;
}

function safeCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return /^[a-z0-9_]{1,40}$/.test(code) ? code : "internal";
}

function taskOperation(value: string): "draft" | "compile" | "unknown" {
  return value === "draft" || value === "compile" ? value : "unknown";
}

function writeTask(deps: Deps, event: { event: string; operation: string; state: string; code?: string }): void {
  if (!deps.requestLog) return;
  const body: Record<string, string> = {
    kind: "task",
    event: TASK_EVENTS.has(event.event) ? event.event : "finished",
    operation: taskOperation(event.operation),
    state: TASK_STATES.has(event.state) ? event.state : "unknown",
  };
  const code = safeCode(event.code);
  if (code) body.code = code;
  console.log(JSON.stringify(body));
}

export function noteQueueRejected(deps: Deps, operation: string): void {
  deps.metrics.queueRejected += 1;
  writeTask(deps, { event: "rejected", operation, state: "queued", code: "rate_limited" });
}

export function noteTaskAccepted(deps: Deps, operation: string): void {
  deps.metrics.tasksAccepted += 1;
  writeTask(deps, { event: "accepted", operation, state: "queued" });
}

export function noteTaskFinished(deps: Deps, operation: string, state: "succeeded" | "failed", code?: string): void {
  if (state === "succeeded") deps.metrics.tasksSucceeded += 1;
  else deps.metrics.tasksFailed += 1;
  writeTask(deps, { event: "finished", operation, state, ...(code ? { code } : {}) });
}

/** Public mode never prints the error value. Local debug is explicit. */
export function logInternal(mode: "local" | "public", debug: boolean, route: string, err: unknown): void {
  const label = ALLOWED.has(route) || INTERNAL_LABELS.has(route) ? route : "unknown";
  if (mode === "local" && debug) {
    console.error("[api] unhandled error", err);
    return;
  }
  console.error(JSON.stringify({ kind: "error", route: label, status: 500, code: "internal" }));
}

function bearerMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function numberOf(value: unknown): number {
  const count = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function metricsBody(deps: Deps): Record<string, unknown> {
  const row = deps.db.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running
     FROM tasks`,
  ).get() as unknown as { queued: number | bigint; running: number | bigint } | undefined;
  const memory = process.memoryUsage();
  return {
    requests: deps.metrics.requests,
    errors: deps.metrics.errors,
    latencyMsTotal: deps.metrics.latencyMsTotal,
    routes: Object.entries(deps.metrics.routes)
      .map(([route, metric]) => ({ route, count: metric.count, errors: metric.errors, latencyMsTotal: metric.latencyMsTotal }))
      .sort((left, right) => left.route < right.route ? -1 : left.route > right.route ? 1 : 0),
    queue: {
      queued: numberOf(row?.queued),
      running: numberOf(row?.running),
      rejected: deps.metrics.queueRejected,
    },
    tasks: {
      accepted: deps.metrics.tasksAccepted,
      succeeded: deps.metrics.tasksSucceeded,
      failed: deps.metrics.tasksFailed,
    },
    paidCompile: {
      active: deps.compileAdmission.activeExternal,
      waiting: deps.compileAdmission.waiting,
      rejected: deps.compileAdmission.rejected,
      limit: deps.compileAdmission.limit,
    },
    authLimited: deps.metrics.authLimited,
    admission: {
      globalPending: deps.taskQueue.globalPending,
      pendingPerWallet: deps.taskQueue.pendingPerWallet,
      authPerIp: deps.authLimit.perIp,
      authWindowMs: deps.authLimit.windowMs,
    },
    resources: {
      processRssBytes: memory.rss,
      processHeapUsedBytes: memory.heapUsed,
      uptimeSeconds: Math.floor(process.uptime()),
      hostQuota: "not_enforced",
    },
  };
}

export function registerObserve(app: Hono<AppEnv>, deps: Deps): void {
  app.use("*", async (c, next) => {
    const started = deps.now();
    const label = routeLabel(c.req.method, pathnameOf(c.req.url));
    await next();
    const status = c.res.status;
    const elapsed = deps.now() - started;
    record(deps.metrics, label, status, elapsed);
    if (!deps.requestLog) return;
    console.log(JSON.stringify({
      kind: "request",
      route: label,
      status,
      ms: boundedMs(elapsed),
      mode: deps.deployment.mode,
    }));
  });

  app.onError((err, c) => {
    const label = routeLabel(c.req.method, pathnameOf(c.req.url));
    if (err instanceof ApiError) {
      const retryAfter = err.details?.retryAfterSeconds;
      if (err.status === 429 && typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
        c.header("Retry-After", String(retryAfter));
      }
      return c.json(err.toBody(), err.status as 400);
    }
    logInternal(deps.deployment.mode, deps.requestLogDebug, label, err);
    return c.json(new ApiError("internal", "Internal server error").toBody(), 500);
  });

}

/** Register only after the origin middleware, so this route has the same browser boundary. */
export function registerOperatorMetrics(app: Hono<AppEnv>, deps: Deps): void {
  app.get("/v1/operator/metrics", (c) => {
    if (!deps.operatorToken) throw new ApiError("not_found", "Not found");
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!bearerMatches(presented, deps.operatorToken)) throw new ApiError("unauthorized", "Unauthorized");
    return c.json(metricsBody(deps));
  });
}
