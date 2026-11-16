import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { keccak256, parseTransaction, sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createArcSetupBroadcaster, arcSetupCalls } from "../../src/local-broadcaster.ts";

// Public synthetic identity. No RPC or real wallet access.
const account=privateKeyToAccount(`0x${"01".repeat(32)}`);
const solver="0x2222222222222222222222222222222222222222" as const;
const clean: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of clean.splice(0).reverse()) await f();});
async function fixture(){
  const journalRoot=await realpath(await mkdtemp(join(process.cwd(),".arc-setup-")));
  clean.push(()=>rm(journalRoot,{recursive:true,force:true}));
  const rawSend=vi.fn(async(r:{params:readonly [Hex]})=>keccak256(r.params[0]));
  const transactions=new Map<Hex,any>();
  const pub={getChainId:async()=>5042002,getTransactionCount:async()=>0,
    getBlock:async()=>({number:10n,hash:sha256("0xab"),timestamp:100n}),
    getTransactionReceipt:async({hash}:any):Promise<any>=>{const t=transactions.get(hash);if(!t)throw Error("missing");
      return {transactionHash:hash,from:account.address,to:t.to,blockNumber:10n,blockHash:sha256("0xab"),gasUsed:21000n,effectiveGasPrice:25_000_000_000n,status:"success"};},
    getTransaction:async({hash}:any):Promise<any>=>{if(!transactions.has(hash))throw Error("missing");return transactions.get(hash);}};
  rawSend.mockImplementation(async r=>{const raw=r.params[0],hash=keccak256(raw),t=parseTransaction(raw);
    transactions.set(hash,{...t,hash,from:account.address,input:t.data??"0x",value:t.value??0n,blockNumber:10n,blockHash:sha256("0xab")});return hash;});
  const cfg={account,solver,validUntil:200n,journalRoot,public:pub,rawSend,now:()=>100n};
  return {cfg,rawSend};
}
it("permits only the exact solver transfer and the two approved Gateway calls",async()=>{
  const {cfg,rawSend}=await fixture(), b=await createArcSetupBroadcaster(cfg);clean.push(b.close);
  const [tx]=arcSetupCalls(solver);
  for(const changed of [{to:account.address},{value:tx!.value+1n},{gas:tx!.gas+1n},{data:"0x01" as Hex},{chainId:1}])
    await expect(b.broadcast({...tx!,...changed})).rejects.toThrow();
  await b.broadcast(tx!);
  const parsed=parseTransaction(rawSend.mock.calls[0]![0].params[0]);
  expect(parsed.value).toBe(40_000_000_000_000_000n);expect(parsed.nonce).toBe(0);
  await expect(b.broadcast(tx!)).rejects.toThrow();expect(rawSend).toHaveBeenCalledTimes(1);
  const j=JSON.parse(await readFile(b.journalPath,"utf8"));expect(j.entries[0].value).toBe(String(tx!.value));
});
it("confirms all three fixed calls in order and retains the full gas reservations",async()=>{
  const {cfg,rawSend}=await fixture(),b=await createArcSetupBroadcaster(cfg);clean.push(b.close);
  const calls=arcSetupCalls(solver);
  await expect(b.broadcast(calls[1]!)).rejects.toThrow();
  for(const tx of calls){const hash=await b.broadcast(tx);expect((await b.reconcile(hash)).status).toBe("success");}
  expect(rawSend).toHaveBeenCalledTimes(3);
  const j=JSON.parse(await readFile(b.journalPath,"utf8"));
  expect(j.entries.reduce((sum:bigint,e:any)=>sum+BigInt(e.maximum),0n)).toBe(6_375_000_000_000_000n);
  expect(j.entries.map((e:any)=>e.nonce)).toEqual([0,1,2]);
  expect(j.entries.every((e:any)=>e.stage==="confirmed"&&e.maximum===e.charged)).toBe(true);
});
it("recovers a dropped setup send by hash without another signature or dispatch",async()=>{
  const {cfg,rawSend}=await fixture(), b=await createArcSetupBroadcaster(cfg);clean.push(b.close);
  const tx=arcSetupCalls(solver)[0]!;let hash:Hex|undefined;
  rawSend.mockImplementation(async r=>{hash=keccak256(r.params[0]);throw Error("dropped");});
  await expect(b.broadcast(tx)).rejects.toThrow();expect(await b.transactionHash(tx)).toBe(hash);
  await expect(b.broadcast(tx)).rejects.toThrow();expect(rawSend).toHaveBeenCalledTimes(1);
});
it("blocks unresolved funding, reserves prior nonces, and refuses deletion of the setup journal",async()=>{
  const {cfg,rawSend}=await fixture(), b=await createArcSetupBroadcaster(cfg);
  const path=join(b.directory,"poster-funding.json");
  const journal={version:1,buyer:account.address,runs:{job:{entries:[{nonce:8,stage:"sent"}]}}};
  await writeFile(path,JSON.stringify(journal),{mode:0o600});
  const tx=arcSetupCalls(solver)[0]!;
  await expect(b.broadcast(tx)).rejects.toThrow();expect(rawSend).not.toHaveBeenCalled();
  journal.runs.job.entries[0]!.stage="confirmed";await writeFile(path,JSON.stringify(journal));
  await b.broadcast(tx);expect(parseTransaction(rawSend.mock.calls[0]![0].params[0]).nonce).toBe(9);
  await b.close();await unlink(b.journalPath);
  await expect(createArcSetupBroadcaster(cfg)).rejects.toThrow();
});
