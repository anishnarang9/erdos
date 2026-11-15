// Event decoding and paged log reads for the settlement contracts.
//
// Arc's `eth_getLogs` fails for ranges above 10,000 blocks, so `getLogsPaged` walks the range in
// windows of at most 10,000 blocks (inclusive of both ends).
//
// Hook events:  TermsFrozen, ProofAccepted, KeyReleased        (emitted by SettlementHook)
// Core events:  JobCreated, BudgetSet, JobFunded, JobSubmitted, JobCompleted, PaymentReleased,
//               Refunded, JobExpired                           (emitted by the AgenticCommerce proxy)
import { decodeEventLog, type Abi, type Address, type Hex, type Log, type PublicClient } from "viem";
import { coreAbi, settlementHookAbi } from "./abi.ts";
import type { Deployment } from "./manifest.ts";

export const HOOK_EVENTS = ["TermsFrozen", "ProofAccepted", "KeyReleased"] as const;
export const CORE_EVENTS = [
  "JobCreated",
  "BudgetSet",
  "JobFunded",
  "JobSubmitted",
  "JobCompleted",
  "PaymentReleased",
  "Refunded",
  "JobExpired",
] as const;

export type SettlementEventName = (typeof HOOK_EVENTS)[number] | (typeof CORE_EVENTS)[number];

export interface DecodedEvent {
  name: SettlementEventName;
  args: Record<string, unknown>;
  address: Address;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** Maximum blocks per `eth_getLogs` window on Arc (inclusive). */
export const MAX_LOG_WINDOW = 10_000n;

type RawLog = Pick<Log, "address" | "data" | "topics" | "blockNumber" | "transactionHash" | "logIndex">;

/**
 * Decode one log emitted by the core or the hook. Returns null for any other log (for example USDC
 * `Transfer` events in the same transaction). `which` selects the ABI by emitter address.
 */
export function decodeSettlementLog(log: RawLog, d: Pick<Deployment, "core" | "hook">): DecodedEvent | null {
  const emitter = log.address.toLowerCase();
  let abi: Abi;
  if (emitter === d.core.toLowerCase()) abi = coreAbi;
  else if (emitter === d.hook.toLowerCase()) abi = settlementHookAbi;
  else return null;
  try {
    const ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const known: readonly string[] = emitter === d.core.toLowerCase() ? CORE_EVENTS : HOOK_EVENTS;
    const evName = String(ev.eventName);
    if (!known.includes(evName)) return null;
    return {
      name: evName as SettlementEventName,
      args: (ev.args ?? {}) as Record<string, unknown>,
      address: log.address,
      blockNumber: log.blockNumber ?? null,
      transactionHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null,
    };
  } catch {
    return null;
  }
}

/** Decode every settlement event in a transaction receipt's logs. */
export function decodeReceiptLogs(logs: readonly RawLog[], d: Pick<Deployment, "core" | "hook">): DecodedEvent[] {
  return logs.map((l) => decodeSettlementLog(l, d)).filter((e): e is DecodedEvent => e !== null);
}

/** Split `[from, to]` into inclusive windows of at most `maxWindow` blocks. */
export function blockWindows(from: bigint, to: bigint, maxWindow: bigint = MAX_LOG_WINDOW): Array<[bigint, bigint]> {
  if (from > to) return [];
  if (maxWindow < 1n) throw new Error("maxWindow must be at least 1");
  const out: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += maxWindow) {
    const end = start + maxWindow - 1n < to ? start + maxWindow - 1n : to;
    out.push([start, end]);
  }
  return out;
}

/**
 * All settlement events from the core and the hook in `[fromBlock, toBlock]`, in log order, fetched
 * in windows of at most 10,000 blocks. `toBlock` defaults to the latest block.
 * Pass `jobId` to keep only events whose first indexed argument is that job (every settlement
 * event indexes `jobId` first).
 */
export async function getSettlementEvents(
  client: PublicClient,
  d: Deployment,
  opts: { fromBlock?: bigint; toBlock?: bigint; jobId?: bigint } = {},
): Promise<DecodedEvent[]> {
  const from = opts.fromBlock ?? d.fromBlock;
  const to = opts.toBlock ?? (await client.getBlockNumber());
  const events: DecodedEvent[] = [];
  for (const [start, end] of blockWindows(from, to, BigInt(d.maxLogBlockRange))) {
    const logs = await client.getLogs({ address: [d.core, d.hook], fromBlock: start, toBlock: end });
    for (const log of logs) {
      const ev = decodeSettlementLog(log, d);
      if (!ev) continue;
      if (opts.jobId !== undefined && ev.args["jobId"] !== opts.jobId) continue;
      events.push(ev);
    }
  }
  return events;
}
