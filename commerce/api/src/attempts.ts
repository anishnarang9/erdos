// Solver-reported attempt progress. Confirmed winner, payment, and refund stay on the open-job snapshot.
import type { MiddlewareHandler } from "hono";
import { isAddress } from "viem";
import { ApiError } from "./errors.ts";
import { isoAt, parseJson, readBody, requireJobId, type AppEnv } from "./context.ts";
import { requireApiKey } from "./identity.ts";
import { isPlainObject } from "./revision.ts";
import type { RouteContext } from "./routes.ts";

export const ATTEMPT_VERSION = 1;
export const ATTEMPT_PHASES = [
  "preparing",
  "proving",
  "proved",
  "rejected",
  "claim_broadcasting",
  "claim_sent",
  "claimed",
  "lost",
  "release_broadcasting",
  "release_sent",
  "released",
  "abandoned",
] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];
export const ATTEMPT_EVENT_BATCH = 20;
export const ATTEMPT_HISTORY_CAP = 200;
export const ATTEMPT_EVENT_PAGE = 50;
export const ATTEMPT_LIST_DEFAULT = 20;
export const ATTEMPT_LIST_MAX = 50;
export const ATTEMPT_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const ATTEMPT_REPORTED_AT_MIN = "2024-01-01T00:00:00.000Z";

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CHAIN_JOB = /^[1-9][0-9]{0,77}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const REPORTED_MIN_MS = Date.parse(ATTEMPT_REPORTED_AT_MIN);
const BODY_KEYS = ["version", "attemptId", "events", "chain", "reportedClaimTx", "reportedReleaseTx", "reportedWinner"];
const EVENT_KEYS = ["cursor", "reportedAt", "phase"];
const CHAIN_KEYS = ["chainId", "core", "adapter", "jobId"];

interface ParsedEvent {
  cursor: number;
  reportedAt: string;
  phase: AttemptPhase;
}

interface ParsedChain {
  chainId: number;
  core: string;
  adapter: string;
  jobId: string;
}

interface ParsedAttempt {
  attemptId: string;
  events: ParsedEvent[];
  chain?: ParsedChain;
  reportedClaimTx?: string;
  reportedReleaseTx?: string;
  reportedWinner?: string;
}

interface AttemptRow {
  attempt_id: string;
  job_id: string;
  solver: string;
  phase: string;
  chain_id: number | null;
  core: string | null;
  adapter: string | null;
  chain_job_id: string | null;
  reported_claim_tx: string | null;
  reported_release_tx: string | null;
  reported_winner: string | null;
  high_water: number;
  created_at: string;
}

interface EventRow {
  cursor: number;
  phase: string;
  reported_at: string;
  received_at: string;
}

interface LinkRow {
  chain_id: number;
  core: string;
  adapter: string;
  chain_job_id: string;
}

function validation(message: string, path: string): ApiError {
  return new ApiError("validation_failed", "Request validation failed", {
    errors: [{ path, message }],
  });
}

function phaseOf(value: unknown, path: string): AttemptPhase {
  if (typeof value !== "string" || !ATTEMPT_PHASES.includes(value as AttemptPhase)) {
    throw validation("must be a solver progress phase", path);
  }
  return value as AttemptPhase;
}

function reportedAt(value: unknown, path: string, nowMs: number): string {
  if (typeof value !== "string" || !ISO_MS.test(value)) throw validation("must be UTC milliseconds", path);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw validation("must be UTC milliseconds", path);
  if (ms < REPORTED_MIN_MS || ms > nowMs + ATTEMPT_CLOCK_SKEW_MS) {
    throw validation("is outside the accepted solver clock window", path);
  }
  return value;
}

function addressOf(value: unknown, path: string): string {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw validation("must be an address", path);
  return value.toLowerCase();
}

function hashOf(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw validation("must be 32-byte hex", path);
  return value.toLowerCase();
}

