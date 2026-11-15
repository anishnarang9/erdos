export interface RetryOptions {
  retries?: number;
  baseMs?: number;
}

/** True for JSON-RPC -32005, HTTP 429, or a message mentioning "rate limit", anywhere in the cause chain. */
export function isRateLimitError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    if (e.code === -32005 || e.code === "-32005" || e.status === 429) return true;
    for (const text of [e.message, e.details, e.shortMessage]) {
      if (typeof text === "string" && /rate.?limit/i.test(text)) return true;
    }
    cur = e.cause;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retries `fn` on rate-limit errors with exponential backoff (baseMs * 2^attempt). Other errors are rethrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const baseMs = opts.baseMs ?? 250;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRateLimitError(err)) throw err;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}
