import { decodeEventLog, getAddress, hexToBytes } from "viem";
import type { Abi, Hex, Log, PublicClient } from "viem";
import { ChainError } from "../errors.ts";
import { JobStatus } from "../types.ts";
import type { ChainConfig, DecodedEvent, FrozenTerms, JobView } from "../types.ts";
import { arcCoreAbi, arcErc20Abi, arcHookAbi } from "./abi.ts";

export interface ArcSnapshot {
  blockNumber: bigint;
  /** Hash returned by this snapshot's block read. Callers must compare it with their canonical anchor. */
  blockHash: Hex;
  timestamp: bigint;
  job: JobView;
  terms: FrozenTerms | null;
  context: Uint8Array;
  submission: { envelopeHash: Hex; keyCommitment: Hex; accepted: boolean };
  released: boolean;
}

export interface ArcReader {
  readonly config: Readonly<ChainConfig>;
  /** All reads use one block number. They are not atomic or EIP-1898 hash-pinned.
   * The RPC must serve consistent state. Security-sensitive callers must compare blockHash
   * with their saved anchor and check that the anchor remains canonical after the reads. */
  getSnapshot(jobId: bigint, blockNumber?: bigint): Promise<ArcSnapshot>;
  getJob(jobId: bigint, blockNumber?: bigint): Promise<JobView>;
  getTerms(jobId: bigint, blockNumber?: bigint): Promise<FrozenTerms | null>;
  /** Ignore foreign, malformed, removed, and pending logs (never invent metadata). */
  decodeLogs(logs: readonly Log[]): DecodedEvent[];
}

// Single struct outputs decode as named objects; multiple outputs decode as tuples.
// Supporting both also makes this boundary usable with ABI-aware client wrappers.
function field(value: unknown, name: string, index: number): unknown {
  if (Array.isArray(value)) return value[index];
  if (value !== null && typeof value === "object") return (value as Record<string, unknown>)[name];
  throw new Error(`Invalid Arc contract result: ${name}`);
}

