import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createViemOpenClaimPort } from "@ubc26/sdk";
import type { OpenClaimDeployment } from "@ubc26/sdk";

const deployment: OpenClaimDeployment = {
  mode: "open-claim",
  chainId: 5_042_002,
  core: "0x1111111111111111111111111111111111111111",
  adapter: "0x2222222222222222222222222222222222222222",
  verifier: "0x3333333333333333333333333333333333333333",
  usdc: "0x4444444444444444444444444444444444444444",
};
const buyer = "0x5555555555555555555555555555555555555555";
const rules = `0x${"66".repeat(32)}`;
const reference = `0x${"77".repeat(32)}`;
const image = `0x${"88".repeat(32)}`;

describe("read-only open-claim chain port", () => {
  it("pins every read to one block and decodes the compiled adapter's flat getters", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string; blockNumber: bigint }) => {
      switch (functionName) {
        case "paymentToken": case "usdc": return deployment.usdc;
        case "core": return deployment.core;
        case "verifier": return deployment.verifier;
        case "platformFeeBP": case "evaluatorFeeBP": return 0n;
        case "MAX_ENVELOPE_BYTES": return 16_412n;
        case "MIN_EXPIRY_MARGIN": return 600n;
        case "getJob": return { id: 7n, client: buyer, provider: deployment.adapter,
          evaluator: deployment.adapter, hook: "0x0000000000000000000000000000000000000000",
          description: "open bounty", budget: 1_000_000n, expiredAt: 1_800_003_600n, status: 1 };
        case "terms": return [buyer, image, rules, reference, 1_000_000n, 1_800_003_600n, true];
        case "submissions": return ["0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`,
          `0x${"00".repeat(32)}`, false];
        case "released": return false;
        default: throw new Error(`unexpected read ${functionName}`);
      }
    });
    const getBytecode = vi.fn(async (_request: { address: string; blockNumber: bigint }) => "0x6000");
    let head = 42n;
    // Viem can return a cached head unless the caller disables that cache.
    const getBlockNumber = vi.fn(async (options?: { cacheTime?: number }) => options?.cacheTime === 0 ? head : 42n);
    const client = { getChainId: vi.fn(async () => 5_042_002), getBlockNumber,
      getBytecode, readContract } as unknown as PublicClient;
    const port = createViemOpenClaimPort(client);
    const observation = await port.observe(deployment);
    expect(observation).toMatchObject({ adapterCode: "present", adapterCore: deployment.core,
      adapterVerifier: deployment.verifier, token: deployment.usdc, maxEnvelopeBytes: 16_412n });
    const snapshot = await port.snapshot(deployment, 7n);
    expect(snapshot.blockNumber).toBe(42n);
    expect(snapshot.job).toMatchObject({ id: 7n, client: buyer, budget: 1_000_000n, status: 1 });
    expect(snapshot.terms).toMatchObject({ buyer, imageId: image, rulesHash: rules,
      referenceHash: reference, registered: true });
    expect(snapshot.submission).toBeNull();
    expect(readContract.mock.calls.every(([request]) => request.blockNumber === 42n)).toBe(true);
    expect(getBytecode.mock.calls[0]?.[0]).toMatchObject({ address: deployment.adapter, blockNumber: 42n });
    head = 43n;
    expect((await port.snapshot(deployment, 7n)).blockNumber).toBe(43n);
    const anchored = createViemOpenClaimPort(client, { confirmations: 3n, blockNumber: 39n });
    expect((await anchored.snapshot(deployment, 7n)).blockNumber).toBe(39n);
    head = 80n;
    expect((await anchored.snapshot(deployment, 7n)).blockNumber).toBe(39n);
    await expect(createViemOpenClaimPort(client, { confirmations: 3n, blockNumber: 79n }).observe(deployment)).rejects.toThrow();
  });
});
