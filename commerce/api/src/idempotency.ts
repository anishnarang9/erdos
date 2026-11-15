import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";
import { tx } from "./db.ts";
import { isoAt, sha256, type AppContext, type AppEnv, type Deps, type IdempotencyScope } from "./context.ts";

const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

interface StoredRow {
  request_hash: string;
  status: number;
  response_json: string;
}

export interface Idempotency {
  middleware: MiddlewareHandler<AppEnv>;
  /**
   * Runs the handler's writes and stores its response in one transaction, then returns the response.
   * If a concurrent request with the same scope stored first, the writes are rolled back and that
   * request's outcome (replay or 422) is returned instead.
   */
  commit: (c: AppContext, status: number, body: unknown, writes?: () => void) => Response;
}

export function idempotency(deps: Deps): Idempotency {
  const { db } = deps;
  const select = db.prepare(
    "SELECT request_hash, status, response_json FROM idempotency WHERE key = ? AND method = ? AND route = ? AND caller = ?",
  );
  const insert = db.prepare(
    "INSERT INTO idempotency (key, method, route, caller, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const lookup = (s: IdempotencyScope): StoredRow | undefined =>
    select.get(s.key, s.method, s.path, s.caller) as StoredRow | undefined;

  const outcome = (s: IdempotencyScope, row: StoredRow): Response => {
    if (row.request_hash !== s.requestHash) {
      throw new ApiError(
        "idempotency_key_reused",
        "Idempotency-Key was already used with a different request",
      );
    }
    return new Response(row.response_json, {
      status: row.status,
      headers: { "content-type": "application/json", "idempotent-replayed": "true" },
    });
  };

  const store = (s: IdempotencyScope, status: number, text: string): void => {
    insert.run(s.key, s.method, s.path, s.caller, s.requestHash, status, text, isoAt(deps.now()));
    s.stored = true;
  };

  const middleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (key === undefined || !KEY_RE.test(key)) {
      throw new ApiError(
        "validation_failed",
        "Idempotency-Key header is required: 1-128 characters from [A-Za-z0-9_.:-]",
      );
    }
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const requestHash = sha256(
      Buffer.concat([Buffer.from(`${method}\n${path}\n`, "utf8"), c.get("rawBody")]),
    ).toString("hex");
    const scope: IdempotencyScope = { key, method, path, caller: c.get("caller"), requestHash, stored: false };

    const existing = lookup(scope);
    if (existing) return outcome(scope, existing);

    c.set("idem", scope);
    await next();

    // Responses the handler did not store itself (errors below 500, thrown and rendered by onError).
    if (!scope.stored && c.res.status < 500) {
      const text = await c.res.clone().text();
      const raced = tx(db, () => {
        const row = lookup(scope);
        if (row) return row;
        store(scope, c.res.status, text);
        return undefined;
      });
      if (raced) c.res = outcome(scope, raced);
    }
  };

  const commit: Idempotency["commit"] = (c, status, body, writes) => {
    const text = JSON.stringify(body);
    const scope = c.get("idem");
    if (!scope) {
      if (writes) tx(db, writes);
      return new Response(text, { status, headers: { "content-type": "application/json" } });
    }
    const raced = tx(db, () => {
      const row = lookup(scope);
      if (row) return row;
      writes?.();
      if (status < 500) store(scope, status, text);
      return undefined;
    });
    if (raced) {
      scope.stored = true;
      return outcome(scope, raced);
    }
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };

  return { middleware, commit };
}
