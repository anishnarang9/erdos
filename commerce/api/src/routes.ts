// Shared route context handed to each route module. Owned by the lead; coders import it but do not edit it.
import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv, Deps } from "./context.ts";
import type { Idempotency } from "./idempotency.ts";

export interface RouteContext {
  app: Hono<AppEnv>;
  deps: Deps;
  buyer: MiddlewareHandler<AppEnv>;
  provider: MiddlewareHandler<AppEnv>;
  idem: Idempotency;
  notImplemented: MiddlewareHandler<AppEnv>;
  newId: () => string;
}
