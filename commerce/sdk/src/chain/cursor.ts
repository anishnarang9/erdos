import type { Address, Log, PublicClient } from "viem";
import { withRetry } from "./retry.ts";
import type { DecodedEvent } from "./types.ts";

export interface CursorStore {
  load(): bigint | null;
  save(block: bigint): void;
}

export interface LogCursorOptions {
  addresses: Address[];
  fromBlock: bigint;
  decode: (logs: Log[]) => DecodedEvent[];
  maxRange?: bigint | undefined;
  store: CursorStore;
  confirmations?: bigint | undefined;
}

/** Provider errors that mean "window too large / too many results". */
const RANGE_ERROR_RE = /more than|range|too many|limit exceeded|block range/i;

function isRangeError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const text of [e.message, e.details, e.shortMessage]) {
      if (typeof text === "string" && RANGE_ERROR_RE.test(text)) return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Resumable, chunked eth_getLogs reader. The cursor is saved only after a chunk is read successfully.
 * On a range/result-limit error the window is halved (down to 1 block) and retried; the reduced window is kept.
 */
export class LogCursor {
  private readonly client: PublicClient;
  private readonly addresses: Address[];
  private readonly fromBlock: bigint;
  private readonly decode: (logs: Log[]) => DecodedEvent[];
  private readonly store: CursorStore;
  private readonly confirmations: bigint;
  private range: bigint;
  /** True once the cursor has reached head - confirmations. */
  caughtUp = false;

  constructor(publicClient: PublicClient, opts: LogCursorOptions) {
    const maxRange = opts.maxRange ?? 10_000n;
    if (maxRange < 1n) throw new RangeError("maxRange must be >= 1");
    this.client = publicClient;
    this.addresses = opts.addresses;
    this.fromBlock = opts.fromBlock;
    this.decode = opts.decode;
    this.store = opts.store;
    this.confirmations = opts.confirmations ?? 0n;
    this.range = maxRange;
  }

  async next(): Promise<DecodedEvent[]> {
    const last = this.store.load();
    const from = last === null ? this.fromBlock : last + 1n;
    const head = await withRetry(() => this.client.getBlockNumber({ cacheTime: 0 }));
    const safe = head - this.confirmations;
    if (safe < from) {
      this.caughtUp = true;
      return [];
    }
    for (;;) {
      const cap = from + this.range - 1n;
      const to = safe < cap ? safe : cap;
      let logs: Log[];
      try {
        logs = (await withRetry(() =>
          this.client.getLogs({ address: this.addresses, fromBlock: from, toBlock: to }),
        )) as Log[];
      } catch (err) {
        const window = to - from + 1n;
        if (window > 1n && isRangeError(err)) {
          this.range = window / 2n;
          continue;
        }
        throw err;
      }
      const events = this.decode(logs);
      this.store.save(to);
      this.caughtUp = to === safe;
      return events;
    }
  }
}
