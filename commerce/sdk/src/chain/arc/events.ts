// Event decoding and paged log reads. Browser-safe.
import { decodeEventLog, isAddressEqual } from "viem";
import type { Abi, Address, Hex, PublicClient } from "viem";
import { coreAbi, hookAbi } from "./abi.ts";
import { MAX_LOG_WINDOW } from "./deployment.ts";
import type { Deployment } from "./deployment.ts";
import { ArcError, rpc } from "./errors.ts";
import { asAddress, asBigint, asBytes32 } from "./reads.ts";

/** Argument names and kinds of every settlement event, in ABI order. The first is always the indexed job ID. */
export const CORE_EVENT_FIELDS = {
  JobCreated: { jobId: "uint", client: "address", provider: "address", evaluator: "address", expiredAt: "uint", hook: "address" },
  BudgetSet: { jobId: "uint", amount: "uint" },
  JobFunded: { jobId: "uint", client: "address", amount: "uint" },
  JobSubmitted: { jobId: "uint", provider: "address", deliverable: "bytes32" },
  JobCompleted: { jobId: "uint", evaluator: "address", reason: "bytes32" },
  PaymentReleased: { jobId: "uint", provider: "address", amount: "uint" },
  Refunded: { jobId: "uint", client: "address", amount: "uint" },
  JobExpired: { jobId: "uint" },
} as const;

export const HOOK_EVENT_FIELDS = {
  TermsFrozen: { jobId: "uint", provider: "address", imageId: "bytes32", rulesHash: "bytes32", referenceHash: "bytes32", budget: "uint", expiry: "uint" },
  ProofAccepted: { jobId: "uint", envelopeHash: "bytes32", keyCommitment: "bytes32" },
  KeyReleased: { jobId: "uint", provider: "address", key: "bytes32", envelopeHash: "bytes32" },
} as const;

type FieldKind = "uint" | "address" | "bytes32";
type FieldValue<K extends FieldKind> = K extends "uint" ? bigint : K extends "address" ? Address : Hex;
type AllFields = typeof CORE_EVENT_FIELDS & typeof HOOK_EVENT_FIELDS;

export type SettlementEventName = keyof AllFields;
export type EventArgs<N extends SettlementEventName> = { -readonly [F in keyof AllFields[N]]: AllFields[N][F] extends FieldKind ? FieldValue<AllFields[N][F]> : never };

export interface EventMeta {
  /** Emitting contract: the core or the hook. */
  address: Address;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** One decoded settlement event; narrow on `name` to get typed `args`. Every event has `args.jobId`. */
export type DecodedEvent = { [N in SettlementEventName]: { name: N; args: EventArgs<N> } & EventMeta }[SettlementEventName];

/** The log fields this module reads. A viem `Log` and a receipt log both fit. */
export interface RawLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
  logIndex?: number | null;
}

function fieldsFor(name: string, fromCore: boolean): Record<string, FieldKind> | undefined {
  const table: Record<string, Record<string, FieldKind>> = fromCore ? CORE_EVENT_FIELDS : HOOK_EVENT_FIELDS;
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * Decodes one log emitted by the core or the hook. Returns null for any other emitter (for example
 * USDC `Transfer` in the same transaction) and for core events that are not part of settlement
 * (role, upgrade and whitelist events). Core events are accepted only from the core address and
 * hook events only from the hook address.
 */
export function decodeSettlementLog(log: RawLog, d: Pick<Deployment, "core" | "hook">): DecodedEvent | null {
  const fromCore = isAddressEqual(log.address, d.core);
  if (!fromCore && !isAddressEqual(log.address, d.hook)) return null;
  const abi: Abi = fromCore ? coreAbi : hookAbi;
  const [signature, ...indexed] = log.topics;
  if (signature === undefined) return null;
  let decoded: { eventName?: string; args?: unknown };
  try {
    decoded = decodeEventLog({ abi, data: log.data, topics: [signature, ...indexed] }) as { eventName?: string; args?: unknown };
  } catch {
    return null;
  }
  const name = decoded.eventName;
  if (name === undefined) return null;
  const fields = fieldsFor(name, fromCore);
  if (!fields) return null;
  const raw = (decoded.args ?? {}) as Record<string, unknown>;
  const args: Record<string, bigint | Address | Hex> = {};
  for (const [field, kind] of Object.entries(fields)) {
    const what = `${name}.${field}`;
    args[field] = kind === "uint" ? asBigint(raw[field], what) : kind === "address" ? asAddress(raw[field], what) : asBytes32(raw[field], what);
  }
  return {
    name,
    args,
    address: log.address,
    blockNumber: log.blockNumber ?? null,
    transactionHash: log.transactionHash ?? null,
    logIndex: log.logIndex ?? null,
  } as DecodedEvent;
}

/** Every settlement event in a list of logs (for example a receipt's), in order. */
export function decodeSettlementLogs(logs: readonly RawLog[], d: Pick<Deployment, "core" | "hook">): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const log of logs) {
    const ev = decodeSettlementLog(log, d);
    if (ev) out.push(ev);
  }
  return out;
}

/** The job ID from the core's `JobCreated` log in a `createJob` receipt. Throws ArcError("not_found") when there is none. */
export function jobIdFromCreateReceipt(d: Pick<Deployment, "core" | "hook">, receipt: { logs: readonly RawLog[] }): bigint {
  for (const ev of decodeSettlementLogs(receipt.logs, d)) {
    if (ev.name === "JobCreated") return ev.args.jobId;
  }
  throw new ArcError("not_found", "the receipt has no JobCreated log from the core");
}

/** Splits `[from, to]` into inclusive windows of at most `maxWindow` blocks. */
export function blockWindows(from: bigint, to: bigint, maxWindow: bigint = MAX_LOG_WINDOW): Array<[bigint, bigint]> {
  if (maxWindow < 1n) throw new ArcError("bad_input", "maxWindow must be at least 1");
  const out: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += maxWindow) {
    const end = start + maxWindow - 1n < to ? start + maxWindow - 1n : to;
    out.push([start, end]);
  }
  return out;
}

/**
 * Every settlement event the core and the hook emitted in `[fromBlock, toBlock]`, in log order.
 * Arc rejects eth_getLogs ranges above 10,000 blocks, so the range is read in windows of at most
 * 10,000 blocks. `toBlock` defaults to the latest block. Start from `d.deployBlock`, not from 0.
 */
export async function getSettlementEvents(pc: PublicClient, d: Deployment, fromBlock: bigint, toBlock?: bigint): Promise<DecodedEvent[]> {
  if (fromBlock < 0n) throw new ArcError("bad_input", "fromBlock must not be negative");
  const to = toBlock ?? (await rpc("eth_blockNumber", () => pc.getBlockNumber()));
  const events: DecodedEvent[] = [];
  for (const [start, end] of blockWindows(fromBlock, to)) {
    const logs = await rpc("eth_getLogs", () => pc.getLogs({ address: [d.core, d.hook], fromBlock: start, toBlock: end }));
    events.push(...decodeSettlementLogs(logs, d));
  }
  return events;
}
