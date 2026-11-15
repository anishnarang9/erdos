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
  maxRange?: bigint;
  store: CursorStore;
  confirmations?: bigint;
}

/** Resumable, chunked eth_getLogs reader. The cursor is saved only after a chunk is read successfully. */
export class LogCursor {
  private readonly client: PublicClient;
  private readonly opts: Required<LogCursorOptions>;
  /** True after a `next()` that read up to the confirmed head (or found nothing new). */
  caughtUp = false;

  constructor(publicClient: PublicClient, opts: LogCursorOptions) {
    if ((opts.maxRange ?? 10_000n) < 1n) throw new RangeError("maxRange must be >= 1");
    this.client = publicClient;
    this.opts = { maxRange: 10_000n, confirmations: 0n, ...opts };
  }

  async next(): Promise<DecodedEvent[]> {
    const { addresses, fromBlock, decode, maxRange, store, confirmations } = this.opts;
    const last = store.load();
    const from = last === null ? fromBlock : last + 1n;
    const head = await withRetry(() => this.client.getBlockNumber({ cacheTime: 0 }));
    const safe = head - confirmations;
    if (safe < from) {
      this.caughtUp = true;
      return [];
    }
    const cap = from + maxRange - 1n;
    const to = safe < cap ? safe : cap;
    const logs = await withRetry(() => this.client.getLogs({ address: addresses, fromBlock: from, toBlock: to }));
    const events = decode(logs as Log[]);
    store.save(to);
    this.caughtUp = to === safe;
    return events;
  }
}
