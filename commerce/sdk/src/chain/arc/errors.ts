// ArcError and revert decoding for the Arc settlement module. Browser-safe.
import { decodeErrorResult, isHex } from "viem";
import type { Hex } from "viem";
import { withRetry } from "../retry.ts";
import { errorsAbi } from "./abi.ts";

export type ArcErrorCode = "wrong_chain" | "reverted" | "bad_manifest" | "not_found" | "rpc" | "bad_input";

export class ArcError extends Error {
  readonly code: ArcErrorCode;
  /** Custom error name decoded from the revert data (core, hook or verifier ABI), when there is one. */
  readonly revertName?: string;
  /** Hash of the transaction, on every error thrown after it was broadcast (mined revert, missing receipt). */
  readonly txHash?: Hex;

  constructor(code: ArcErrorCode, message?: string, opts: { revertName?: string; txHash?: Hex; cause?: unknown } = {}) {
    super(message ? `${code}: ${message}` : code, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ArcError";
    this.code = code;
    if (opts.revertName !== undefined) this.revertName = opts.revertName;
    if (opts.txHash !== undefined) this.txHash = opts.txHash;
  }
}

const isRevertData = (v: unknown): v is Hex => typeof v === "string" && isHex(v, { strict: true }) && v.length >= 10;

function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    yield cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** Raw revert data (selector plus arguments) found anywhere in a viem error's cause chain. */
export function revertDataOf(err: unknown): Hex | undefined {
  for (const e of causeChain(err)) {
    if (isRevertData(e["raw"])) return e["raw"];
    if (isRevertData(e["data"])) return e["data"];
    const nested = e["data"];
    if (nested && typeof nested === "object") {
      const inner = (nested as { data?: unknown }).data;
      if (isRevertData(inner)) return inner;
    }
  }
  return undefined;
}

export interface DecodedRevert {
  /** Custom error name, or "Error" / "Panic" for the Solidity built-ins. */
  revertName: string;
  args: readonly unknown[];
}

/** Decodes revert data against every custom error of the core, the hook and the verifier. */
export function decodeRevert(data: Hex | undefined): DecodedRevert | undefined {
  if (!data) return undefined;
  try {
    const d = decodeErrorResult({ abi: errorsAbi, data });
    return { revertName: d.errorName, args: (d.args ?? []) as readonly unknown[] };
  } catch {
    return undefined;
  }
}

/** True when the error is an EVM execution failure (a revert or out of gas), not a transport failure. */
export function isExecutionError(err: unknown): boolean {
  if (revertDataOf(err) !== undefined) return true;
  for (const e of causeChain(err)) {
    if (e["name"] === "ExecutionRevertedError" || e["code"] === 3) return true;
    for (const k of ["details", "shortMessage", "message"] as const) {
      const text = e[k];
      if (typeof text === "string" && /execution reverted|out of gas|gas required exceeds/i.test(text)) return true;
    }
  }
  return false;
}

function shortMessage(err: unknown): string {
  for (const e of causeChain(err)) {
    const details = e["details"];
    if (typeof details === "string" && details.length > 0) return details;
  }
  const first = err as { shortMessage?: unknown; message?: unknown } | null;
  if (first && typeof first.shortMessage === "string") return first.shortMessage;
  if (first && typeof first.message === "string") return first.message.split("\n")[0] ?? "unknown error";
  return String(err);
}

export interface RevertInfo {
  revertName?: string;
  /** One line for people: `WrongKey`, `Error("Blocked address")`, or the node's message. */
  text: string;
}

/** Describes an execution error. Call only after `isExecutionError(err)` is true. */
export function describeRevert(err: unknown): RevertInfo {
  const decoded = decodeRevert(revertDataOf(err));
  if (!decoded) return { text: shortMessage(err) };
  const args = decoded.args.length > 0 ? `(${decoded.args.map((a) => JSON.stringify(a, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).join(", ")})` : "";
  return { revertName: decoded.revertName, text: `${decoded.revertName}${args}` };
}

/**
 * Runs a read-only RPC call. A rate-limit answer (JSON-RPC -32005, HTTP 429) is retried with
 * backoff, which the public Arc RPC needs; every other failure that is not an ArcError becomes
 * ArcError("rpc") with the original error as `cause`.
 */
export async function rpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withRetry(fn);
  } catch (err) {
    if (err instanceof ArcError) throw err;
    throw new ArcError("rpc", `${what}: ${shortMessage(err)}`, { cause: err });
  }
}
