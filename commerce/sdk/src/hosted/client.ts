/** Wallet-owned hosted API. Mutations require caller-chosen replay keys. */
export interface HostedClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface HostedKey {
  id: string;
  wallet: string;
  scopes: string[];
  createdAt: string;
}
export interface IssuedHostedKey extends HostedKey { key: string }
export interface HostedDiscoveryOptions { cursor?: string; limit?: number }
export interface HostedDiscoveryPage { jobs: unknown[]; nextCursor?: string | null }
export interface AuthChallenge { challengeId: string; message: string; expiresAt: string }
export type TaskState = "queued" | "running" | "succeeded" | "failed" | "uncertain";
export interface HostedTask {
  id: string;
  operation: "draft" | "compile";
  state: TaskState;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: { code: string; message: string };
}
export const HOSTED_ATTEMPT_PHASES = ["preparing", "proving", "proved", "rejected", "claim_broadcasting", "claim_sent", "claimed", "lost", "release_broadcasting", "release_sent", "released", "abandoned"] as const;
export type HostedAttemptPhase = typeof HOSTED_ATTEMPT_PHASES[number];
export interface HostedAttemptChain { chainId: number; core: string; adapter: string; jobId: string }
export interface HostedAttemptInput {
  version: 1; attemptId: string;
  events: readonly { cursor: number; reportedAt: string; phase: HostedAttemptPhase }[];
  chain?: HostedAttemptChain; reportedClaimTx?: string; reportedReleaseTx?: string; reportedWinner?: string;
}
export interface HostedAttemptSummary {
  attemptId: string; jobId: string; solver: string; phase: HostedAttemptPhase; progress: "solver-reported";
  highWaterCursor: number; eventCount: number; confirmedPayment: false; confirmedWinner: null; confirmedRefund: false;
  receivedAt: string; chain: HostedAttemptChain | null; reportedClaimTx?: string; reportedReleaseTx?: string; reportedWinner?: string;
}
export interface HostedAttemptEvent { attemptId: string; cursor: number; reportedAt: string; receivedAt: string; phase: HostedAttemptPhase }
export interface HostedAttemptPublication extends HostedAttemptSummary { accepted: number; events: HostedAttemptEvent[] }
export interface HostedAttemptDetail extends HostedAttemptSummary { events: HostedAttemptEvent[]; nextCursor: number; resumeCursor: number | null }
export interface HostedAttemptPage { attempts: HostedAttemptSummary[]; nextCursor: string | null }
const attemptInvalid = (): never => { throw new Error("Invalid hosted attempt data"); };
function attemptInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return attemptInvalid();
  return value;
}
function attemptUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return attemptInvalid();
  return value.toLowerCase();
}
function attemptIso(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return attemptInvalid();
  return value;
}
function attemptHex(value: unknown, bytes: number): string {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) return attemptInvalid();
  return value.toLowerCase();
}
function attemptPhase(value: unknown): HostedAttemptPhase {
  if (!HOSTED_ATTEMPT_PHASES.includes(value as HostedAttemptPhase)) return attemptInvalid();
  return value as HostedAttemptPhase;
}
function attemptFields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) attemptInvalid();
}
function attemptChain(value: unknown): HostedAttemptChain {
  const v = object(value); attemptFields(v, ["chainId", "core", "adapter", "jobId"]);
  if (typeof v.jobId !== "string" || !/^[1-9][0-9]{0,77}$/.test(v.jobId) || BigInt(v.jobId) > (1n << 256n) - 1n) return attemptInvalid();
  return { chainId: attemptInt(v.chainId, 1, Number.MAX_SAFE_INTEGER), core: attemptHex(v.core, 20), adapter: attemptHex(v.adapter, 20), jobId: v.jobId };
}
/** Reject private local-state fields before serializing an explicitly requested publication. */
export function hostedAttemptInput(value: unknown): HostedAttemptInput {
  const v = object(value); attemptFields(v, ["version", "attemptId", "events", "chain", "reportedClaimTx", "reportedReleaseTx", "reportedWinner"]);
  if (v.version !== 1 || !Array.isArray(v.events) || v.events.length > 20) return attemptInvalid();
  let previous = 0;
  const events = v.events.map(raw => {
    const event = object(raw); attemptFields(event, ["cursor", "reportedAt", "phase"]);
    const cursor = attemptInt(event.cursor, 1, 200); if (cursor <= previous) return attemptInvalid(); previous = cursor;
    return { cursor, reportedAt: attemptIso(event.reportedAt), phase: attemptPhase(event.phase) };
  });
  return { version: 1, attemptId: attemptUuid(v.attemptId), events,
    ...(v.chain === undefined ? {} : { chain: attemptChain(v.chain) }),
    ...(v.reportedClaimTx === undefined ? {} : { reportedClaimTx: attemptHex(v.reportedClaimTx, 32) }),
    ...(v.reportedReleaseTx === undefined ? {} : { reportedReleaseTx: attemptHex(v.reportedReleaseTx, 32) }),
    ...(v.reportedWinner === undefined ? {} : { reportedWinner: attemptHex(v.reportedWinner, 20) }),
  };
}
function attemptSummary(value: unknown, jobId: string, id?: string): HostedAttemptSummary {
  const v = object(value), attemptId = attemptUuid(v.attemptId), highWaterCursor = attemptInt(v.highWaterCursor, 1, 200);
  if (v.jobId !== jobId || (id !== undefined && attemptId !== attemptUuid(id)) || v.progress !== "solver-reported" || v.confirmedPayment !== false || v.confirmedWinner !== null || v.confirmedRefund !== false || v.eventCount !== highWaterCursor) return attemptInvalid();
  return { attemptId, jobId, solver: attemptHex(v.solver, 20), phase: attemptPhase(v.phase), progress: "solver-reported", highWaterCursor, eventCount: highWaterCursor,
    confirmedPayment: false, confirmedWinner: null, confirmedRefund: false, receivedAt: attemptIso(v.receivedAt), chain: v.chain === null ? null : attemptChain(v.chain),
    ...(v.reportedClaimTx === undefined ? {} : { reportedClaimTx: attemptHex(v.reportedClaimTx, 32) }),
    ...(v.reportedReleaseTx === undefined ? {} : { reportedReleaseTx: attemptHex(v.reportedReleaseTx, 32) }),
    ...(v.reportedWinner === undefined ? {} : { reportedWinner: attemptHex(v.reportedWinner, 20) }),
  };
}
function attemptEvents(value: unknown, summary: HostedAttemptSummary, cap: number): HostedAttemptEvent[] {
  if (!Array.isArray(value) || value.length > cap) return attemptInvalid();
  let previous = 0;
  return value.map(raw => {
    const event = object(raw), cursor = attemptInt(event.cursor, 1, summary.highWaterCursor);
    if (attemptUuid(event.attemptId) !== summary.attemptId || cursor <= previous) return attemptInvalid(); previous = cursor;
    return { attemptId: summary.attemptId, cursor, phase: attemptPhase(event.phase), reportedAt: attemptIso(event.reportedAt), receivedAt: attemptIso(event.receivedAt) };
  });
}
function attemptCursor(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\x00-\x20]/.test(value)) return attemptInvalid();
  return value;
}

