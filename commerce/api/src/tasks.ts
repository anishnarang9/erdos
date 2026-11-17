// Durable draft and compile work. The HTTP request returns before the handler runs.
import type { Handler } from "hono";
import canonicalize from "canonicalize";
import { ApiError, ERROR_STATUS, type ErrorCode } from "./errors.ts";
import { tx } from "./db.ts";
import { isoAt, parseJson, readBody, sha256, ULID_RE, type AppContext, type AppEnv, type Deps, type Principal } from "./context.ts";
import { requireApiKey } from "./identity.ts";
import type { ModelUsage } from "./grok.ts";
import { expensiveGuard } from "./limits.ts";
import { isPlainObject } from "./revision.ts";
import type { RouteContext } from "./routes.ts";

const COMPILE_LIMIT = 1;
const DRAFT_LIMIT = 2;
const DEDUP_STATES = ["queued", "running", "succeeded", "uncertain"];
const RELEASE_CODES = new Set([
  "validation_failed",
  "model_unavailable",
  "not_found",
  "unauthorized",
  "forbidden",
  "payload_too_large",
  "approval_required",
  "wrong_state",
  "revision_conflict",
]);

interface TaskRow {
  id: string;
  owner_wallet: string;
  operation: string;
  input_json: string;
  input_hash: string;
  state: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

type TaskHandlers = {
  draft: Handler<AppEnv>;
  compile: Handler<AppEnv>;
};

function unauthorized(): ApiError {
  return new ApiError("unauthorized", "Missing or invalid API key");
}

function hashInput(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new ApiError("validation_failed", "Task input cannot be canonicalized");
  return sha256(text).toString("hex");
}

function dayStart(ms: number): string {
  const date = new Date(ms);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function taskView(row: TaskRow): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: row.id,
    operation: row.operation,
    state: row.state,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.result_json) view.result = JSON.parse(row.result_json) as unknown;
  if (row.error_json) view.error = JSON.parse(row.error_json) as unknown;
  return view;
}

function taskError(err: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  return { code: "internal", message: "Internal server error" };
}

function taskContext(wallet: string, json: unknown, jobId = "", taskId = ""): AppContext {
  const principal: Principal = { kind: "wallet", wallet, keyId: "task", scopes: ["buyer"] };
  const values = new Map<string, unknown>([
    ["principal", principal],
    ["caller", wallet],
    ["json", json],
    ["taskId", taskId],
  ]);
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
    req: { param: (name: string) => (name === "id" ? jobId : undefined) },
  } as unknown as AppContext;
}

export function usageComplete(usage: ModelUsage | null | undefined): usage is ModelUsage {
  if (!usage) return false;
  if (!Number.isSafeInteger(usage.promptTokens) || usage.promptTokens < 0) return false;
  if (!Number.isSafeInteger(usage.completionTokens) || usage.completionTokens < 0) return false;
  if (usage.cachedTokens !== null && (!Number.isSafeInteger(usage.cachedTokens) || usage.cachedTokens < 0 || usage.cachedTokens > usage.promptTokens)) return false;
  if (usage.reasoningTokens !== null && (!Number.isSafeInteger(usage.reasoningTokens) || usage.reasoningTokens < 0 || usage.reasoningTokens > usage.completionTokens)) return false;
  return true;
}

function ceilTokens(tokens: number, microUsdPerMillion: number): number | null {
  if (tokens === 0) return 0;
  if (microUsdPerMillion <= 0 || tokens > Math.floor(Number.MAX_SAFE_INTEGER / microUsdPerMillion)) return null;
  return Math.ceil((tokens * microUsdPerMillion) / 1_000_000);
}

/** Prices the provider token counts. Missing or inconsistent usage returns null. Ticks are ignored. */
export function quoteAuthoringCost(usage: ModelUsage, budget: NonNullable<Deps["budget"]>): number | null {
  if (!usageComplete(usage)) return null;
  const cached = usage.cachedTokens ?? 0;
  const cachedPrice = budget.cachedInputMicroUsdPerMillion ?? budget.inputMicroUsdPerMillion;
  const parts = [
    ceilTokens(usage.promptTokens - cached, budget.inputMicroUsdPerMillion),
    ceilTokens(cached, cachedPrice),
    ceilTokens(usage.completionTokens, budget.outputMicroUsdPerMillion),
  ];
  if (parts.some((part) => part === null)) return null;
  const sum = (parts as number[]).reduce((total, part) => total + part, 0);
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}

