import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createViemOpenClaimReader } from "../../src/open-claim-reader.ts";

describe("confirmed open-claim API reader", () => {
  it("observes a newly confirmed block without waiting for Viem's head cache", async () => {
    let head = 42n;
    const client = {
      getChainId: vi.fn(async () => 5_042_002),
      getBlockNumber: vi.fn(async (options?: { cacheTime?: number }) => options?.cacheTime === 0 ? head : 42n),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber * 10n })),
    } as unknown as PublicClient;
    const reader = createViemOpenClaimReader(client, {
      mode: "arc", chainId: 5_042_002,
      core: "0x1111111111111111111111111111111111111111",
      adapter: "0x2222222222222222222222222222222222222222",
      verifier: "0x3333333333333333333333333333333333333333",
      usdc: "0x4444444444444444444444444444444444444444",
    }, 3n);

    expect((await reader.clock()).blockNumber).toBe(39n);
    head = 43n;
    expect((await reader.clock()).blockNumber).toBe(40n);
  });
});
