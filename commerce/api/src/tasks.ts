// Durable draft and compile work. The HTTP request returns before the handler runs.
import { timingSafeEqual } from "node:crypto";
import type { Handler } from "hono";
import canonicalize from "canonicalize";
import { ApiError, ERROR_STATUS, type ErrorCode } from "./errors.ts";
import { tx } from "./db.ts";
import { isoAt, parseJson, readBody, sha256, ULID_RE, type AppContext, type AppEnv, type Deps, type Principal } from "./context.ts";
import { requireApiKey } from "./identity.ts";
import type { ModelUsage } from "./grok.ts";
import { cancelEngineChildren } from "./engine.ts";
import { cancelDraftRequests } from "./draft-deadline.ts";
import { expensiveGuard } from "./limits.ts";
import { noteQueueRejected, noteTaskAccepted, noteTaskFinished } from "./observe.ts";
import { isPlainObject } from "./revision.ts";
import type { RouteContext } from "./routes.ts";

function bearerMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const COMPILE_LIMIT = 1;
const DRAFT_LIMIT = 2;
/** Bound for stopping new work and reconciling owned compiler children before exit. */
export const TASK_DRAIN_MS = 2_000;
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

function sqlCount(value: unknown): number {
  const row = value as { n?: number | bigint } | undefined;
  const raw = row?.n ?? 0;
  const count = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) return Number.POSITIVE_INFINITY;
  return count;
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
  if (usage.reasoningTokens !== null && (!Number.isSafeInteger(usage.reasoningTokens) || usage.reasoningTokens < 0)) return false;
  return true;
}

function ceilTokens(tokens: number, microUsdPerMillion: number): number | null {
  if (tokens === 0) return 0;
  if (microUsdPerMillion <= 0 || tokens > Math.floor(Number.MAX_SAFE_INTEGER / microUsdPerMillion)) return null;
  return Math.ceil((tokens * microUsdPerMillion) / 1_000_000);
}

/** Tariff estimate from token prices. Missing or inconsistent usage returns null. Actual ticks are ignored. */
export function quoteAuthoringCost(usage: ModelUsage, budget: NonNullable<Deps["budget"]>): number | null {
  if (!usageComplete(usage) || usage.reasoningTokens === null || usage.promptTokens === 0) return null;
  // Every authoring call contains a nonempty system prompt and schema. A zero prompt count cannot price it.
  // Provider formats differ on whether completion_tokens includes reasoning. Sum them for a conservative tariff.
  const generated = usage.completionTokens + usage.reasoningTokens;
  if (!Number.isSafeInteger(generated)) return null;
  const cached = usage.cachedTokens ?? 0;
  const cachedPrice = budget.cachedInputMicroUsdPerMillion ?? budget.inputMicroUsdPerMillion;
  const parts = [
    ceilTokens(usage.promptTokens - cached, budget.inputMicroUsdPerMillion),
    ceilTokens(cached, cachedPrice),
    ceilTokens(generated, budget.outputMicroUsdPerMillion),
  ];
  if (parts.some((part) => part === null)) return null;
  const sum = (parts as number[]).reduce((total, part) => total + part, 0);
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}

/** 10^10 ticks per USD, and 10^6 micro-USD per USD, so 10^4 ticks per micro-USD. */
const TICKS_PER_MICRO_USD = 10_000n;

/** Converts an actual xAI tick count into micro-USD. Rounds a partial micro-USD up. */
export function ticksToMicroUsd(ticks: number): number | null {
  if (!Number.isSafeInteger(ticks) || ticks < 0) return null;
  const micro = (BigInt(ticks) + TICKS_PER_MICRO_USD - 1n) / TICKS_PER_MICRO_USD;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(micro);
}

export interface AuthoringCharge {
  microUsd: number;
  source: "actual" | "tariff";
  costInUsdTicks: number | null;
}

/** Uses the provider's actual tick charge when it is a safe nonnegative integer. Otherwise uses the tariff. */
export function authoringCharge(usage: ModelUsage, budget: NonNullable<Deps["budget"]>): AuthoringCharge | null {
  if (!usageComplete(usage)) return null;
  if (usage.costInUsdTicks != null) {
    const microUsd = ticksToMicroUsd(usage.costInUsdTicks);
    if (microUsd !== null) return { microUsd, source: "actual", costInUsdTicks: usage.costInUsdTicks };
  }
  const microUsd = quoteAuthoringCost(usage, budget);
  if (microUsd === null) return null;
  return { microUsd, source: "tariff", costInUsdTicks: null };
}