export function noteDraftDispatch(db: Deps["db"], taskId: string, at: string): void {
  db.prepare(
    "UPDATE spend_reservations SET dispatched_at = COALESCE(dispatched_at, ?), updated_at = ? WHERE task_id = ? AND state = 'reserved'",
  ).run(at, at, taskId);
}

export function noteDraftUsage(db: Deps["db"], taskId: string, usageJson: string, at: string): void {
  db.prepare(
    "UPDATE spend_reservations SET usage_json = ?, updated_at = ? WHERE task_id = ? AND state = 'reserved'",
  ).run(usageJson, at, taskId);
}

/** Accepts a positive integer price. Zero is not a price. */
export function assertAuthoringBudget(budget: Deps["budget"]): void {
  if (!budget) return;
  const fields: [string, number][] = [
    ["requestCeilingMicroUsd", budget.requestCeilingMicroUsd],
    ["dailyCeilingMicroUsd", budget.dailyCeilingMicroUsd],
    ["inputMicroUsdPerMillion", budget.inputMicroUsdPerMillion],
    ["outputMicroUsdPerMillion", budget.outputMicroUsdPerMillion],
  ];
  if (budget.cachedInputMicroUsdPerMillion !== undefined) {
    fields.push(["cachedInputMicroUsdPerMillion", budget.cachedInputMicroUsdPerMillion]);
  }
  for (const [name, value] of fields) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`createApp: budget.${name} must be a positive integer`);
    }
  }
}

