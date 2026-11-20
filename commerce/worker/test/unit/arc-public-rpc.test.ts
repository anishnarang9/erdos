import { afterEach, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";
import { arcPublicReadTransport } from "../../src/open-claim/arc-public-rpc.ts";

afterEach(() => vi.unstubAllGlobals());

it("retries a limited public RPC read against an independent Arc Testnet endpoint", async () => {
  const read = vi.fn(async (input: string, init: RequestInit) => {
    const request = new Request(input, init);
    const { id } = await request.json() as { id: number };
    if (request.url === "https://rpc.testnet.arc.io/") {
      return new Response("rate limit", { status: 429 });
    }
    return Response.json({ jsonrpc: "2.0", id, result: "0x4cef52" });
  });
  vi.stubGlobal("fetch", read);
  const publicClient = createPublicClient({ transport: arcPublicReadTransport("https://rpc.testnet.arc.io") });
  expect(await publicClient.getChainId()).toBe(5042002);
  expect(read.mock.calls.map(([url]) => url)).toEqual([
    "https://rpc.testnet.arc.io/",
    "https://rpc.quicknode.testnet.arc.io/",
  ]);
});

it("never forwards a signed send on the public read transport", async () => {
  const read = vi.fn();
  vi.stubGlobal("fetch", read);
  const transport = arcPublicReadTransport("https://rpc.testnet.arc.io")({});
  await expect(transport.request({ method: "eth_sendRawTransaction", params: ["0x00"] }, { retryCount: 0 })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
