import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, readFile, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseTransaction, sha256, type Hex } from "viem";
import { arcCoreAbi } from "@ubc26/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createOpenClaimBroadcaster, createOpenClaimRefundBroadcaster, type OpenClaimBroadcasterConfig } from "../../src/local-broadcaster.ts";
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
it("signs only the exact expired-job refund and keeps a durable hash after RPC loss", async () => {
  const f = await fixture(); let at = 99n;
  f.cfg.public.getBlock = async () => ({ number:10n, hash:sha256("0xab"), timestamp:at });
  const b = await createOpenClaimRefundBroadcaster({ ...f.cfg, expiresAt:100n, validUntil:200n, now:()=>at }); close.push(b.close);
  const tx = { ...f.tx, to:core, data:encodeFunctionData({abi:arcCoreAbi,functionName:"claimRefund",args:[7n]}) } as const;
  await expect(b.broadcast(tx)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
  at = 100n;
  await expect(b.broadcast({ ...tx, data:f.tx.data })).rejects.toThrow();
  let hash: Hex | undefined;
  f.rawSend.mockImplementation(async r => { hash=keccak256(r.params[0]);throw Error("lost"); });
  await expect(b.broadcast(tx)).rejects.toThrow();
  expect(await b.transactionHash(tx)).toBe(hash);
  await expect(b.broadcast(tx)).rejects.toThrow();expect(f.rawSend).toHaveBeenCalledTimes(1);
});
it("opens a refund journal after buyer funding created the account directory, then refuses journal loss", async () => {
  const f=await fixture();
  await mkdir(join(f.cfg.journalRoot,account.address.toLowerCase()),{mode:0o700});
  const config={...f.cfg,expiresAt:100n,validUntil:200n};
  const b=await createOpenClaimRefundBroadcaster(config);
  expect(b.journalPath).toContain("refund-journal.json");
  await b.close();await unlink(b.journalPath);
  await expect(createOpenClaimRefundBroadcaster(config)).rejects.toThrow();
});
it("reserves two different expired-job refunds against one cumulative buyer budget", async()=>{
  const f=await fixture(),seen=new Map<Hex,any>(),blockHash=sha256("0xab");
  f.rawSend.mockImplementation(async r=>{const t=parseTransaction(r.params[0]),hash=keccak256(r.params[0]);
    seen.set(hash,{...t,hash,from:account.address,value:t.value??0n,input:t.data??"0x",maxPriorityFeePerGas:t.maxPriorityFeePerGas??0n,blockNumber:10n,blockHash});return hash;});
  f.cfg.public.getTransaction=async({hash})=>seen.get(hash);
  f.cfg.public.getTransactionReceipt=async({hash})=>({transactionHash:hash,from:account.address,to:core,blockNumber:10n,blockHash,gasUsed:90_000n,effectiveGasPrice:ARC_MIN_FEE,status:"success"});
  let b;
  try {
    for(const jobId of [7n,8n]){
      b=await createOpenClaimRefundBroadcaster({...f.cfg,jobId,expiresAt:100n,validUntil:200n});
      const tx={...f.tx,to:core,data:encodeFunctionData({abi:arcCoreAbi,functionName:"claimRefund",args:[jobId]})} as const;
      const hash=await b.broadcast(tx);await b.reconcile(hash);await b.close();
    }
    const j=JSON.parse(await readFile(b!.journalPath,"utf8"));
    expect(j.entries.map((e:any)=>e.nonce)).toEqual([0,1]);
    expect(j.entries.every((e:any)=>e.charged===e.maximum&&e.stage==="confirmed")).toBe(true);
  } finally {await b?.close();await rm(f.cfg.journalRoot,{recursive:true,force:true});}
});
it("blocks unresolved funding and reserves sibling funding nonces before a refund", async () => {
  const f=await fixture();
  // readSafeFile rejects world-writable /tmp ancestors on Linux.
  f.cfg.journalRoot=await realpath(await mkdtemp(join(process.cwd(),".open-claim-sibling-")));
  let b: Awaited<ReturnType<typeof createOpenClaimRefundBroadcaster>> | undefined;
  try {
    b=await createOpenClaimRefundBroadcaster({...f.cfg,expiresAt:100n,validUntil:200n});
    const path=join(b.directory,"poster-funding.json");
    const sibling={version:1,buyer:account.address,runs:{job:{entries:[{nonce:5,stage:"signed"}]}}};
    await writeFile(path,JSON.stringify(sibling),{mode:0o600});
    const tx={...f.tx,to:core,data:encodeFunctionData({abi:arcCoreAbi,functionName:"claimRefund",args:[7n]})} as const;
    await expect(b.broadcast(tx)).rejects.toThrow();expect(f.rawSend).not.toHaveBeenCalled();
    sibling.runs.job.entries[0]!.stage="confirmed";await writeFile(path,JSON.stringify(sibling));
    await b.broadcast(tx);
    expect(parseTransaction(f.rawSend.mock.calls[0]![0].params[0]).nonce).toBe(6);
  } finally {
    await b?.close();
    await rm(f.cfg.journalRoot,{recursive:true,force:true});
  }
});
