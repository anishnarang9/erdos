import * as fs from "node:fs";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {getAddress,getContractAddress,isAddressEqual,keccak256,parseTransaction,recoverTransactionAddress,serializeTransaction,stringToHex,
  type Address,type Hex,type LocalAccount,type PublicClient,type TransactionSerialized} from "viem";
import {privateDirectory,readSafeFile,requireSprint as must} from "./sprint-authorization.ts";
import {siblingNonceReservations} from "./account-reservations.ts";
import type {LocalRawSend} from "./local-broadcaster.ts";

const gas=3_072_197n,fee=25_000_000_000n;
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==="bigint"?String(x):x);
type Journal={version:1;account:Address;approval:Hex;entries:{nonce:number;stage:"reserved"|"intent"|"confirmed";hash?:Hex;raw?:Hex;dataHash:Hex;validUntil:string;gas:string;fee:string;maximum:string}[]};
async function journal<T>(root:string,account:Address,approval:Hex|undefined,action:(j:Journal,save:()=>void,directory:string)=>Promise<T>):Promise<T>{
  root=resolve(root);privateDirectory(root);
  const directory=join(root,account.toLowerCase());
  if(!fs.existsSync(directory)){must(approval);fs.mkdirSync(directory,{mode:0o700});}
  privateDirectory(directory);
  const sync=(path:string)=>{const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  sync(root);
  const lockPath=join(directory,"poster-writer.lock"),lock=fs.openSync(lockPath,"wx",0o600),lockStat=fs.fstatSync(lock);
  const owned=()=>{privateDirectory(directory);privateDirectory(root);const s=fs.lstatSync(lockPath);must(!s.isSymbolicLink()&&s.isFile()&&s.nlink===1&&s.ino===lockStat.ino&&s.dev===lockStat.dev&&s.uid===process.getuid?.()&&(s.mode&0o7777)===0o600);};
  try{
    fs.writeFileSync(lock,"owned\n");fs.fsyncSync(lock);sync(directory);
    const path=join(directory,"deployment-journal.json"),marker=join(directory,"deployment-journal-created");
    let identity:fs.Stats|undefined,j:Journal;
    if(fs.existsSync(path)){
      j=JSON.parse(readSafeFile(path,true).toString());identity=fs.lstatSync(path);
      must(j.version===1&&isAddressEqual(j.account,account)&&(!approval||j.approval===approval)&&Array.isArray(j.entries)&&j.entries.length<=1);
      for(const e of j.entries)must(Number.isSafeInteger(e.nonce)&&e.nonce>=0&&["reserved","intent","confirmed"].includes(e.stage)&&e.gas===String(gas)&&e.fee===String(fee)&&e.maximum===String(gas*fee));
    }else{
      must(approval);const fd=fs.openSync(marker,"wx",0o600);try{fs.writeFileSync(fd,"initialized\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync(directory);
      j={version:1,account,approval,entries:[]};
    }
    const save=()=>{
      owned();if(identity){readSafeFile(path,true);const s=fs.lstatSync(path);must(s.ino===identity.ino&&s.dev===identity.dev);}else must(!fs.existsSync(path));
      const temp=join(directory,`.creation-${randomUUID()}`),fd=fs.openSync(temp,"wx",0o600);
      try{fs.writeFileSync(fd,json(j));fs.fsyncSync(fd);owned();fs.renameSync(temp,path);identity=fs.fstatSync(fd);sync(directory);}finally{fs.closeSync(fd);}
    };
    if(!identity)save();
    return await action(j,save,directory);
  }finally{try{owned();fs.unlinkSync(lockPath);sync(directory);}finally{fs.closeSync(lock);}}
}
export interface ApprovedArcCreation {
  account:LocalAccount;data:Hex;approvedDataHash:Hex;validUntil:bigint;journalRoot:string;rawSend:LocalRawSend;now?:()=>bigint;
  public:{getChainId():Promise<number>;getTransactionCount(args:{address:Address;blockTag:"pending"}):Promise<number>;getBlock(args:{blockTag:"latest"}):Promise<{timestamp:bigint}>};
}
/** One exact, separately approved contract creation. No replacement, simulation, or resend exists. */
export async function sendApprovedArcCreation(c:ApprovedArcCreation):Promise<Hex>{
  try{
    const account=getAddress(c.account.address),data=c.data,dataHash=keccak256(data),until=c.validUntil,now=c.now??(()=>BigInt(Math.floor(Date.now()/1000)));
    must(c.account.type==="local"&&dataHash===c.approvedDataHash&&data.length>2&&data.length<=98_306&&until>0n);
    const sign=c.account.signTransaction.bind(c.account),rawSend=c.rawSend,pub=c.public;
    const approval=keccak256(stringToHex(json({account,dataHash,until,gas,fee,chainId:5042002})));
    return await journal(c.journalRoot,account,approval,async(j,save,directory)=>{
      const prior=j.entries[0];
      if(prior){must(prior.hash&&prior.raw&&keccak256(prior.raw)===prior.hash&&["intent","confirmed"].includes(prior.stage));return prior.hash;}
      const deadline=async()=>{must(await pub.getChainId()===5042002&&now()<until&&(await pub.getBlock({blockTag:"latest"})).timestamp<until);};
      await deadline();const pending=await pub.getTransactionCount({address:account,blockTag:"pending"});must(Number.isSafeInteger(pending)&&pending>=0);
      const nonce=Math.max(pending,...siblingNonceReservations(directory,account,"deployment").map(n=>n+1));must(Number.isSafeInteger(nonce));
      const e:Journal["entries"][number]={nonce,stage:"reserved",dataHash,validUntil:String(until),gas:String(gas),fee:String(fee),maximum:String(gas*fee)};
      j.entries.push(e);save();
      const fields={type:"eip1559" as const,chainId:5042002,nonce,data,value:0n,gas,maxFeePerGas:fee,maxPriorityFeePerGas:fee};
      const raw=await sign(fields),p=parseTransaction(raw);
      must(p.type==="eip1559"&&p.chainId===5042002&&p.nonce===nonce&&!p.to&&(p.value??0n)===0n&&p.data===data&&p.gas===gas&&
        p.maxFeePerGas===fee&&p.maxPriorityFeePerGas===fee&&(!p.accessList||p.accessList.length===0)&&serializeTransaction(p)===raw&&
        isAddressEqual(await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized}),account));
      // Creation data contains no delivery key. Retain exact bytes privately for manual same-byte recovery.
      e.raw=raw;e.hash=keccak256(raw);e.stage="intent";save();await deadline();must(now()<until);
      must(await rawSend({method:"eth_sendRawTransaction",params:[raw]},{retryCount:0})===e.hash);return e.hash;
    });
  }catch{throw Error("Approved Arc creation stopped; reconcile the durable intent");}
}
/** Read-only chain reconciliation. The shared buyer lock protects the confirmation transition. */
export async function reconcileArcCreation(c:{account:Address;journalRoot:string;public:PublicClient;expectedRuntimeHash:Hex}){
  return journal(c.journalRoot,getAddress(c.account),undefined,async(j,save)=>{
    const e=j.entries[0];must(e?.hash&&["intent","confirmed"].includes(e.stage));const hash=e.hash,pub=c.public;
    must(await pub.getChainId()===5042002);
    const r=await pub.getTransactionReceipt({hash}),t=await pub.getTransaction({hash});
    const address=getContractAddress({from:j.account,nonce:BigInt(e.nonce)});
    must(r.status==="success"&&r.contractAddress&&isAddressEqual(r.contractAddress,address)&&r.to===null&&t.to===null&&t.value===0n&&
      isAddressEqual(r.from,j.account)&&isAddressEqual(t.from,j.account)&&t.chainId===5042002&&t.nonce===e.nonce&&keccak256(t.input)===e.dataHash&&
      t.gas===gas&&t.maxFeePerGas===fee&&t.maxPriorityFeePerGas===fee&&t.blockNumber===r.blockNumber&&t.blockHash===r.blockHash&&
      r.transactionHash===hash&&t.hash===hash&&r.gasUsed>0n&&r.gasUsed<=gas&&r.effectiveGasPrice>=20_000_000_000n&&r.effectiveGasPrice<=fee);
    must((await pub.getBlockNumber({cacheTime:0}))>=r.blockNumber+3n&&(await pub.getBlock({blockNumber:r.blockNumber})).hash===r.blockHash);
    const code=await pub.getCode({address,blockNumber:r.blockNumber});must(code&&keccak256(code)===c.expectedRuntimeHash);
    const before=await pub.getBalance({address:j.account,blockNumber:r.blockNumber-1n}),after=await pub.getBalance({address:j.account,blockNumber:r.blockNumber});
    const spent=r.gasUsed*r.effectiveGasPrice;must(before-after===spent&&(await pub.getBlock({blockNumber:r.blockNumber})).hash===r.blockHash);
    e.stage="confirmed";save();
    return {hash,address,blockNumber:r.blockNumber,blockHash:r.blockHash,gasUsed:r.gasUsed,effectiveGasPrice:r.effectiveGasPrice,spent,buyerBefore:before,buyerAfter:after,runtimeHash:c.expectedRuntimeHash};
  });
}