function chainJobId(value: unknown): string {
  if (typeof value !== "string" || !CHAIN_JOB.test(value) || BigInt(value) > MAX_UINT256) {
    throw validation("must be a positive decimal chain job id", "/chain/jobId");
  }
  return value;
}

function onlyKeys(body: Record<string, unknown>, keys: string[], path: string): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw validation("has unknown fields", path);
}

function parseChain(value: unknown): ParsedChain {
  if (!isPlainObject(value)) throw validation("must be an object", "/chain");
  onlyKeys(value, CHAIN_KEYS, "/chain");
  if (!Number.isSafeInteger(value.chainId) || (value.chainId as number) <= 0) {
    throw validation("must be a positive integer", "/chain/chainId");
  }
  return {
    chainId: value.chainId as number,
    core: addressOf(value.core, "/chain/core"),
    adapter: addressOf(value.adapter, "/chain/adapter"),
    jobId: chainJobId(value.jobId),
  };
}

function parseEvents(value: unknown, nowMs: number): ParsedEvent[] {
  if (!Array.isArray(value) || value.length > ATTEMPT_EVENT_BATCH) {
    throw validation(`must be an array of at most ${ATTEMPT_EVENT_BATCH} events`, "/events");
  }
  const events: ParsedEvent[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const path = `/events/${index}`;
    if (!isPlainObject(item)) throw validation("must be an object", path);
    onlyKeys(item, EVENT_KEYS, path);
    if (!Number.isSafeInteger(item.cursor) || (item.cursor as number) < 1 || (item.cursor as number) > 1_000_000) {
      throw validation("must be a positive integer", `${path}/cursor`);
    }
    events.push({
      cursor: item.cursor as number,
      reportedAt: reportedAt(item.reportedAt, `${path}/reportedAt`, nowMs),
      phase: phaseOf(item.phase, `${path}/phase`),
    });
  }
  return events;
}

function parseAttempt(body: unknown, nowMs: number): ParsedAttempt {
  if (!isPlainObject(body)) throw validation("body must be an object", "");
  onlyKeys(body, BODY_KEYS, "");
  if (body.version !== ATTEMPT_VERSION) throw validation("must be 1", "/version");
  if (typeof body.attemptId !== "string" || !ATTEMPT_ID.test(body.attemptId.toLowerCase())) {
    throw validation("must be a UUID version 4", "/attemptId");
  }
  return {
    attemptId: body.attemptId.toLowerCase(),
    events: parseEvents(body.events, nowMs),
    ...(body.chain === undefined ? {} : { chain: parseChain(body.chain) }),
    ...(body.reportedClaimTx === undefined ? {} : { reportedClaimTx: hashOf(body.reportedClaimTx, "/reportedClaimTx") }),
    ...(body.reportedReleaseTx === undefined ? {} : { reportedReleaseTx: hashOf(body.reportedReleaseTx, "/reportedReleaseTx") }),
    ...(body.reportedWinner === undefined ? {} : { reportedWinner: addressOf(body.reportedWinner, "/reportedWinner") }),
  };
}

function sameChain(chain: ParsedChain, row: { chain_id: number; core: string; adapter: string; chain_job_id: string }): boolean {
  return chain.chainId === row.chain_id
    && chain.core === row.core.toLowerCase()
    && chain.adapter === row.adapter.toLowerCase()
    && chain.jobId === row.chain_job_id;
}

function chainFromLink(link: LinkRow): ParsedChain {
  return {
    chainId: link.chain_id,
    core: link.core.toLowerCase(),
    adapter: link.adapter.toLowerCase(),
    jobId: link.chain_job_id,
  };
}

function chainFromRow(row: AttemptRow): ParsedChain | null {
  if (row.chain_id === null || row.core === null || row.adapter === null || row.chain_job_id === null) return null;
  return { chainId: row.chain_id, core: row.core, adapter: row.adapter, jobId: row.chain_job_id };
}

