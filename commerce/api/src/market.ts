// T7/T8 routes: job feed, quotes, select-quote, funding-receipt, assignments, submission. Owner: Coder D.
// Implement per ../CONTRACT-T5-T8.md §5–6.
import { readBody, parseJson, requireJobId, type Deps } from "./context.ts";
import type { RouteContext } from "./routes.ts";

/** Job-view `chain` field (CONTRACT-T5-T8 §6). jobs.ts calls this; Coder D implements it. */
export interface ChainView {
  chainId: number;
  core: string;
  jobId: string;
  status: string;
  statusSource: "index" | "live";
  fundTx: string;
}

export async function chainViewFor(_deps: Deps, _jobId: string): Promise<ChainView | null> {
  return null;
}

export function registerMarketRoutes(ctx: RouteContext): void {
  const { app, buyer, provider, idem, notImplemented } = ctx;
  app.get("/v1/jobs", readBody, notImplemented);
  app.get("/v1/assignments", readBody, provider, (c) => c.json({ assignments: [] }));
  app.post("/v1/jobs/:id/quotes", readBody, provider, parseJson, requireJobId, idem.middleware, notImplemented);
  app.post("/v1/jobs/:id/select-quote", readBody, buyer, parseJson, requireJobId, idem.middleware, notImplemented);
  app.post("/v1/jobs/:id/funding-receipt", readBody, buyer, parseJson, requireJobId, idem.middleware, notImplemented);
  app.get("/v1/jobs/:id/submission", readBody, requireJobId, notImplemented);
}
