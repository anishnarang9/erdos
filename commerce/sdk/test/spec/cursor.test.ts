// CONTRACT.md §2 LogCursor (L191-194) + "Settled in cross-validation round 2" rule 6. Fake client, no chain.
import { describe, it, expect } from "vitest";
import type { Log, PublicClient } from "viem";
import { LogCursor } from "../../src/index.ts";
import type { DecodedEvent } from "../../src/index.ts";

interface Call {
  from: bigint;
  to: bigint;
}

function fakeClient(head: bigint, getLogs: (c: Call, n: number) => Promise<Log[]>) {
  const calls: Call[] = [];
  const client = {
    getBlockNumber: async () => head,
    getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
      const c = { from: args.fromBlock, to: args.toBlock };
      calls.push(c);
      return getLogs(c, calls.length);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

function memStore(initial: bigint | null = null) {
  let v = initial;
  const saves: bigint[] = [];
  return { saves, load: () => v, save: (b: bigint) => void (saves.push(b), (v = b)) };
}

const fakeLog = (block: bigint) => ({ blockNumber: block, logIndex: 0, transactionHash: `0x${"ab".repeat(32)}` }) as unknown as Log;
const decode = (logs: Log[]): DecodedEvent[] =>
  logs.map((l) => ({ name: "X", contract: "core", args: {}, blockNumber: l.blockNumber!, logIndex: 0, transactionHash: l.transactionHash! }));

describe("LogCursor with a fake client", () => {
  it("L194 retries a -32005 rate-limit error on getLogs with the same window", async () => {
    const { client, calls } = fakeClient(50n, async (c, n) => {
      if (n === 1) throw Object.assign(new Error("rate limit"), { code: -32005 });
      return [fakeLog(c.from)];
    });
    const store = memStore();
    const cursor = new LogCursor(client, { addresses: [], fromBlock: 10n, decode, store });
    const evs = await cursor.next();
    expect(evs).toHaveLength(1);
    expect(calls).toEqual([
      { from: 10n, to: 50n },
      { from: 10n, to: 50n },
    ]);
    expect(store.load()).toBe(50n);
    expect(cursor.caughtUp).toBe(true);
  }, 20_000);

  it("R2.6 halves the window on 'block range too large' and saves only what was read", async () => {
    const { client, calls } = fakeClient(10_000n, async (c) => {
      if (c.to - c.from + 1n > 250n) throw new Error("block range too large");
      return [];
    });
    const store = memStore();
    const cursor = new LogCursor(client, { addresses: [], fromBlock: 0n, decode, store, maxRange: 1000n });
    await cursor.next();
    const widths = calls.map((c) => c.to - c.from + 1n);
    expect(widths.slice(0, 3)).toEqual([1000n, 500n, 250n]);
    expect(store.load()).toBe(249n);
    expect(cursor.caughtUp).toBe(false);
    await cursor.next();
    expect(calls.at(-1)!.from).toBe(250n); // no gap, no overlap
  });

  it("R2.6 'query returned more than 10000 results' also halves", async () => {
    const { client, calls } = fakeClient(100n, async (c) => {
      if (c.to - c.from + 1n > 30n) throw new Error("query returned more than 10000 results");
      return [];
    });
    const store = memStore();
    await new LogCursor(client, { addresses: [], fromBlock: 1n, decode, store, maxRange: 100n }).next();
    expect(calls.at(-1)!.to - calls.at(-1)!.from + 1n).toBeLessThanOrEqual(30n);
    expect(store.load()).toBe(calls.at(-1)!.to);
  });

  it("R2.6 halving stops at 1 block; then the error surfaces and nothing is saved", async () => {
    const { client, calls } = fakeClient(1000n, async () => {
      throw new Error("block range too large");
    });
    const store = memStore(99n);
    const cursor = new LogCursor(client, { addresses: [], fromBlock: 0n, decode, store, maxRange: 64n });
    await expect(cursor.next()).rejects.toThrow();
    const widths = calls.map((c) => c.to - c.from + 1n);
    expect(widths).toContain(1n);
    expect(widths.every((w) => w >= 1n)).toBe(true);
    expect(calls.every((c) => c.from === 100n)).toBe(true);
    expect(store.saves).toEqual([]);
  });

  it("L193 a non-retryable getLogs error is attempted once and nothing is saved", async () => {
    const { client, calls } = fakeClient(1000n, async () => {
      throw new Error("boom");
    });
    const store = memStore(5n);
    await expect(new LogCursor(client, { addresses: [], fromBlock: 0n, decode, store }).next()).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.from).toBe(6n);
    expect(store.saves).toEqual([]);
  });

  it("R2.6 explicit undefined maxRange/confirmations fall back to defaults", async () => {
    const { client, calls } = fakeClient(100n, async () => []);
    const store = memStore();
    const cursor = new LogCursor(client, { addresses: [], fromBlock: 0n, decode, store, maxRange: undefined, confirmations: undefined });
    await expect(cursor.next()).resolves.toEqual([]);
    expect(calls).toEqual([{ from: 0n, to: 100n }]);
    expect(store.load()).toBe(100n);
  });

  it("L193 confirmations hold back the head; caughtUp true when nothing is left", async () => {
    const { client, calls } = fakeClient(100n, async () => []);
    const store = memStore(90n);
    const cursor = new LogCursor(client, { addresses: [], fromBlock: 0n, decode, store, confirmations: 5n });
    await cursor.next();
    expect(calls).toEqual([{ from: 91n, to: 95n }]);
    expect(cursor.caughtUp).toBe(true);
    expect(await cursor.next()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