/**
 * Worst-case tariff for one call. Prompt tokens use the higher of the input and cached prices,
 * because the cache split is not known before the provider answers.
 */
export function maxCallMicroUsd(
  promptTokens: number,
  completionTokens: number,
  budget: NonNullable<Deps["budget"]>,
): number | null {
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) return null;
  if (!Number.isSafeInteger(completionTokens) || completionTokens < 0) return null;
  const cachedPrice = budget.cachedInputMicroUsdPerMillion ?? budget.inputMicroUsdPerMillion;
  const prompt = ceilTokens(promptTokens, Math.max(budget.inputMicroUsdPerMillion, cachedPrice));
  const completion = ceilTokens(completionTokens, budget.outputMicroUsdPerMillion);
  if (prompt === null || completion === null) return null;
  const sum = prompt + completion;
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
  if (budget.reservationMode !== undefined && budget.reservationMode !== "provider-bound" && budget.reservationMode !== "estimated") {
    throw new Error("createApp: budget.reservationMode must be provider-bound or estimated");
  }
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
  drainTasks: (boundMs?: number) => Promise<void>;
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
  const pendingGlobal = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('queued', 'running')");
  const pendingWallet = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE state IN ('queued', 'running') AND owner_wallet = ?",
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
    "UPDATE spend_reservations SET state = 'settled', settled_micro_usd = ?, breach = ?, updated_at = ? WHERE task_id = ? AND state = 'reserved'",
  );
  const reservationCeiling = db.prepare("SELECT ceiling_micro_usd FROM spend_reservations WHERE task_id = ?");
  const releaseReservation = db.prepare(
    "UPDATE spend_reservations SET state = 'released', updated_at = ? WHERE task_id = ? AND state = 'reserved' AND dispatched_at IS NULL",
  );
  const dispatchState = db.prepare("SELECT dispatched_at FROM spend_reservations WHERE task_id = ?");
  const reservationIdentity = db.prepare("SELECT id, ceiling_micro_usd FROM spend_reservations WHERE task_id = ?");
  const openHalt = db.prepare("SELECT id FROM spend_halts WHERE resolved_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1");
  const haltById = db.prepare("SELECT id, resolved_at FROM spend_halts WHERE id = ?");
  const insertHalt = db.prepare(
    "INSERT INTO spend_halts (id, reservation_id, task_id, settled_micro_usd, ceiling_micro_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const resolveHalt = db.prepare(
    "UPDATE spend_halts SET resolved_at = ?, resolved_by = 'operator', resolution_note = ? WHERE id = ? AND resolved_at IS NULL",
  );
  const requeueDraft = db.prepare(
    "UPDATE tasks SET state = 'queued', attempt = MAX(attempt - 1, 0), updated_at = ? WHERE id = ? AND state = 'running' AND operation = 'draft'",
  );
  const requeueCompile = db.prepare(
    "UPDATE tasks SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running' AND operation = 'compile'",
  );
  const uncertainDraft = db.prepare(
    "UPDATE tasks SET state = 'uncertain', updated_at = ? WHERE id = ? AND state = 'running' AND operation = 'draft'",
  );

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
      if (deps.deployment.mode === "public" && deps.botReview?.pilotOwner
        && wallet !== deps.botReview.pilotOwner) {
        throw new ApiError("forbidden", "Authoring pilot wallet required");
      }
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
    // Task, reservation, and the idempotency response commit together.
    // A later different body for this key must not keep orphan paid work.
    let admitted = false;
    const response = idem.commit(c, 202, null, () => {
      const existing = findDup.get(wallet, operation, inputHash, ...DEDUP_STATES) as TaskRow | undefined;
      if (existing) return { status: 202, body: taskView(existing) };
      const pending = sqlCount(pendingGlobal.get());
      const mine = sqlCount(pendingWallet.get(wallet));
      const globalFull = pending >= deps.taskQueue.globalPending;
      const walletFull = mine >= deps.taskQueue.pendingPerWallet;
      if (globalFull || walletFull) {
        noteQueueRejected(deps, operation);
        throw new ApiError("rate_limited", "Task queue is full", {
          queue: "pending",
          scope: globalFull ? "global" : "wallet",
        });
      }
      const id = newId();
      if (operation === "draft" && deps.budget) {
        const spent = Number((spentToday.get(dayStart(deps.now())) as { spent: number }).spent);
        if (spent + deps.budget.requestCeilingMicroUsd > deps.budget.dailyCeilingMicroUsd) {
          throw new ApiError("rate_limited", "Authoring budget is exhausted");
        }
      }
      if (operation === "draft") {
        const halt = openHalt.get() as { id: string } | undefined;
        if (halt) throw new ApiError("service_disabled", "Authoring is halted after a spend breach", { haltId: halt.id });
      }
      if (operation === "draft" && deps.budget) {
        insertReservation.run(newId(), wallet, id, deps.budget.requestCeilingMicroUsd, at, at);
      }
      insertTask.run(id, wallet, operation, inputJson, inputHash, at, at);
      admitted = true;
      return { status: 202, body: taskView(byId.get(id) as unknown as TaskRow) };
    });
    if (admitted) noteTaskAccepted(deps, operation);
    return response;
  });

  app.post("/v1/operator/spend-halts/:id/resolve", readBody, parseJson, (c) => {
    if (!deps.operatorToken) throw new ApiError("not_found", "Not found");
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!bearerMatches(presented, deps.operatorToken)) throw new ApiError("unauthorized", "Unauthorized");
    const id = c.req.param("id") ?? "";
    const body = c.get("json");
    if (!isPlainObject(body)) {
      throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "", message: "body must be a JSON object" }] });
    }
    const unknown = Object.keys(body).filter((key) => key !== "note");
    if (unknown.length > 0) {
      throw new ApiError("validation_failed", "Request validation failed", { errors: unknown.map((key) => ({ path: `/${key}`, message: "unknown field" })) });
    }
    const note = body.note;
    if (typeof note !== "string" || note.trim() === "" || note.trim().length > 500) {
      throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path: "/note", message: "must be a string of 1 to 500 characters" }] });
    }
    const row = haltById.get(id) as { id: string; resolved_at: string | null } | undefined;
    if (!row) throw new ApiError("not_found", "Spend halt not found");
    if (row.resolved_at !== null) throw new ApiError("wrong_state", "The spend halt is already resolved");
    const at = isoAt(deps.now());
    const updated = resolveHalt.run(at, note.trim(), id);
    if (Number(updated.changes) !== 1) throw new ApiError("wrong_state", "The spend halt is already resolved");
    return c.json({ id, resolvedAt: at });
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

  const runOne = async (row: TaskRow): Promise<void> => {
    const at = () => isoAt(deps.now());
    const applyBilling = (result: unknown, id: string): void => {
      const billing = isPlainObject(result) && isPlainObject(result.billing) ? result.billing : null;
      const microUsd = billing?.microUsd;
      if (billing?.state === "settled" && typeof microUsd === "number" && Number.isSafeInteger(microUsd) && microUsd >= 0) {
        let settled = false;
        tx(db, () => {
          const ceilingRow = reservationCeiling.get(id) as { ceiling_micro_usd: number } | undefined;
          const overCeiling = typeof ceilingRow?.ceiling_micro_usd === "number" && microUsd > ceilingRow.ceiling_micro_usd;
          const breach = billing.breach === true || overCeiling ? 1 : 0;
          const updated = settleKnown.run(microUsd, breach, at(), id);
          if (Number(updated.changes) !== 1) return;
          settled = true;
          if (breach !== 1) return;
          const reservation = reservationIdentity.get(id) as { id: string; ceiling_micro_usd: number } | undefined;
          if (!reservation) return;
          insertHalt.run(newId(), reservation.id, id, microUsd, reservation.ceiling_micro_usd, at());
        });
        if (settled) return;
      }
      settleUnknown.run(at(), id);
    };
    const work = async (): Promise<void> => {
      try {
        const result = await execute(row);
        if (!db.isOpen) return;
        finish.run("succeeded", JSON.stringify(result), null, at(), row.id);
        noteTaskFinished(deps, row.operation, "succeeded");
        if (row.operation === "draft") applyBilling(result, row.id);
      } catch (err) {
        if (!db.isOpen) return;
        if (draining) {
          const stamp = at();
          if (row.operation === "compile") {
            requeueCompile.run(stamp, row.id);
            return;
          }
          const dispatched = dispatchState.get(row.id) as { dispatched_at: string | null } | undefined;
          if (dispatched?.dispatched_at) {
            uncertainDraft.run(stamp, row.id);
            settleUnknown.run(stamp, row.id);
            return;
          }
          requeueDraft.run(stamp, row.id);
          return;
        }
        const error = taskError(err);
        finish.run("failed", null, JSON.stringify(error), at(), row.id);
        noteTaskFinished(deps, row.operation, "failed", error.code);
        if (row.operation !== "draft") return;
        const details = err instanceof ApiError ? err.details : undefined;
        if (details && isPlainObject(details.billing)) {
          applyBilling({ billing: details.billing }, row.id);
          return;
        }
        const dispatched = dispatchState.get(row.id) as { dispatched_at: string | null } | undefined;
        if (!dispatched?.dispatched_at && RELEASE_CODES.has(error.code)) releaseReservation.run(at(), row.id);
        else settleUnknown.run(at(), row.id);
      }
    };
    if (row.operation === "draft" && openHalt.get()) {
      requeueDraft.run(at(), row.id);
      return;
    }
    if (row.operation === "compile") {
      try { await work(); } finally { deps.compileAdmission.releaseDurable(); }
    } else await work();
  };

  let pumping = false;
  let draining = false;
  let inflight: Promise<void> = Promise.resolve();
  const pumpTasks = async (): Promise<void> => {
    // Emergency disable blocks new accepts and also blocks dispatch of work already queued.
    // Draining refuses a new claim so a restarted process cannot overlap a child this process still owns.
    if (deps.expensiveDisabled || pumping || draining) return;
    pumping = true;
    deps.compileAdmission.beginPump();
    const run = (async () => {
      let compilerClaimed = false;
      let claimCommitted = false;
      try {
        const claimed = tx(db, () => {
          const rows: TaskRow[] = [];
          const at = isoAt(deps.now());
          const authoringHalted = openHalt.get() !== undefined;
          for (const [operation, limit] of [["compile", COMPILE_LIMIT], ["draft", DRAFT_LIMIT]] as const) {
            if (operation === "draft" && authoringHalted) continue;
            const active = Number((runningCount.get(operation) as { n: number }).n);
            const room = limit - active;
            if (room <= 0) continue;
            const candidates = queued.all(operation, room) as unknown as TaskRow[];
            if (operation === "compile" && candidates.length === 0) deps.compileAdmission.noteNoQueuedCompile();
            for (const row of candidates) {
              if (operation === "compile") {
                if (!deps.compileAdmission.tryDurable()) continue;
                compilerClaimed = true;
              }
              const updated = markRunning.run(row.attempt + 1, at, row.id);
              if (Number(updated.changes) !== 1) {
                if (operation === "compile") {
                  deps.compileAdmission.releaseDurable();
                  compilerClaimed = false;
                }
                continue;
              }
              rows.push({ ...row, state: "running", attempt: row.attempt + 1, updated_at: at });
            }
          }
          return rows;
        });
        claimCommitted = true;
        deps.compileAdmission.finishPump();
        await Promise.all(claimed.map((row) => runOne(row)));
      } finally {
        if (compilerClaimed && !claimCommitted) deps.compileAdmission.releaseDurable();
        deps.compileAdmission.finishPump();
        pumping = false;
      }
    })();
    inflight = run;
    try {
      await run;
    } finally {
      if (inflight === run) inflight = Promise.resolve();
    }
  };

  const drainTasks = async (boundMs = TASK_DRAIN_MS): Promise<void> => {
    draining = true;
    deps.compileAdmission.beginDrain();
    const drafts = cancelDraftRequests(deps);
    await cancelEngineChildren();
    await Promise.race([
      Promise.allSettled([inflight, drafts, ...deps.compileAdmission.owned()]),
      new Promise<void>((resolve) => setTimeout(resolve, boundMs)),
    ]);
    reconcileTasks();
    await cancelEngineChildren();
  };

  return { reconcileTasks, pumpTasks, drainTasks };
}
