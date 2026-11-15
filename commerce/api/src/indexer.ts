// T8 indexer (CONTRACT-T5-T8 §6). Owner: Coder D.
// SIMULATED: decodes with the @ubc26/sdk stub ABI until Nick publishes the settlement ABI.
import { LogCursor, type DecodedEvent } from "@ubc26/sdk";
import { tx, type Db } from "./db.ts";
import { readChain, type ApiChain } from "./chain.ts";

export interface IndexerOptions {
  db: Db;
  chain: ApiChain;
  /** First block to read when no cursor is stored yet. */
  cursorStart: bigint;
  /** Blocks per getLogs window (LogCursor maxRange). */
  maxRange?: bigint;
  /** Upper bound on cursor windows read per tick, so one tick cannot run unbounded. */
  maxWindowsPerTick?: number;
}

export interface Indexer {
  /** Reads new logs of [core, hook] up to the head, stores them, and returns the number of new events. */
  tick(): Promise<number>;
}

/** JSON for event args: bigints become decimal strings. */
function argsJson(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export function createIndexer(opts: IndexerOptions): Indexer {
  const { db, chain } = opts;
  const cfg = chain.config;
  const core = cfg.core.toLowerCase();
  const hook = cfg.hook.toLowerCase();
  // index_cursor.contract holds the core address: one cursor covers [core, hook] of that deployment.
  const loadCursor = db.prepare("SELECT last_block FROM index_cursor WHERE chain_id = ? AND contract = ?");
  const saveCursor = db.prepare(
    `INSERT INTO index_cursor (chain_id, contract, last_block) VALUES (?, ?, ?)
     ON CONFLICT (chain_id, contract) DO UPDATE SET last_block = excluded.last_block`,
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (chain_id, block, log_index, tx_hash, name, job_id, args_json, contract, address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // The SDK cursor saves its position right after a read. That save is held in memory and committed with the
  // window's events in one transaction, so a crash can never advance the cursor past unstored events.
  let pending: bigint | null = null;
  const store = {
    load(): bigint | null {
      if (pending !== null) return pending;
      const row = loadCursor.get(cfg.chainId, core) as { last_block: number | bigint } | undefined;
      return row ? BigInt(row.last_block) : null;
    },
    save(block: bigint): void {
      pending = block;
    },
  };
  const cursor = new LogCursor(chain.publicClient, {
    addresses: [cfg.core, cfg.hook],
    fromBlock: opts.cursorStart,
    decode: (logs) => readChain(chain).decodeLogs(logs),
    maxRange: opts.maxRange,
    store,
  });

  const persist = (events: DecodedEvent[], block: bigint): number =>
    tx(db, () => {
      let added = 0;
      for (const e of events) {
        const jobId = e.args.jobId;
        const res = insertEvent.run(
          cfg.chainId,
          e.blockNumber,
          e.logIndex,
          e.transactionHash.toLowerCase(),
          e.name,
          typeof jobId === "bigint" ? jobId.toString() : null,
          argsJson(e.args),
          e.contract,
          e.contract === "core" ? core : e.contract === "hook" ? hook : null,
        );
        added += Number(res.changes);
      }
      saveCursor.run(cfg.chainId, core, block);
      return added;
    });

  let running: Promise<number> | null = null;

  async function run(): Promise<number> {
    const maxWindows = opts.maxWindowsPerTick ?? 50;
    let total = 0;
    for (let i = 0; i < maxWindows; i++) {
      pending = null;
      let events: DecodedEvent[];
      let block: bigint | null;
      try {
        events = await cursor.next();
        block = pending;
      } finally {
        pending = null; // a failed read never moves the cursor
      }
      if (block !== null) total += persist(events, block);
      if (cursor.caughtUp) break;
    }
    return total;
  }

  return {
    /** Concurrent calls share one run. */
    tick(): Promise<number> {
      if (!running) {
        running = run().finally(() => {
          running = null;
        });
      }
      return running;
    },
  };
}
