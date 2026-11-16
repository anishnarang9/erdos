import { expect,it,vi } from "vitest";
import { mkdtemp,realpath,rm,readFile,mkdir,writeFile,unlink } from "node:fs/promises";
import {join} from "node:path";
import {getContractAddress,keccak256,parseTransaction,type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sendApprovedArcCreation,reconcileArcCreation} from "../../src/arc-creation.ts";

it("persists a bounded creation hash before one send and never signs again after a lost reply",async()=>{
  // Public synthetic account, no RPC.
  const account=privateKeyToAccount(`0x${"01".repeat(32)}`),data="0x60006000" as Hex;
  const root=await realpath(await mkdtemp(join(process.cwd(),".arc-creation-")));
  const sign=vi.spyOn(account,"signTransaction"),rawSend=vi.fn(async(r:any)=>{
    const journal=JSON.parse(await readFile(join(root,account.address.toLowerCase(),"deployment-journal.json"),"utf8"));
    expect(journal.entries[0].hash).toBe(keccak256(r.params[0]));expect(journal.entries[0].stage).toBe("intent");
    expect(journal.entries[0].raw).toBe(r.params[0]);
    const tx=parseTransaction(r.params[0]);expect(tx.to).toBeUndefined();expect(tx.value??0n).toBe(0n);
    expect(tx.nonce).toBe(0);expect(tx.gas).toBe(3_072_197n);throw Error("lost RPC reply");
  });
  const cfg={account,data,approvedDataHash:keccak256(data),validUntil:200n,now:()=>100n,journalRoot:root,rawSend,
    public:{getChainId:async()=>5042002,getTransactionCount:async()=>0,getBlock:async()=>({timestamp:100n})}};
  try {
    await expect(sendApprovedArcCreation(cfg)).rejects.toThrow();
    const saved=JSON.parse(await readFile(join(root,account.address.toLowerCase(),"deployment-journal.json"),"utf8"));
    expect(await sendApprovedArcCreation(cfg)).toBe(saved.entries[0].hash);
    expect(rawSend).toHaveBeenCalledTimes(1);expect(sign).toHaveBeenCalledTimes(1);
    await expect(sendApprovedArcCreation({...cfg,data:"0x6000"})).rejects.toThrow();
  } finally {sign.mockRestore();await rm(root,{recursive:true,force:true});}
});
it("blocks a pending sibling, reserves confirmed sibling nonces, and checks runtime and exact deployment gas loss",async()=>{
  const account=privateKeyToAccount(`0x${"01".repeat(32)}`),data="0x60006000" as Hex;
  const root=await realpath(await mkdtemp(join(process.cwd(),".arc-creation-"))),directory=join(root,account.address.toLowerCase());
  await mkdir(directory,{mode:0o700});
  const sibling={version:1,account:account.address,entries:[{nonce:4,stage:"intent"}]};
  const path=join(directory,"setup-journal.json");await writeFile(path,JSON.stringify(sibling),{mode:0o600});
  let tx:any,hash:Hex|undefined;const blockHash=keccak256("0xab"),spent=2_500_000n*25_000_000_000n;
  const rawSend=vi.fn(async(r:any)=>{hash=keccak256(r.params[0]);tx=parseTransaction(r.params[0]);return hash!;});
  const cfg={account,data,approvedDataHash:keccak256(data),validUntil:200n,now:()=>100n,journalRoot:root,rawSend,
    public:{getChainId:async()=>5042002,getTransactionCount:async()=>0,getBlock:async()=>({timestamp:100n})}};
  try{
    await expect(sendApprovedArcCreation(cfg)).rejects.toThrow();expect(rawSend).not.toHaveBeenCalled();
    sibling.entries[0]!.stage="confirmed";await writeFile(path,JSON.stringify(sibling));
    await sendApprovedArcCreation(cfg);expect(tx.nonce).toBe(5);
    const publicClient={getChainId:async()=>5042002,getBlockNumber:async()=>13n,getCode:async()=>"0x6000",
      getBlock:async()=>({hash:blockHash}),getBalance:async({blockNumber}:any)=>blockNumber===9n?10n**18n:10n**18n-spent,
      getTransactionReceipt:async()=>({transactionHash:hash,from:account.address,to:null,contractAddress:getContractAddress({from:account.address,nonce:5n}),status:"success",blockNumber:10n,blockHash,gasUsed:2_500_000n,effectiveGasPrice:25_000_000_000n}),
      getTransaction:async()=>({...tx,hash,from:account.address,to:null,value:0n,input:data,blockNumber:10n,blockHash})};
    const rc={account:account.address,journalRoot:root,public:publicClient as any,expectedRuntimeHash:keccak256("0x6000")};
    await expect(reconcileArcCreation({...rc,expectedRuntimeHash:keccak256("0x6001")})).rejects.toThrow();
    expect((await reconcileArcCreation(rc)).spent).toBe(spent);
    await unlink(join(directory,"deployment-journal.json"));await expect(sendApprovedArcCreation(cfg)).rejects.toThrow();
    expect(rawSend).toHaveBeenCalledTimes(1);
  }finally{await rm(root,{recursive:true,force:true});}
});
