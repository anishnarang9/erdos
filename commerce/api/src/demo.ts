// Demo-only read routes for the buyer UI: the solver's run events (worker -> <runEventsDir>/<jobId>.jsonl).
// Local events drive animation and diagnostics only; financial state comes from chain-confirmed job and
// submission views (GET /v1/jobs/:id, /submission).
import type { Handler, MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";
import { readBody, type AppEnv } from "./context.ts";
import type { RouteContext } from "./routes.ts";
import { readRunEvents, type RunEvent } from "./run-events.ts";

/** The solver-side phase implied by the latest event (for the UI; never a payment state). */
export function phaseOf(events: RunEvent[]): string {
  const last = events.at(-1);
  if (!last) return "idle";
  const map: Record<string, string> = {
    "quote.created": "quoted",
    "solver.started": "solving",
    "proof.started": "proving",
    "proof.finished": last.data.verdict === 0 ? "proved_fail" : "proved",
    "proof.failed": "failed",
    "submission.preflight_rejected": "rejected",
    "submission.broadcast": "submitting",
    "submission.confirmed": "submitted",
    "release.broadcast": "releasing",
    "release.confirmed": "released",
    "run.abandoned": "abandoned",
    "run.failed": "failed",
  };
  return map[last.type] ?? "unknown";
}

export function registerDemoRoutes(ctx: RouteContext): void {
  const { app, buyer, deps } = ctx;
  const dir = () => {
    if (!deps.runEventsDir) throw new ApiError("not_found", "Run events are not enabled (RUN_EVENTS_DIR)");
    return deps.runEventsDir;
  };

  const parseAfter = (raw: string | undefined): number => {
    if (raw === undefined || raw === "") return 0;
    if (!/^\d{1,9}$/.test(raw)) throw new ApiError("validation_failed", "after must be a non-negative integer", { errors: [{ path: "/query/after", message: "must be a non-negative integer" }] });
    return Number(raw);
  };

  /** GET /v1/demo/runs/:id: every event so far, the latest seq (a cursor), and the implied solver phase. */
  const snapshot: Handler<AppEnv> = (c) => {
    const events = readRunEvents(dir(), c.req.param("id") ?? "");
    return c.json({ runId: c.req.param("id"), cursor: events.at(-1)?.seq ?? 0, phase: phaseOf(events), events });
  };

  /** GET /v1/demo/runs/:id/events?after=<seq>: events with seq > after, in order. */
  const events: Handler<AppEnv> = (c) => {
    const after = parseAfter(c.req.query("after"));
    const list = readRunEvents(dir(), c.req.param("id") ?? "", after);
    return c.json({ runId: c.req.param("id"), cursor: list.at(-1)?.seq ?? after, events: list });
  };

  // requireJobId reads /v1/jobs/<id>; these paths carry the run (job) id one segment later.
  const requireRunId: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(c.req.param("id") ?? "")) throw new ApiError("not_found", "Run not found");
    await next();
  };
  app.get("/v1/demo/runs/:id", readBody, buyer, requireRunId, snapshot);
  app.get("/v1/demo/runs/:id/events", readBody, buyer, requireRunId, events);
}