function uint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`Invalid Arc ${name}`);
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid Arc ${name}`);
  return value;
}

function hex(value: unknown, name: string, bytes?: number): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
      (bytes !== undefined && value.length !== 2 + bytes * 2)) throw new Error(`Invalid Arc ${name}`);
  return value as Hex;
}

function address(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid Arc address");
  return getAddress(value.toLowerCase());
}

function normalizeJob(value: unknown, jobId: bigint): JobView {
  const id = field(value, "id", 0);
  if (id !== jobId || id === 0n) throw new Error(`Arc getJob.id mismatch: expected ${jobId}, got ${String(id)}`);
  const status = field(value, "status", 7);
  if (typeof status !== "number" || !Number.isInteger(status) || status < JobStatus.Open || status > JobStatus.Expired) {
    throw new Error(`Unknown Arc job status: ${String(status)}`);
  }
  const description = field(value, "description", 4);
  if (typeof description !== "string") throw new Error("Invalid Arc description");
  return {
    client: address(field(value, "client", 1)),
    provider: address(field(value, "provider", 2)),
    evaluator: address(field(value, "evaluator", 3)),
    description,
    budget: uint(field(value, "budget", 5), "budget"),
    expiredAt: uint(field(value, "expiredAt", 6), "expiredAt"),
    status,
    hook: address(field(value, "hook", 8)),
  };
}

function normalizeTerms(value: unknown): FrozenTerms | null {
  if (!bool(field(value, "funded", 6), "terms.funded")) return null;
  return {
    imageId: hex(field(value, "imageId", 0), "imageId", 32),
    rulesHash: hex(field(value, "rulesHash", 1), "rulesHash", 32),
    referenceHash: hex(field(value, "referenceHash", 2), "referenceHash", 32),
    provider: address(field(value, "provider", 3)),
    budget: uint(field(value, "budget", 4), "terms.budget"),
    expiredAt: uint(field(value, "expiry", 5), "terms.expiry"),
  };
}

/** Read-only adapter for the actual Arc settlement contracts. Never sends transactions. */
export function createArcReader(config: ChainConfig, publicClient: PublicClient): ArcReader {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error("Invalid Arc chainId");
  const cfg = Object.freeze({ ...config, core: address(config.core), hook: address(config.hook), usdc: address(config.usdc) });

  async function selectBlock(jobId: bigint, requested?: bigint): Promise<bigint> {
    if (typeof jobId !== "bigint" || jobId <= 0n || jobId >= 1n << 256n) throw new Error("Invalid Arc jobId");
    if (requested !== undefined && (typeof requested !== "bigint" || requested < 0n)) throw new Error("Invalid Arc blockNumber");
    // Ask the RPC, not publicClient.chain: transports can point to a different chain or switch networks.
    const actual = await publicClient.getChainId();
    if (actual !== cfg.chainId) throw new ChainError("wrong_chain", `expected chain ${cfg.chainId}, got public ${actual}`);
    return requested ?? await publicClient.getBlockNumber({ cacheTime: 0 });
  }

  function read(abi: Abi, target: typeof cfg.core, functionName: string, jobId: bigint, blockNumber: bigint): Promise<unknown> {
    return publicClient.readContract({ address: target, abi, functionName, args: [jobId], blockNumber });
  }

  return {
    config: cfg,
    async getSnapshot(jobId, requested) {
      const blockNumber = await selectBlock(jobId, requested);
      const [block, job, terms, context, submission, released] = await Promise.all([
        publicClient.getBlock({ blockNumber }),
        read(arcCoreAbi, cfg.core, "getJob", jobId, blockNumber),
        read(arcHookAbi, cfg.hook, "terms", jobId, blockNumber),
        read(arcHookAbi, cfg.hook, "contextOf", jobId, blockNumber),
        read(arcHookAbi, cfg.hook, "submissions", jobId, blockNumber),
        read(arcHookAbi, cfg.hook, "released", jobId, blockNumber),
      ]);
      if (block.number !== blockNumber) throw new Error("Arc block number mismatch");
      return {
        blockNumber,
        blockHash: hex(block.hash, "blockHash", 32),
        timestamp: uint(block.timestamp, "timestamp"),
        job: normalizeJob(job, jobId),
        terms: normalizeTerms(terms),
        context: hexToBytes(hex(context, "context")),
        submission: {
          envelopeHash: hex(field(submission, "envelopeHash", 0), "envelopeHash", 32),
          keyCommitment: hex(field(submission, "keyCommitment", 1), "keyCommitment", 32),
          accepted: bool(field(submission, "accepted", 2), "submission.accepted"),
        },
        released: bool(released, "released"),
      };
    },
    async getJob(jobId, requested) {
      const blockNumber = await selectBlock(jobId, requested);
      return normalizeJob(await read(arcCoreAbi, cfg.core, "getJob", jobId, blockNumber), jobId);
    },
    async getTerms(jobId, requested) {
      const blockNumber = await selectBlock(jobId, requested);
      return normalizeTerms(await read(arcHookAbi, cfg.hook, "terms", jobId, blockNumber));
    },
    decodeLogs(logs) {
      const result: DecodedEvent[] = [];
      for (const log of logs) {
        if (log.removed || log.blockNumber == null || log.transactionHash == null || log.logIndex == null) continue;
        const emitter = log.address.toLowerCase();
        let contract: DecodedEvent["contract"];
        let abi: Abi;
        if (emitter === cfg.core.toLowerCase()) [contract, abi] = ["core", arcCoreAbi];
        else if (emitter === cfg.hook.toLowerCase()) [contract, abi] = ["hook", arcHookAbi];
        else if (emitter === cfg.usdc.toLowerCase()) [contract, abi] = ["usdc", arcErc20Abi];
        else continue;
        try {
          const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
          if (!event.eventName || (contract === "usdc" && event.eventName !== "Transfer")) continue;
          result.push({
            name: event.eventName,
            contract,
            args: { ...((event.args ?? {}) as unknown as Record<string, unknown>) },
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
          });
        } catch {
          // Unrecognized or malformed data is not settlement evidence.
        }
      }
      return result;
    },
  };
}