export function registerTaskRoutes(
  ctx: RouteContext,
  handlers: TaskHandlers,
): {
  reconcileTasks: () => void;
  pumpTasks: () => Promise<void>;
  withCompileSlot: <T>(run: () => Promise<T>) => Promise<T>;
} {
  const { app, deps, buyer, idem, newId } = ctx;
  const { db } = deps;
  const expensive = expensiveGuard(deps);
  const insertTask = db.prepare(
    "INSERT INTO tasks (id, owner_wallet, operation, input_json, input_hash, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)",
  );
  const findDup = db.prepare(
    `SELECT * FROM tasks WHERE owner_wallet = ? AND operation = ? AND input_hash = ? AND state IN (${DEDUP_STATES.map(() => "?").join(", ")}) ORDER BY created_at ASC, id ASC LIMIT 1`,
  );
  const byId = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const jobOwner = db.prepare("SELECT owner_wallet FROM jobs WHERE id = ?");
  const queued = db.prepare(
    "SELECT * FROM tasks WHERE state = 'queued' AND operation = ? ORDER BY created_at ASC, id ASC LIMIT ?",
  );
  const runningCount = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state = 'running' AND operation = ?");
  const markRunning = db.prepare(
    "UPDATE tasks SET state = 'running', attempt = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
  );
  const finish = db.prepare(
    "UPDATE tasks SET state = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ? AND state = 'running'",
  );
  const requeueCompiles = db.prepare(
    "UPDATE tasks SET state = 'queued', updated_at = ? WHERE state = 'running' AND operation = 'compile'",
  );
  const uncertainDrafts = db.prepare(
    "UPDATE tasks SET state = 'uncertain', updated_at = ? WHERE state = 'running' AND operation = 'draft'",
  );
  const uncertainReserved = db.prepare(
    "UPDATE spend_reservations SET state = 'uncertain', updated_at = ? WHERE state = 'reserved' AND task_id IN (SELECT id FROM tasks WHERE state = 'uncertain' AND operation = 'draft')",
  );
  const insertReservation = db.prepare(
    "INSERT INTO spend_reservations (id, owner_wallet, task_id, purpose, ceiling_micro_usd, state, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, 'reserved', ?, ?)",
  );
  const spentToday = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN state = 'settled' AND settled_micro_usd IS NOT NULL THEN settled_micro_usd ELSE ceiling_micro_usd END), 0) AS spent
     FROM spend_reservations WHERE state IN ('reserved', 'settled', 'uncertain') AND created_at >= ?`,
  );
  const settleUnknown = db.prepare(
    "UPDATE spend_reservations SET state = 'uncertain', updated_at = ? WHERE task_id = ? AND state = 'reserved'",
  );
  const settleKnown = db.prepare(
    "UPDATE spend_reservations SET state = 'settled', settled_micro_usd = ?, updated_at = ? WHERE task_id = ? AND state = 'reserved' AND ? <= ceiling_micro_usd",
  );
  const releaseReservation = db.prepare(
    "UPDATE spend_reservations SET state = 'released', updated_at = ? WHERE task_id = ? AND state = 'reserved' AND dispatched_at IS NULL",
  );
  const dispatchState = db.prepare("SELECT dispatched_at FROM spend_reservations WHERE task_id = ?");

  const walletOf = (c: AppContext): string => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "wallet") throw unauthorized();
    return principal.wallet;
  };

  const requireCompileOwner = async (c: AppContext, next: () => Promise<void>): Promise<void> => {
    const wallet = walletOf(c);
    const body = c.get("json");
    if (isPlainObject(body) && body.operation === "compile" && typeof body.jobId === "string") {
      if (!ULID_RE.test(body.jobId)) throw new ApiError("not_found", "Job not found");
      const row = jobOwner.get(body.jobId) as { owner_wallet: string | null } | undefined;
      if (!row || row.owner_wallet !== wallet) throw new ApiError("not_found", "Job not found");
    }
    await next();
  };

  app.post("/v1/tasks", readBody, buyer, parseJson, idem.middleware, requireCompileOwner, expensive, (c) => {
    const wallet = walletOf(c);
    const body = c.get("json");
    if (!isPlainObject(body)) throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "", message: "body must be a JSON object" }] });
    const operation = body.operation;
    if (operation !== "draft" && operation !== "compile") {
      throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "/operation", message: "must be draft or compile" }] });
    }
    let input: unknown;
    if (operation === "draft") {
      const keys = Object.keys(body);
      if (keys.some((key) => key !== "operation" && key !== "input")) {
        throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "", message: "unknown field" }] });
      }
      if (!isPlainObject(body.input)) {
        throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "/input", message: "must be a JSON object" }] });
      }
      if (deps.deployment.mode === "public" && !deps.budget) {
        throw new ApiError("model_unavailable", "Authoring price is not configured");
      }
      if (!deps.draftModel) throw new ApiError("model_unavailable", "No draft model configured");
      input = body.input;
    } else {
      const keys = Object.keys(body);
      if (keys.some((key) => key !== "operation" && key !== "jobId" && key !== "revisionHash")) {
        throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "", message: "unknown field" }] });
      }
      if (typeof body.jobId !== "string" || !ULID_RE.test(body.jobId)) throw new ApiError("not_found", "Job not found");
      if (typeof body.revisionHash !== "string" || body.revisionHash === "") {
        throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "/revisionHash", message: "required string" }] });
      }
      input = { jobId: body.jobId, revisionHash: body.revisionHash.toLowerCase() };
    }
    const inputJson = canonicalize(input);
    if (inputJson === undefined) throw new ApiError("validation_failed", "Task input cannot be canonicalized");
    const inputHash = hashInput(input);
    const at = isoAt(deps.now());
    const created = tx(db, () => {
      const existing = findDup.get(wallet, operation, inputHash, ...DEDUP_STATES) as TaskRow | undefined;
      if (existing) return existing;
      const id = newId();
      if (operation === "draft" && deps.budget) {
        const spent = Number((spentToday.get(dayStart(deps.now())) as { spent: number }).spent);
        if (spent + deps.budget.requestCeilingMicroUsd > deps.budget.dailyCeilingMicroUsd) {
          throw new ApiError("rate_limited", "Authoring budget is exhausted");
        }
        insertReservation.run(newId(), wallet, id, deps.budget.requestCeilingMicroUsd, at, at);
      }
      insertTask.run(id, wallet, operation, inputJson, inputHash, at, at);
      return byId.get(id) as unknown as TaskRow;
    });
    return c.json(taskView(created), 202);
  });

  app.get("/v1/tasks/:id", readBody, requireApiKey(deps), (c) => {
    const wallet = walletOf(c);
    const row = byId.get(c.req.param("id") ?? "") as TaskRow | undefined;
    if (!row || row.owner_wallet !== wallet) throw new ApiError("not_found", "Task not found");
    return c.json(taskView(row));
  });

  const reconcileTasks = (): void => {
    const at = isoAt(deps.now());
    tx(db, () => {
      uncertainDrafts.run(at);
      uncertainReserved.run(at);
      requeueCompiles.run(at);
    });
  };

  const execute = async (row: TaskRow): Promise<unknown> => {
    const input = JSON.parse(row.input_json) as unknown;
    if (row.operation === "compile") {
      const jobId = (input as { jobId: string }).jobId;
      const owned = jobOwner.get(jobId) as { owner_wallet: string | null } | undefined;
      if (!owned || owned.owner_wallet !== row.owner_wallet) throw new ApiError("not_found", "Job not found");
    }
    const response = row.operation === "draft"
      ? await handlers.draft(taskContext(row.owner_wallet, input, "", row.id), async () => {})
      : await handlers.compile(
          taskContext(row.owner_wallet, { revisionHash: (input as { revisionHash: string }).revisionHash }, (input as { jobId: string }).jobId),
          async () => {},
        );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError("internal", "Internal server error");
    }
    if (response.status >= 400) {
      const body = isPlainObject(parsed) && isPlainObject(parsed.error) ? parsed.error : {};
      const code = typeof body.code === "string" && body.code in ERROR_STATUS ? body.code as ErrorCode : "internal";
      const message = code === "internal" || typeof body.message !== "string" ? "Internal server error" : body.message;
      throw new ApiError(code, message, isPlainObject(body.details) ? body.details : undefined);
    }
    return parsed;
  };

  let compileLock: Promise<void> = Promise.resolve();
  /** One compiler for queued compiles and paid compiles. The next caller waits for the current one. */
  const withCompileSlot = <T>(run: () => Promise<T>): Promise<T> => {
    const previous = compileLock;
    let unlock!: () => void;
    compileLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    return previous.then(run, run).finally(unlock);
  };

  const runOne = async (row: TaskRow): Promise<void> => {
    const at = () => isoAt(deps.now());
    const applyBilling = (result: unknown, id: string): void => {
      const billing = isPlainObject(result) && isPlainObject(result.billing) ? result.billing : null;
      const microUsd = billing?.microUsd;
      if (billing?.state === "settled" && Number.isSafeInteger(microUsd) && (microUsd as number) >= 0) {
        const updated = settleKnown.run(microUsd as number, at(), id, microUsd as number);
        if (Number(updated.changes) === 1) return;
      }
      settleUnknown.run(at(), id);
    };
    const work = async (): Promise<void> => {
      try {
        const result = await execute(row);
        finish.run("succeeded", JSON.stringify(result), null, at(), row.id);
        if (row.operation === "draft") applyBilling(result, row.id);
      } catch (err) {
        const error = taskError(err);
        finish.run("failed", null, JSON.stringify(error), at(), row.id);
        if (row.operation !== "draft") return;
        const dispatched = dispatchState.get(row.id) as { dispatched_at: string | null } | undefined;
        if (!dispatched?.dispatched_at && RELEASE_CODES.has(error.code)) releaseReservation.run(at(), row.id);
        else settleUnknown.run(at(), row.id);
      }
    };
    if (row.operation === "compile") await withCompileSlot(work);
    else await work();
  };

  let pumping = false;
  const pumpTasks = async (): Promise<void> => {
    // Emergency disable blocks new accepts and also blocks dispatch of work already queued.
    if (deps.expensiveDisabled || pumping) return;
    pumping = true;
    try {
      const claimed = tx(db, () => {
        const rows: TaskRow[] = [];
        const at = isoAt(deps.now());
        for (const [operation, limit] of [["compile", COMPILE_LIMIT], ["draft", DRAFT_LIMIT]] as const) {
          const active = Number((runningCount.get(operation) as { n: number }).n);
          const room = limit - active;
          if (room <= 0) continue;
          for (const row of queued.all(operation, room) as unknown as TaskRow[]) {
            const updated = markRunning.run(row.attempt + 1, at, row.id);
            if (Number(updated.changes) !== 1) continue;
            rows.push({ ...row, state: "running", attempt: row.attempt + 1, updated_at: at });
          }
        }
        return rows;
      });
      await Promise.all(claimed.map((row) => runOne(row)));
    } finally {
      pumping = false;
    }
  };

  return { reconcileTasks, pumpTasks, withCompileSlot };
}
