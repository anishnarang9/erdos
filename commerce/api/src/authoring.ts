// T5/T6 routes: drafts, revisions, compile. Owner: Coder C. Implement per ../CONTRACT-T5-T8.md §2–4.
import { readBody, parseJson, requireJobId } from "./context.ts";
import type { RouteContext } from "./routes.ts";

export function registerAuthoringRoutes(ctx: RouteContext): void {
  const { app, buyer, idem, notImplemented } = ctx;
  app.post("/v1/drafts", readBody, buyer, parseJson, idem.middleware, notImplemented);
  app.post("/v1/jobs/:id/compile", readBody, buyer, parseJson, requireJobId, idem.middleware, notImplemented);
}
