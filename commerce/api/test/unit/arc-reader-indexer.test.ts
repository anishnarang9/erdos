import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log, type PublicClient } from "viem";
import { arcCoreAbi, arcHookAbi } from "@ubc26/sdk";
import { createApiArcChain, readChain } from "../../src/chain.ts";
import { createIndexer } from "../../src/indexer.ts";
import { openDb } from "../../src/db.ts";
import { EVENT_STATUS } from "../../src/market.ts";

const config = { chainId: 31337, core: "0x1111111111111111111111111111111111111111", hook: "0x2222222222222222222222222222222222222222", usdc: "0x3333333333333333333333333333333333333333" } as const;
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;

function event(name: string, address: Address, index: number, data: Hex = "0x"): Log {
  const abi = address === config.core ? arcCoreAbi : arcHookAbi;
  const topics = encodeEventTopics({ abi, eventName: name, args: { jobId: 7n } });
  return { address, topics, data, blockNumber: 42n, logIndex: index, transactionHash: hash("ab"), blockHash: hash("cd"), transactionIndex: 0, removed: false } as Log;
}

describe("API real Arc reader and indexer wiring", () => {
  it("factory installs the SDK reader and pins actual contract reads to the requested block", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getJob": return { id: 7n, client: config.usdc, provider: config.core, evaluator: config.hook, description: "ubc26:test", budget: 100n, expiredAt: 900n, status: 1, hook: config.hook };
        case "terms": return [hash("11"), hash("22"), hash("33"), config.core, 100n, 900n, true];
        case "contextOf": return "0x1234";
        case "submissions": return [hash("00"), hash("00"), false];
        case "released": return false;
        default: throw new Error(`unexpected ${functionName}`);
      }
    });
    const getBlock = vi.fn(async () => ({ number: 42n, hash: hash("cd"), timestamp: 800n }));
    const client = { getChainId: vi.fn(async () => 31337), readContract, getBlock } as unknown as PublicClient;
    const chain = createApiArcChain(config, client);
    expect(chain.mode).toBe("arc");
    const snapshot = await readChain(chain).getSnapshot!(7n, 42n);
    expect(snapshot).toMatchObject({ blockNumber: 42n, timestamp: 800n, job: { status: 1 }, terms: { expiredAt: 900n } });
    expect(snapshot.context).toEqual(new Uint8Array([0x12, 0x34]));
    expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 42n });
    expect(readContract).toHaveBeenCalledTimes(5);
    for (const [request] of readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 42n });
  });

  it("rejects a wrong RPC chain before cursor reads, log reads, or persistence", async () => {
    const getChainId = vi.fn(async () => 1);
    const getBlockNumber = vi.fn(async () => 42n);
    const getLogs = vi.fn(async () => []);
    const chain = createApiArcChain(config, { getChainId, getBlockNumber, getLogs } as unknown as PublicClient);
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain, cursorStart: 42n });
      await expect(indexer.tick()).rejects.toThrow(/RPC chain ID/);
      expect(getBlockNumber).not.toHaveBeenCalled();
      expect(getLogs).not.toHaveBeenCalled();
      expect(db.prepare("SELECT * FROM index_cursor").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM events").all()).toEqual([]);
      getChainId.mockResolvedValue(31337);
      expect(await indexer.tick()).toBe(0);
      expect(db.prepare("SELECT last_block FROM index_cursor").get()).toMatchObject({ last_block: 42 });
      getChainId.mockResolvedValue(1);
      await expect(indexer.tick()).rejects.toThrow(/RPC chain ID/);
      expect(db.prepare("SELECT last_block FROM index_cursor").get()).toMatchObject({ last_block: 42 });
    } finally { db.close(); }
  });

  it("indexes real JobExpired/JobRejected/ProofAccepted/KeyReleased logs and resumes the same LogCursor", async () => {
    const proofData = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [hash("11"), hash("22")]);
    const logs = [
      event("JobExpired", config.core, 0),
      event("JobRejected", config.core, 1, hash("00")),
      event("ProofAccepted", config.hook, 2, proofData),
      event("KeyReleased", config.hook, 3, proofData),
      { ...event("JobExpired", config.core, 4), address: config.usdc }, // Same signature, foreign emitter: ignored.
    ];
    // The rejected/released events have a second indexed address.
    logs[1]!.topics = encodeEventTopics({ abi: arcCoreAbi, eventName: "JobRejected", args: { jobId: 7n, rejector: config.hook } }) as Log["topics"];
    logs[3]!.topics = encodeEventTopics({ abi: arcHookAbi, eventName: "KeyReleased", args: { jobId: 7n, provider: config.core } }) as Log["topics"];
    const getLogs = vi.fn(async () => logs);
    const client = { getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => 42n), getLogs } as unknown as PublicClient;
    const chain = createApiArcChain(config, client);
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain, cursorStart: 42n });
      expect(await indexer.tick()).toBe(4);
      const rows = db.prepare("SELECT name, contract, address, job_id FROM events ORDER BY log_index").all();
      expect(rows.map((row) => row.name)).toEqual(["JobExpired", "JobRejected", "ProofAccepted", "KeyReleased"]);
      expect(rows[2]).toMatchObject({ contract: "hook", address: config.hook, job_id: "7" });
      expect(EVENT_STATUS.JobExpired).toBe("Expired");
      expect(EVENT_STATUS.JobRejected).toBe("Rejected");
      expect(await indexer.tick()).toBe(0);
      expect(await createIndexer({ db, chain, cursorStart: 0n }).tick()).toBe(0);
      expect(getLogs).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT last_block FROM index_cursor").get()).toMatchObject({ last_block: 42 });
    } finally { db.close(); }
  });

  function acceptanceAndRelease(at: [bigint, bigint]): Log[] {
    const proofData = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [hash("11"), hash("22")]);
    const accepted = { ...event("ProofAccepted", config.hook, 0, proofData), blockNumber: at[0] };
    const released = { ...event("KeyReleased", config.hook, 1, proofData), blockNumber: at[1] };
    released.topics = encodeEventTopics({ abi: arcHookAbi, eventName: "KeyReleased", args: { jobId: 7n, provider: config.core } }) as Log["topics"];
    return [accepted, released];
  }

  function cursorOf(db: ReturnType<typeof openDb>): number | bigint | undefined {
    return (db.prepare("SELECT last_block FROM index_cursor").get() as { last_block: number | bigint } | undefined)?.last_block;
  }

  it("holds a lagging getLogs window three blocks behind missing acceptance and release logs", async () => {
    const missing = acceptanceAndRelease([9n, 10n]);
    let head = 10n;
    let lagging = true;
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (lagging) return [];
      return missing.filter((log) => (log.blockNumber ?? -1n) >= fromBlock && (log.blockNumber ?? -1n) <= toBlock);
    });
    const client = { getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => head), getLogs } as unknown as PublicClient;
    const chain = createApiArcChain(config, client);
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain, cursorStart: 0n, confirmations: 3n });
      expect(await indexer.tick()).toBe(0);
      expect(cursorOf(db)).toBe(7);
      expect(db.prepare("SELECT name FROM events").all()).toEqual([]);
      expect(getLogs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fromBlock: 0n, toBlock: 7n }));

      lagging = false;
      head = 13n;
      expect(await indexer.tick()).toBe(2);
      expect(db.prepare("SELECT name FROM events ORDER BY block, log_index").all().map((row) => row.name)).toEqual(["ProofAccepted", "KeyReleased"]);
      expect(cursorOf(db)).toBe(10);
    } finally { db.close(); }
  });

  it("keeps omitted confirmations at zero for a simulated caller, so a lagging read can pass the missing logs", async () => {
    const missing = acceptanceAndRelease([9n, 10n]);
    let head = 10n;
    let lagging = true;
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (lagging) return [];
      return missing.filter((log) => (log.blockNumber ?? -1n) >= fromBlock && (log.blockNumber ?? -1n) <= toBlock);
    });
    const client = { getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => head), getLogs } as unknown as PublicClient;
    const chain = { mode: "simulated" as const, config, publicClient: client };
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain, cursorStart: 0n });
      expect(await indexer.tick()).toBe(0);
      expect(cursorOf(db)).toBe(10);
      expect(getLogs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fromBlock: 0n, toBlock: 10n }));
      lagging = false;
      head = 13n;
      expect(await indexer.tick()).toBe(0);
      expect(db.prepare("SELECT name FROM events").all()).toEqual([]);
      expect(cursorOf(db)).toBe(13);
    } finally { db.close(); }
  });

  it("still caps one window at 10000 blocks when confirmations are set", async () => {
    const getLogs = vi.fn(async () => []);
    const client = { getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => 20_000n), getLogs } as unknown as PublicClient;
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain: createApiArcChain(config, client), cursorStart: 0n, confirmations: 3n, maxWindowsPerTick: 1 });
      expect(await indexer.tick()).toBe(0);
      expect(getLogs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fromBlock: 0n, toBlock: 9_999n }));
      expect(cursorOf(db)).toBe(9999);
    } finally { db.close(); }
  });

  it("does not persist a cursor when the confirmed window's getLogs fails", async () => {
    const getLogs = vi.fn(async () => { throw new Error("lagging replica unavailable"); });
    const client = { getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => 10n), getLogs } as unknown as PublicClient;
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain: createApiArcChain(config, client), cursorStart: 0n, confirmations: 3n });
      await expect(indexer.tick()).rejects.toThrow(/lagging replica unavailable/);
      expect(cursorOf(db)).toBeUndefined();
      expect(db.prepare("SELECT * FROM events").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("still rejects a wrong RPC chain before log reads when confirmations are set", async () => {
    const getBlockNumber = vi.fn(async () => 10n);
    const getLogs = vi.fn(async () => []);
    const client = { getChainId: vi.fn(async () => 1), getBlockNumber, getLogs } as unknown as PublicClient;
    const db = openDb(":memory:", () => 0);
    try {
      const indexer = createIndexer({ db, chain: createApiArcChain(config, client), cursorStart: 0n, confirmations: 3n });
      await expect(indexer.tick()).rejects.toThrow(/RPC chain ID/);
      expect(getBlockNumber).not.toHaveBeenCalled();
      expect(getLogs).not.toHaveBeenCalled();
      expect(cursorOf(db)).toBeUndefined();
    } finally { db.close(); }
  });
});
