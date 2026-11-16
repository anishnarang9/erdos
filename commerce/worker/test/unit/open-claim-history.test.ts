import { expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash } from "viem";
import { createArcOpenClaimPort } from "../../src/open-claim/arc-port.ts";

function fixture(roleLogIntervalMs=0){
  const core="0x1111111111111111111111111111111111111111",adapter="0x2222222222222222222222222222222222222222",
    verifier="0x3333333333333333333333333333333333333333",implementation="0x4444444444444444444444444444444444444444",
    usdc="0x3600000000000000000000000000000000000000",admin="0x5555555555555555555555555555555555555555";
  const abi=parseAbi(["event Upgraded(address indexed implementation)","event Initialized(uint64 version)",
    "event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
    "event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)"]);
  const role=keccak256(stringToHex("ADMIN_ROLE"));
  const logs=[{eventName:"Upgraded",args:{implementation},data:"0x"},
    ...[zeroHash,role].map(role=>({eventName:"RoleGranted",args:{role,account:admin,sender:admin},data:"0x"})),
    {eventName:"Initialized",args:{},data:encodeAbiParameters([{type:"uint64"}],[1n])},
    ...[role,zeroHash].map(role=>({eventName:"RoleRevoked",args:{role,account:admin,sender:admin},data:"0x"}))]
    .map((e,i)=>({address:core,blockNumber:2n,logIndex:i,data:e.data,topics:encodeEventTopics({abi,...e} as any)}));
  const state={head:20010n,reorg:false,grant:false};
  const hash=(n:bigint)=>keccak256(stringToHex(String(n)));
  const pub={getChainId:async()=>5042002,getBlockNumber:async()=>state.head,
    getBlock:async({blockNumber}:any)=>({number:blockNumber,hash:hash(blockNumber+(state.reorg&&blockNumber===20007n?1n:0n)),timestamp:100n}),
    getCode:async({blockNumber}:any)=>blockNumber<2n?"0x":"0x6000",getBytecode:async()=>"0x6000",
    getStorageAt:async()=>`0x${"0".repeat(24)}${implementation.slice(2)}`,
    readContract:async({functionName:f}:any)=>({VERSION:"3.1.0",SELECTOR:"0xe71e6620",core,verifier,usdc,paymentToken:usdc,
      evaluatorFeeBP:0n,platformFeeBP:0n,MAX_ENVELOPE_BYTES:16412n,MIN_EXPIRY_MARGIN:600n,hasRole:false}[f as string]),
    getLogs:vi.fn(async({fromBlock,toBlock}:any)=>[...logs,...state.grant?[{...logs[1]!,blockNumber:20008n}]:[]]
      .filter(x=>x.blockNumber>=fromBlock&&x.blockNumber<=toBlock))};
  const witness={mode:"open-claim",evidence:"operator-pins",chainId:5042002,core,adapter,verifier,implementation,usdc,
    verifierVersion:"3.1.0",verifierSelector:"0xe71e6620",hook:zeroAddress,platformFeeBP:0n,evaluatorFeeBP:0n,frozen:true,
    runtimeHashes:{core:keccak256("0x6000"),implementation:keccak256("0x6000"),adapter:keccak256("0x6000"),verifier:keccak256("0x6000")}} as const;
  const port=createArcOpenClaimPort({publicClient:pub as any,witness,coreDeploymentBlock:2n,adapterDeploymentBlock:3n,roleLogIntervalMs,
    signer:{account:admin,chainId:5042002,noKeyRpcSimulation:true},send:async()=>{throw Error("read only");}});
  return {state,pub,port};
}
it("rechecks the canonical audit anchor and scans only new role history",async()=>{
  const f=fixture();await f.port.verifyPins();expect(f.pub.getLogs).toHaveBeenCalledTimes(3);
  await f.port.verifyPins();expect(f.pub.getLogs).toHaveBeenCalledTimes(3);
  f.state.head++;await f.port.verifyPins();expect(f.pub.getLogs.mock.calls.at(-1)?.[0]).toMatchObject({fromBlock:20008n,toBlock:20008n});
});
it("paces every log window on a live RPC",async()=>{
  vi.useFakeTimers();
  try {
    const f=fixture(2000),pending=f.port.verifyPins();
    await vi.advanceTimersByTimeAsync(1999);expect(f.pub.getLogs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(f.pub.getLogs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);await pending;expect(f.pub.getLogs).toHaveBeenCalledTimes(3);
  } finally {vi.useRealTimers();}
});
it("rejects an audit-anchor reorg and newly granted authority",async()=>{
  const a=fixture();await a.port.verifyPins();a.state.reorg=true;await expect(a.port.verifyPins()).rejects.toThrow();
  const b=fixture();await b.port.verifyPins();b.state.head++;b.state.grant=true;await expect(b.port.verifyPins()).rejects.toThrow();
});
