import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createOpenClaimBroadcaster, type OpenClaimBroadcasterConfig } from "../../src/local-broadcaster.ts";
import { encodeOpenClaimClaim } from "../../src/open-claim/encode.ts";
import { ARC_MIN_FEE } from "../../src/policy.ts";

// Public synthetic key. These tests have no RPC connection.
const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const core = "0x1111111111111111111111111111111111111111";
const adapter = "0x2222222222222222222222222222222222222222";
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of close.splice(0)) await f(); });
async function fixture() {
  const authorization = { kind: "claim" as const, jobId: 7n, envelope: "0xab" as Hex,
    seal: "0xe71e6620aabb" as Hex, keyCommitment: sha256("0xab"), gas: 100_000n, caller: account.address };
  const tx = { chainId: 5042002, to: adapter, from: account.address,
    data: encodeOpenClaimClaim(authorization), value: 0n, gas: authorization.gas,
    maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 0n } as const;
  const publicClient = {
    getChainId: async () => 5042002, getTransactionCount: async () => 0,
    getBlock: async () => ({ number: 10n, hash: sha256("0xab"), timestamp: 100n }),
    getTransactionReceipt: async (): Promise<any> => { throw Error("missing"); },
    getTransaction: async (): Promise<any> => { throw Error("missing"); },
  };
  const rawSend = vi.fn(async (r: { params: readonly [Hex] }) => keccak256(r.params[0]));
  const cfg: OpenClaimBroadcasterConfig = { account, provider: account.address, chainId: 5042002,
    core, adapter, jobId: 7n, expiresAt: 1000n, submitDeadline: 800n, releaseDeadline: 900n,
    validUntil: 1000n, maxGas: 200_000n, maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 0n,
    totalBudget: 300_000n * ARC_MIN_FEE, releaseGas: 100_000n,
    authorizations: [authorization], public: publicClient, rawSend, now: () => 100n,
    journalRoot: await realpath(await mkdtemp(join(tmpdir(), "open-claim-signer-"))) };
  return { cfg, tx, rawSend };
}
it("restricts a local signer to the exact adapter claim and reserves release gas", async () => {
  const f = await fixture(); const b = await createOpenClaimBroadcaster(f.cfg); close.push(b.close);
  await expect(b.broadcast({ ...f.tx, to: core })).rejects.toThrow();
  await expect(b.broadcast({ ...f.tx, data: `${f.tx.data}00` })).rejects.toThrow();
  const hash = await b.broadcast(f.tx);
  expect(f.rawSend).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(await readFile(b.journalPath, "utf8"));
  expect(saved.entries[0].hash).toBe(hash);
  expect(Object.values(saved.releaseHolds)).toEqual([String(100_000n * ARC_MIN_FEE)]);
  await expect(b.broadcast(f.tx)).rejects.toThrow();
});
it("recovers the durable hash after a dropped RPC response without another signature or send", async () => {
  const f = await fixture(); let sent: Hex | undefined;
  f.rawSend.mockImplementation(async r => { sent = keccak256(r.params[0]); throw Error("dropped response"); });
  const b = await createOpenClaimBroadcaster(f.cfg);
  await expect(b.broadcast(f.tx)).rejects.toThrow();
  await b.close();
  const resumed = await createOpenClaimBroadcaster(f.cfg); close.push(resumed.close);
  expect(await resumed.transactionHash(f.tx)).toBe(sent);
  expect(await resumed.transactionHash({ ...f.tx, data: `${f.tx.data}00` })).toBeNull();
  await expect(resumed.broadcast(f.tx)).rejects.toThrow();
  expect(f.rawSend).toHaveBeenCalledTimes(1);
});
it("refuses a claim when the gas budget cannot also cover release", async () => {
  const f = await fixture(); f.cfg.totalBudget = f.tx.gas * ARC_MIN_FEE;
  const b = await createOpenClaimBroadcaster(f.cfg); close.push(b.close);
  await expect(b.broadcast(f.tx)).rejects.toThrow();
  expect(f.rawSend).not.toHaveBeenCalled();
});
