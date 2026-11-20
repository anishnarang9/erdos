import type { Hono } from "hono";
import { ApiError } from "./errors.ts";
import type { AppEnv, Deps } from "./context.ts";

const METHODS = new Set(["GET", "POST"]);
const HEADERS = ["Authorization", "Content-Type", "Idempotency-Key", "If-Match", "payment-signature"];
const ALLOWED_HEADERS = new Set(HEADERS.map(value => value.toLowerCase()));
const EXPOSED = "Retry-After, ETag, payment-required, payment-response, idempotent-replayed";
const denied = (): ApiError => new ApiError("forbidden", "Origin is not allowed");

/** Browser policy runs before every route, including operator metrics. It grants no wallet authority. */
export function registerBrowserOrigin(app: Hono<AppEnv>, deps: Deps): void {
  const origins = new Set(deps.deployment.browserOrigins);
  app.use("*", async (c, next) => {
    // Vary also covers a response to a client that sent no Origin.
    c.header("Vary", "Origin", { append: true });
    const origin = c.req.header("origin");
    if (origin === undefined) { await next(); return; }
    if (!origins.has(origin)) throw denied();
    if (c.req.method === "OPTIONS") {
      const method = c.req.header("access-control-request-method") ?? "";
      const requested = c.req.header("access-control-request-headers") ?? "";
      if (!METHODS.has(method) || requested.length > 1024 ||
          (requested !== "" && requested.split(",").some(value => !ALLOWED_HEADERS.has(value.trim().toLowerCase())))) throw denied();
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST");
      c.header("Access-Control-Allow-Headers", HEADERS.join(", "));
      c.header("Access-Control-Max-Age", "600");
      return c.body(null, 204);
    }
    if (!METHODS.has(c.req.method)) throw denied();
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Expose-Headers", EXPOSED);
    await next();
  });
}
