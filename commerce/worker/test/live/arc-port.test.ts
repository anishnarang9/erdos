// Live, read-only: the worker's SettlementPort on Nick's deployed contracts. A throwaway in-memory account
// with no funds; nothing is ever sent. `pnpm test:arc`.
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arc } from "@ubc26/sdk";
import { arcPort } from "../../src/demo/arc-port.ts";

const d = arc.ARC_TESTNET;
const pc = createPublicClient({ transport: http(d.rpcUrl) }) as PublicClient;
const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: http(d.rpcUrl) });
const port = arcPort({ pc, wallet });
const UNKNOWN = 10n ** 30n;

describe("arcPort on live Arc (read-only)", () => {
  it("points at the deployed core and hook on chain 5042002", async () => {
    expect([port.chainId, port.core, port.hook]).toEqual([5042002, d.core, d.hook]);
    expect(await port.now()).toBeGreaterThan(1_700_000_000n);
  });
  it("an unknown job: not found, no terms, no submission, not released", async () => {
    await expect(port.job(UNKNOWN)).rejects.toMatchObject({ code: "not_found" });
    expect((await port.terms(UNKNOWN)).funded).toBe(false);
    expect((await port.submission(UNKNOWN)).accepted).toBe(false);
    expect(await port.released(UNKNOWN)).toBe(false);
  });
  it("release preflight on an unknown job fails with a reason (never the real key)", async () => {
    const r = await port.preflightRelease(UNKNOWN);
    expect(r.ok).toBe(false);
    console.log("[arc-port] release preflight:", JSON.stringify(r));
  });
});
