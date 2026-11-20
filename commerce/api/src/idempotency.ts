import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";
import { tx } from "./db.ts";
import { requireRealArtifact } from "./artifact.ts";
import { requireChain } from "./chain.ts";
import { assertBotApproved } from "./bot-review-gate.ts";
import { isoAt, sha256, type AppContext, type AppEnv, type Deps, type IdempotencyScope } from "./context.ts";

const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

interface StoredRow {
  request_hash: string;
  status: number;
  response_json: string;
}

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export interface Idempotency {
  middleware: MiddlewareHandler<AppEnv>;
  /**
   * Runs the handler's writes and stores its response in one transaction, then returns the response.
   * If a concurrent request with the same scope stored first, the writes are rolled back and that
   * request's outcome (replay or 422) is returned instead.
   * A write function may return the response when the body is known only after the writes.
   */
  commit: (c: AppContext, status: number, body: unknown, writes?: () => void | IdempotentResult) => Response;
}

export function idempotency(deps: Deps): Idempotency {
  const { db } = deps;
  const select = db.prepare(
    "SELECT request_hash, status, response_json FROM idempotency WHERE key = ? AND method = ? AND route = ? AND caller = ?",
  );
  const insert = db.prepare(
    `INSERT INTO idempotency (key, method, route, caller, request_hash, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key, method, route, caller) DO UPDATE SET
       status = excluded.status, response_json = excluded.response_json, created_at = excluded.created_at
     WHERE idempotency.status = 429 AND idempotency.request_hash = excluded.request_hash`,
  );

  const lookup = (s: IdempotencyScope): StoredRow | undefined => {
    const row = select.get(s.key, s.method, s.path, s.caller) as StoredRow | undefined;
    // Retain the request binding on throttled keys, but recheck admission on an exact retry.
    return row?.status === 429 && row.request_hash === s.requestHash ? undefined : row;
  };

  const outcome = (s: IdempotencyScope, row: StoredRow): Response => {
    if (row.request_hash !== s.requestHash) {
      throw new ApiError(
        "idempotency_key_reused",
        "Idempotency-Key was already used with a different request",
      );
    }
    const botGateRoute = /^\/v1\/jobs\/([^/]+)\/(approve|compile|select-quote|open-claim-terms)$/.exec(s.path);
    if (deps.botReview && row.status >= 200 && row.status < 300 && botGateRoute) {
      const current = db.prepare("SELECT current_revision_id FROM jobs WHERE id=?").get(botGateRoute[1]!);
      assertBotApproved(deps, String(current?.current_revision_id ?? ""));
    }
    const artifactRoute = /^\/v1\/jobs\/([^/]+)\/(compile|select-quote|funding-receipt)$/.exec(s.path);
    if (row.status >= 200 && row.status < 300 && artifactRoute) {
      const real = artifactRoute[2] === "compile" ? deps.engine.mode === "real" : requireChain(deps).mode === "arc";
      if (real) {
        const current = db.prepare("SELECT current_revision_id FROM jobs WHERE id = ?").get(artifactRoute[1]!);
        requireRealArtifact(db, String(current?.current_revision_id ?? ""));
      }
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
      const message = "Idempotency-Key header is required: 1-128 characters from [A-Za-z0-9_.:-]";
      throw new ApiError("validation_failed", message, {
        errors: [{ path: "/headers/idempotency-key", message }],
      });
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

  const responseFrom = (status: number, text: string): Response =>
    new Response(text, { status, headers: { "content-type": "application/json" } });

  const produce = (
    status: number,
    preset: string,
    writes?: () => void | IdempotentResult,
  ): { status: number; text: string } => {
    const written = writes?.();
    if (typeof written === "object" && written !== null && typeof written.status === "number" && "body" in written) {
      return { status: written.status, text: JSON.stringify(written.body) };
    }
    return { status, text: preset };
  };

  const commit: Idempotency["commit"] = (c, status, body, writes) => {
    const preset = JSON.stringify(body);
    const scope = c.get("idem");
    if (!scope) {
      const ready = writes ? tx(db, () => produce(status, preset, writes)) : { status, text: preset };
      return responseFrom(ready.status, ready.text);
    }
    let ready: { status: number; text: string } | undefined;
    const raced = tx(db, () => {
      const row = lookup(scope);
      if (row) return row;
      ready = produce(status, preset, writes);
      if (ready.status < 500) store(scope, ready.status, ready.text);
      return undefined;
    });
    if (raced) {
      scope.stored = true;
      return outcome(scope, raced);
    }
    if (!ready) throw new Error("idempotency commit produced no response");
    return responseFrom(ready.status, ready.text);
  };

  return { middleware, commit };
}