function keepOptional(posted: string | undefined, stored: string | null, field: string): string | null {
  if (posted === undefined) return stored;
  if (stored !== null && stored !== posted) {
    throw new ApiError("wrong_state", "Stored attempt field differs", { field });
  }
  return posted;
}

function summaryOf(row: AttemptRow): Record<string, unknown> {
  const chain = chainFromRow(row);
  return {
    attemptId: row.attempt_id,
    jobId: row.job_id,
    solver: row.solver,
    phase: row.phase,
    progress: "solver-reported",
    highWaterCursor: row.high_water,
    eventCount: row.high_water,
    confirmedPayment: false,
    confirmedWinner: null,
    confirmedRefund: false,
    receivedAt: row.created_at,
    chain,
    ...(row.reported_claim_tx ? { reportedClaimTx: row.reported_claim_tx } : {}),
    ...(row.reported_release_tx ? { reportedReleaseTx: row.reported_release_tx } : {}),
    ...(row.reported_winner ? { reportedWinner: row.reported_winner } : {}),
  };
}

function encodeCursor(createdAt: string, attemptId: string): string {
  return Buffer.from(`${createdAt}\n${attemptId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; attemptId: string } {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) throw validation("is malformed", "/cursor");
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const split = text.indexOf("\n");
  if (split < 0) throw validation("is malformed", "/cursor");
  const createdAt = text.slice(0, split);
  const attemptId = text.slice(split + 1);
  if (encodeCursor(createdAt, attemptId) !== cursor || !ISO_MS.test(createdAt) || !ATTEMPT_ID.test(attemptId)) {
    throw validation("is malformed", "/cursor");
  }
  return { createdAt, attemptId };
}

function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return ATTEMPT_LIST_DEFAULT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw validation("must be an integer from 1 to 50", "/limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ATTEMPT_LIST_MAX) {
    throw validation("must be an integer from 1 to 50", "/limit");
  }
  return limit;
}

function afterCursor(raw: string | undefined, highWater: number): number {
  if (raw === undefined) return 0;
  if (!DECIMAL.test(raw)) throw validation("must be an integer of at least 0", "/afterCursor");
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > highWater) {
    throw validation("is past the stored cursor", "/afterCursor");
  }
  return cursor;
}

/** Public solver progress for one API job. Publication does not change the bounty. */
export function registerAttemptRoutes(ctx: RouteContext): void {
  const { app, deps, idem } = ctx;
  const wallet: MiddlewareHandler<AppEnv> = requireApiKey(deps);
  const jobExists = deps.db.prepare("SELECT id, state FROM jobs WHERE id = ?");
  const linkOf = deps.db.prepare(
    "SELECT chain_id, core, adapter, chain_job_id FROM open_claim_links WHERE job_id = ?",
  );
  const attemptOf = deps.db.prepare("SELECT * FROM solver_attempts WHERE attempt_id = ?");
  const attemptForJob = deps.db.prepare("SELECT * FROM solver_attempts WHERE attempt_id = ? AND job_id = ?");
  const eventsOf = deps.db.prepare(
    "SELECT cursor, phase, reported_at, received_at FROM solver_attempt_events WHERE attempt_id = ? ORDER BY cursor ASC",
  );
  const eventPage = deps.db.prepare(
    "SELECT cursor, phase, reported_at, received_at FROM solver_attempt_events WHERE attempt_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
  );
  const listFirst = deps.db.prepare(
    "SELECT * FROM solver_attempts WHERE job_id = ? ORDER BY created_at ASC, attempt_id ASC LIMIT ?",
  );
  const listAfter = deps.db.prepare(
    `SELECT * FROM solver_attempts
     WHERE job_id = ? AND (created_at > ? OR (created_at = ? AND attempt_id > ?))
     ORDER BY created_at ASC, attempt_id ASC LIMIT ?`,
  );
  const insertAttempt = deps.db.prepare(
    `INSERT INTO solver_attempts (
      attempt_id, job_id, solver, phase, chain_id, core, adapter, chain_job_id,
      reported_claim_tx, reported_release_tx, reported_winner, high_water, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateAttempt = deps.db.prepare(
    `UPDATE solver_attempts
     SET phase = ?, chain_id = ?, core = ?, adapter = ?, chain_job_id = ?,
         reported_claim_tx = ?, reported_release_tx = ?, reported_winner = ?, high_water = ?
     WHERE attempt_id = ?`,
  );
  const insertEvent = deps.db.prepare(
    "INSERT INTO solver_attempt_events (attempt_id, cursor, phase, reported_at, received_at) VALUES (?, ?, ?, ?, ?)",
  );

  const loadJob = (jobId: string): void => {
    if (!jobExists.get(jobId)) throw new ApiError("not_found", "Job not found");
  };

  app.post("/v1/jobs/:id/attempts", readBody, wallet, parseJson, requireJobId, idem.middleware, (c) => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "wallet") throw new ApiError("unauthorized", "Missing or invalid API key");
    const parsed = parseAttempt(c.get("json"), deps.now());
    const jobId = c.req.param("id") ?? "";
    const solver = principal.wallet;
    return idem.commit(c, 200, {}, () => {
      loadJob(jobId);
      const link = linkOf.get(jobId) as unknown as LinkRow | undefined;
      const existing = attemptOf.get(parsed.attemptId) as unknown as AttemptRow | undefined;
      if (existing && existing.solver !== solver) {
        throw new ApiError("forbidden", "Attempt is owned by another wallet");
      }
      if (existing && existing.job_id !== jobId) {
        throw new ApiError("wrong_state", "Attempt is bound to another job");
      }
      const storedChain = existing ? chainFromRow(existing) : null;
      let chain: ParsedChain | null = storedChain;
      if (parsed.chain) {
        if (!link || !sameChain(parsed.chain, link)) {
          throw new ApiError("terms_mismatch", "Confirmed chain binding differs from the posted attempt", { field: "chain" });
        }
        if (storedChain && !sameChain(parsed.chain, {
          chain_id: storedChain.chainId,
          core: storedChain.core,
          adapter: storedChain.adapter,
          chain_job_id: storedChain.jobId,
        })) {
          throw new ApiError("terms_mismatch", "Confirmed chain binding differs from the posted attempt", { field: "chain" });
        }
        chain = parsed.chain;
      } else if (!storedChain && link) {
        chain = chainFromLink(link);
      }
      const claimTx = keepOptional(parsed.reportedClaimTx, existing?.reported_claim_tx ?? null, "reportedClaimTx");
      const releaseTx = keepOptional(parsed.reportedReleaseTx, existing?.reported_release_tx ?? null, "reportedReleaseTx");
      const winner = keepOptional(parsed.reportedWinner, existing?.reported_winner ?? null, "reportedWinner");
      const stored = existing ? eventsOf.all(existing.attempt_id) as unknown as EventRow[] : [];
      const byCursor = new Map(stored.map((event) => [event.cursor, event]));
      const high = existing?.high_water ?? 0;
      const sorted = [...parsed.events].sort((left, right) => left.cursor - right.cursor);
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index]?.cursor === sorted[index - 1]?.cursor) throw validation("repeats a cursor", "/events");
      }
      const fresh: ParsedEvent[] = [];
      for (const event of sorted) {
        const prior = byCursor.get(event.cursor);
        if (prior) {
          if (prior.phase !== event.phase || prior.reported_at !== event.reportedAt) {
            throw new ApiError("wrong_state", "Stored attempt cursor differs", { field: "cursor" });
          }
          continue;
        }
        fresh.push(event);
      }
      if (!existing && fresh.length === 0) throw validation("must include the first event", "/events");
      if (fresh.length > 0) {
        if (fresh[0]?.cursor !== high + 1) {
          throw new ApiError("wrong_state", "Attempt cursor is not contiguous", { field: "cursor" });
        }
        for (let index = 1; index < fresh.length; index += 1) {
          if (fresh[index]?.cursor !== (fresh[index - 1]?.cursor ?? 0) + 1) {
            throw new ApiError("wrong_state", "Attempt cursor is not contiguous", { field: "cursor" });
          }
        }
      }
      const nextHigh = high + fresh.length;
      if (nextHigh > ATTEMPT_HISTORY_CAP) {
        throw new ApiError("payload_too_large", "Attempt history exceeds 200 events", { limit: ATTEMPT_HISTORY_CAP });
      }
      const phase = fresh.length > 0 ? fresh[fresh.length - 1]!.phase : existing!.phase;
      const receivedAt = isoAt(deps.now());
      if (!existing) {
        insertAttempt.run(
          parsed.attemptId, jobId, solver, phase,
          chain?.chainId ?? null, chain?.core ?? null, chain?.adapter ?? null, chain?.jobId ?? null,
          claimTx, releaseTx, winner, nextHigh, receivedAt,
        );
      } else {
        updateAttempt.run(
          phase,
          chain?.chainId ?? null, chain?.core ?? null, chain?.adapter ?? null, chain?.jobId ?? null,
          claimTx, releaseTx, winner, nextHigh, parsed.attemptId,
        );
      }
      for (const event of fresh) insertEvent.run(parsed.attemptId, event.cursor, event.phase, event.reportedAt, receivedAt);
      const row = attemptForJob.get(parsed.attemptId, jobId) as unknown as AttemptRow;
      const acknowledged = sorted.map((event) => {
        const prior = byCursor.get(event.cursor);
        return {
          attemptId: parsed.attemptId,
          cursor: event.cursor,
          reportedAt: event.reportedAt,
          receivedAt: prior?.received_at ?? receivedAt,
          phase: event.phase,
        };
      });
      return {
        status: existing ? 200 : 201,
        body: { ...summaryOf(row), accepted: fresh.length, events: acknowledged },
      };
    });
  });

  app.get("/v1/jobs/:id/attempts", readBody, requireJobId, (c) => {
    const jobId = c.req.param("id") ?? "";
    loadJob(jobId);
    const limit = pageLimit(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
    const rows = (cursor === undefined
      ? listFirst.all(jobId, limit + 1)
      : listAfter.all(jobId, cursor.createdAt, cursor.createdAt, cursor.attemptId, limit + 1)) as unknown as AttemptRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      attempts: page.map(summaryOf),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.attempt_id) : null,
    });
  });

  app.get("/v1/jobs/:id/attempts/:attemptId", readBody, requireJobId, (c) => {
    const jobId = c.req.param("id") ?? "";
    loadJob(jobId);
    const attemptId = (c.req.param("attemptId") ?? "").toLowerCase();
    if (!ATTEMPT_ID.test(attemptId)) throw new ApiError("not_found", "Attempt not found");
    const row = attemptForJob.get(attemptId, jobId) as unknown as AttemptRow | undefined;
    if (!row) throw new ApiError("not_found", "Attempt not found");
    const cursor = afterCursor(c.req.query("afterCursor"), row.high_water);
    const rows = eventPage.all(attemptId, cursor, ATTEMPT_EVENT_PAGE + 1) as unknown as EventRow[];
    const page = rows.slice(0, ATTEMPT_EVENT_PAGE);
    const tail = page[page.length - 1];
    return c.json({
      ...summaryOf(row),
      events: page.map((event) => ({
        attemptId,
        cursor: event.cursor,
        reportedAt: event.reported_at,
        receivedAt: event.received_at,
        phase: event.phase,
      })),
      nextCursor: row.high_water,
      resumeCursor: rows.length > ATTEMPT_EVENT_PAGE && tail ? tail.cursor : null,
    });
  });
}
