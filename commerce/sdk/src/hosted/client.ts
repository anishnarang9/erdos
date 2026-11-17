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
    approve: (id: string, body: { revisionHash: string; referenceDigest: string; coverageDigest?: string }, replayKey: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/approve`, body, replayKey, true, { "if-match": `"${body.revisionHash}"` }),
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
    fundingTerms: (id: string, body: unknown, replayKey: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/open-claim-terms`, body, replayKey),
    linkFunding: (id: string, body: unknown, replayKey: string) => request("POST", `/v1/jobs/${encodeURIComponent(id)}/open-claim-link`, body, replayKey),
    packageListing: (id: string) => request("GET", `/v1/jobs/${encodeURIComponent(id)}/package`, undefined, undefined, false),
    references: (id: string) => request("GET", `/v1/jobs/${encodeURIComponent(id)}/references`, undefined, undefined, false),
  };
  return client;
}
export type HostedClient = ReturnType<typeof hostedClient>;