export interface HostedReference { name: string; contentBase64: string }
export type HostedSubmission = { revision: unknown; references?: HostedReference[] } &
  ({ source: "import" } | { source: "grok"; draftId: string });
export interface WaitTaskOptions { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }
export class HostedApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Hosted API request failed (${status}, ${code})`);
    this.name = "HostedApiError";
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hosted API response");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid hosted API response field");
  return value;
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function keyView(value: unknown): HostedKey {
  const v = object(value);
  if (!Array.isArray(v.scopes) || !v.scopes.every(s => typeof s === "string")) throw new Error("Invalid key scopes");
  return { id: text(v.id), wallet: text(v.wallet), scopes: v.scopes, createdAt: text(v.createdAt) };
}
function taskView(value: unknown, expectedId?: string): HostedTask {
  const v = object(value);
  const states: unknown[] = ["queued", "running", "succeeded", "failed", "uncertain"];
  if (!states.includes(v.state) || !["draft", "compile"].includes(String(v.operation)) ||
      !Number.isSafeInteger(v.attempt) || Number(v.attempt) < 0 || (expectedId !== undefined && v.id !== expectedId)) {
    throw new Error("Invalid hosted task response");
  }
  return { id: text(v.id), operation: v.operation as HostedTask["operation"], state: v.state as TaskState,
    attempt: Number(v.attempt), createdAt: text(v.createdAt), updatedAt: text(v.updatedAt),
    ...(v.result !== undefined ? { result: v.result } : {}),
    ...(v.error !== undefined ? { error: { code: text(object(v.error).code), message: text(object(v.error).message) } } : {}) };
}
async function boundedBody(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel(); throw new Error("Hosted API response exceeds byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Hosted API response body is missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Hosted API response exceeds byte limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error("Hosted API returned invalid JSON"); }
}
async function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Task polling cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function hostedClient(options: HostedClientOptions) {
  const url = new URL(options.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") throw new Error("API base must be an HTTPS origin or local HTTP origin");
  if (options.apiKey !== undefined && (!options.apiKey || /[\r\n]/.test(options.apiKey))) throw new Error("Invalid API key");
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = positive(options.timeoutMs ?? 30_000, "timeoutMs");
  const maxBytes = positive(options.maxResponseBytes ?? 4_194_304, "maxResponseBytes");
  const request = async (method: "GET" | "POST", path: string, body?: unknown, replayKey?: string,
      authenticated = true, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<unknown> => {
    if (method === "POST" && (!replayKey || !/^[A-Za-z0-9_.:-]{1,128}$/.test(replayKey))) throw new Error("A valid idempotency key is required");
    signal?.throwIfAborted();
    const headers = new Headers({ accept: "application/json", ...extraHeaders });
    if (authenticated && options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
    if (replayKey) headers.set("idempotency-key", replayKey);
    if (body !== undefined) headers.set("content-type", "application/json");
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url.origin + path, { method, headers, redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      // Preserve stable classifications. Remote messages and details remain private.
      const known = new Set(["validation_failed", "unauthorized", "forbidden", "not_found", "revision_conflict",
        "approval_required", "payload_too_large", "idempotency_key_reused", "capability_unsupported", "rate_limited",
        "wrong_state", "chain_unavailable", "terms_mismatch", "model_unavailable", "model_invalid", "engine_unavailable",
        "payment_required", "payment_invalid", "payment_pending", "payment_failed", "payment_conflict", "payment_unavailable",
        "quote_expired", "chain_unconfirmed", "engine_failed", "model_failed", "service_disabled", "internal", "not_implemented"]);
      let code = "request_failed";
      try {
        const body = object(await boundedBody(response, maxBytes)), error = object(body.error);
        if (typeof error.code === "string" && known.has(error.code)) code = error.code;
      } catch { /* Never expose an untrusted error body or parsing error. */ }
      throw new HostedApiError(response.status, code);
    }
    return boundedBody(response, maxBytes);
  };
  const task = async (id: string, signal?: AbortSignal) => taskView(await request("GET", `/v1/tasks/${encodeURIComponent(id)}`, undefined, undefined, true, undefined, signal), id);
  const client = {
    challenge: async (wallet: string, replayKey: string): Promise<AuthChallenge> => {
      const v = object(await request("POST", "/v1/auth/challenge", { wallet }, replayKey, false));
      return { challengeId: text(v.challengeId), message: text(v.message), expiresAt: text(v.expiresAt) };
    },
    issueKey: async (challengeId: string, signature: string, replayKey: string): Promise<IssuedHostedKey> => {
      const v = object(await request("POST", "/v1/auth/keys", { challengeId, signature }, replayKey, false));
      return { ...keyView(v), key: text(v.key) };
    },
    authenticate: async (wallet: string, sign: (message: string) => Promise<string>, replayKey: string): Promise<IssuedHostedKey> => {
      if (!/^[A-Za-z0-9_.:-]{1,118}$/.test(replayKey)) throw new Error("Authentication idempotency prefix is invalid");
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Authentication wallet is invalid");
      const challenge = await client.challenge(wallet, `${replayKey}.challenge`);
      const expires = Date.parse(challenge.expiresAt), now = Date.now();
      const lines = challenge.message.split("\n");
      if (!Number.isFinite(expires) || expires <= now || expires > now + 900_000 ||
          new Date(expires).toISOString() !== challenge.expiresAt || lines.length !== 6 ||
          lines[0] !== "UBC26-HOSTED-AUTH-v1" || lines[1] !== `service: ${url.origin}` ||
          lines[2] !== `wallet: ${wallet.toLowerCase()}` || lines[3] !== "action: issue-api-key" ||
          !/^nonce: [A-Za-z0-9_-]{20,256}$/.test(lines[4] ?? "") || lines[5] !== `expires: ${challenge.expiresAt}`) {
        throw new Error("Authentication challenge differs from the requested service, wallet, action or expiry");
      }
      return client.issueKey(challenge.challengeId, await sign(challenge.message), `${replayKey}.key`);
    },
    currentKey: async () => keyView(await request("GET", "/v1/auth/keys/current")),
    revokeKey: (id: string, replayKey: string) => request("POST", `/v1/auth/keys/${encodeURIComponent(id)}/revoke`, {}, replayKey),
    createJob: (submission: HostedSubmission, replayKey: string) => request("POST", "/v1/jobs", submission, replayKey),
    importJob: (revision: unknown, replayKey: string, references?: HostedReference[]) => request("POST", "/v1/jobs", { revision, source: "import", ...(references ? { references } : {}) }, replayKey),
    job: (id: string) => request("GET", `/v1/jobs/${encodeURIComponent(id)}`, undefined, undefined, false),
    revise: (id: string, body: unknown, replayKey: string, revisionHash: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/revisions`, body, replayKey, true, { "if-match": `"${revisionHash}"` }),
    approve: (id: string, body: { revisionHash: string; referenceDigest: string; coverageDigest?: string; exampleCheckId?: string }, replayKey: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/approve`, body, replayKey, true, { "if-match": `"${body.revisionHash}"` }),
    checkExamples: (draftId: string, body: { revisionHash: string; examples: unknown[] }, replayKey: string) => request("POST", `/v1/drafts/${encodeURIComponent(draftId)}/example-checks`, { draftId, ...body }, replayKey, true, { "if-match": `"${body.revisionHash}"` }),
    draft: async (input: unknown, replayKey: string) => taskView(await request("POST", "/v1/tasks", { operation: "draft", input }, replayKey)),
    compile: async (jobId: string, revisionHash: string, replayKey: string) => taskView(await request("POST", "/v1/tasks", { operation: "compile", jobId, revisionHash }, replayKey)),
    task,
    waitForTask: async (id: string, wait: WaitTaskOptions = {}): Promise<HostedTask> => {
      const interval = positive(wait.intervalMs ?? 1000, "intervalMs");
      const deadline = AbortSignal.timeout(positive(wait.timeoutMs ?? 1_800_000, "timeoutMs"));
      const signal = wait.signal ? AbortSignal.any([wait.signal, deadline]) : deadline;
      for (;;) {
        signal.throwIfAborted(); const result = await task(id, signal);
        if (["succeeded", "failed", "uncertain"].includes(result.state)) return result;
        await pause(interval, signal);
      }
    },
    openJobs: async (options: HostedDiscoveryOptions = {}): Promise<HostedDiscoveryPage> => {
      const validCursor = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
      if (options.cursor !== undefined && !validCursor(options.cursor)) throw new Error("Discovery cursor is invalid");
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50)) throw new Error("Discovery limit must be an integer from 1 to 50");
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      const suffix = query.toString();
      const page = object(await request("GET", `/v1/open-jobs${suffix ? `?${suffix}` : ""}`, undefined, undefined, false));
      if (!Array.isArray(page.jobs) || page.jobs.length > (options.limit ?? 50)) throw new Error("Discovery page exceeds its declared limit or has no jobs array");
      const hasCursor = Object.hasOwn(page, "nextCursor");
      if ((options.cursor !== undefined || options.limit !== undefined) && !hasCursor) throw new Error("Service did not confirm discovery pagination");
      if (hasCursor && page.nextCursor !== null && !validCursor(page.nextCursor)) throw new Error("Discovery pagination response has an invalid cursor");
      if (options.cursor !== undefined && page.nextCursor === options.cursor) throw new Error("Discovery pagination cursor did not advance");
      return { jobs: page.jobs, ...(hasCursor ? { nextCursor: page.nextCursor as string | null } : {}) };
    },
    openJob: (id: string) => request("GET", `/v1/open-jobs/${encodeURIComponent(id)}`, undefined, undefined, false),
    publishAttempt: async (jobId: string, input: HostedAttemptInput, replayKey: string): Promise<HostedAttemptPublication> => {
      const body = hostedAttemptInput(input), v = object(await request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/attempts`, body, replayKey));
      const summary = attemptSummary(v, jobId, body.attemptId), events = attemptEvents(v.events, summary, 20);
      const accepted = attemptInt(v.accepted, 0, body.events.length);
      if (events.length !== body.events.length || events.some((event, i) => event.cursor !== body.events[i]?.cursor || event.phase !== body.events[i]?.phase || event.reportedAt !== body.events[i]?.reportedAt)) return attemptInvalid();
      return { ...summary, accepted, events };
    },
    attempts: async (jobId: string, options: HostedDiscoveryOptions = {}): Promise<HostedAttemptPage> => {
      const limit = options.limit === undefined ? 20 : attemptInt(options.limit, 1, 50), query = new URLSearchParams({ limit: String(limit) });
      if (options.cursor !== undefined) query.set("cursor", attemptCursor(options.cursor));
      const v = object(await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/attempts?${query}`, undefined, undefined, false));
      if (!Array.isArray(v.attempts) || v.attempts.length > limit) return attemptInvalid();
      const attempts = v.attempts.map(value => attemptSummary(value, jobId));
      const nextCursor = v.nextCursor === null ? null : attemptCursor(v.nextCursor);
      if (new Set(attempts.map(item => item.attemptId)).size !== attempts.length || (nextCursor !== null && (nextCursor === options.cursor || attempts.length === 0))) return attemptInvalid();
      return { attempts, nextCursor };
    },
    attempt: async (jobId: string, id: string, options: { afterCursor?: number } = {}): Promise<HostedAttemptDetail> => {
      const attemptId = attemptUuid(id), after = options.afterCursor === undefined ? 0 : attemptInt(options.afterCursor, 0, 200);
      const v = object(await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/attempts/${encodeURIComponent(attemptId)}?afterCursor=${after}`, undefined, undefined, false));
      const summary = attemptSummary(v, jobId, attemptId), events = attemptEvents(v.events, summary, 50);
      const last = events.at(-1)?.cursor ?? after;
      if (after > summary.highWaterCursor || v.nextCursor !== summary.highWaterCursor || events.some((event, i) => event.cursor !== after + i + 1)) return attemptInvalid();
      const more = last < summary.highWaterCursor;
      if ((more && (events.length === 0 || v.resumeCursor !== last)) || (!more && v.resumeCursor !== null)) return attemptInvalid();
      return { ...summary, events, nextCursor: summary.highWaterCursor, resumeCursor: more ? last : null };
    },
    fundingTerms: (id: string, body: unknown, replayKey: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/open-claim-terms`, body, replayKey),
    linkFunding: (id: string, body: unknown, replayKey: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/open-claim-link`, body, replayKey),
    packageListing: (id: string) => request("GET", `/v1/jobs/${encodeURIComponent(id)}/package`, undefined, undefined, false),
    references: (id: string) => request("GET", `/v1/jobs/${encodeURIComponent(id)}/references`, undefined, undefined, false),
  };
  return client;
}
export type HostedClient = ReturnType<typeof hostedClient>;
