import { ApiError } from "./errors.ts";

/** One external handler that is allowed to settle or compile. */
export interface ExternalLease {
  /** Resolves when this handler owns the single compiler. Rejects when drain cancels it. */
  ready: Promise<void>;
  release(): void;
}

/**
 * One compiler shared by durable tasks and paid compiles.
 * External handlers are capped by active plus waiting. Durable work does not enter that queue.
 */
export interface CompileAdmission {
  readonly limit: number;
  readonly activeExternal: number;
  readonly waiting: number;
  readonly rejected: number;
  readonly draining: boolean;
  readonly databaseClosed: boolean;
  close(): void;
  admitExternal(): ExternalLease;
  tryDurable(): boolean;
  releaseDurable(): void;
  beginDrain(): void;
  beginPump(): void;
  /** A pump with no queued compile must not keep the next external handler parked. */
  noteNoQueuedCompile(): void;
  finishPump(): void;
  track(work: Promise<unknown>): void;
  owned(): Promise<unknown>[];
  closedError(): ApiError;
}

interface Waiter {
  token: symbol;
  grant: () => void;
  cancel: (err: ApiError) => void;
}

export function createCompileAdmission(limit: number): CompileAdmission {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("paidCompileLimit must be a positive safe integer");
  }
  let active: "none" | "external" | "durable" = "none";
  let owner: symbol | null = null;
  let draining = false;
  let databaseClosed = false;
  let durablePending = false;
  // The pump asked for the compiler and did not get it. The next release leaves it free for that task.
  let durableSkipped = false;
  let rejected = 0;
  const waiting: Waiter[] = [];
  const inflight = new Set<Promise<unknown>>();

  const externalCount = (): number => (active === "external" ? 1 : 0) + waiting.length;
  const fullError = (): ApiError => new ApiError("rate_limited", "Paid compile queue is full", {
    queue: "paid-compile",
    scope: "global",
  });
  const closedError = (): ApiError => new ApiError("rate_limited", "Paid compile is not accepting work", {
    queue: "paid-compile",
    scope: "draining",
  });
  const wake = (): void => {
    if (draining || durablePending || durableSkipped || active !== "none") return;
    const next = waiting.shift();
    if (!next) return;
    active = "external";
    owner = next.token;
    next.grant();
  };
  const lease = (token: symbol, ready: Promise<void>): ExternalLease => {
    let released = false;
    return {
      ready,
      release() {
        if (released) return;
        released = true;
        const index = waiting.findIndex((item) => item.token === token);
        if (index >= 0) {
          waiting.splice(index, 1);
          return;
        }
        if (owner !== token || active !== "external") return;
        owner = null;
        active = "none";
        if (draining || durableSkipped) return;
        wake();
      },
    };
  };

  return {
    get limit() { return limit; },
    get activeExternal() { return active === "external" ? 1 : 0; },
    get waiting() { return waiting.length; },
    get rejected() { return rejected; },
    get draining() { return draining; },
    get databaseClosed() { return databaseClosed; },
    close() { this.beginDrain(); databaseClosed = true; },
    closedError,
    admitExternal() {
      if (draining) {
        rejected += 1;
        throw closedError();
      }
      if (externalCount() >= limit) {
        rejected += 1;
        throw fullError();
      }
      const token = Symbol("paid-compile");
      if (active === "none" && !durablePending && !durableSkipped && waiting.length === 0) {
        active = "external";
        owner = token;
        return lease(token, Promise.resolve());
      }
      let grant!: () => void;
      let cancel!: (err: ApiError) => void;
      const ready = new Promise<void>((resolve, reject) => {
        grant = () => resolve();
        cancel = (err) => reject(err);
      });
      waiting.push({ token, grant, cancel });
      return lease(token, ready);
    },
    tryDurable() {
      if (draining || active !== "none") {
        durableSkipped = true;
        return false;
      }
      active = "durable";
      durableSkipped = false;
      return true;
    },
    releaseDurable() {
      if (active !== "durable") return;
      active = "none";
      durableSkipped = false;
      if (!draining) wake();
    },
    beginDrain() {
      draining = true;
      const pending = waiting.splice(0, waiting.length);
      rejected += pending.length;
      const err = closedError();
      for (const item of pending) item.cancel(err);
    },
    beginPump() {
      durablePending = true;
    },
    noteNoQueuedCompile() {
      durableSkipped = false;
    },
    finishPump() {
      durablePending = false;
      if (draining || durableSkipped) return;
      wake();
    },
    track(work) {
      inflight.add(work);
      const cleanup = () => { inflight.delete(work); };
      void work.then(cleanup, cleanup);
    },
    owned() {
      return [...inflight];
    },
  };
}
