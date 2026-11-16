import {readFileSync} from "node:fs";
import {join} from "node:path";
import {createPublicClient,encodeDeployData,http,keccak256,parseAbi} from "viem";
import {arcCoreAbi} from "@ubc26/sdk";
import {IMPLEMENTATION_SLOT} from "../arc-deployment.ts";
import {sendApprovedArcCreation,reconcileArcCreation} from "../arc-creation.ts";
import {loadOperatorKeystore} from "../operator-keystore.ts";
import {readOperatorJson,privateDirectory,requireSprint as must,sprintAddress,sprintHash} from "../sprint-authorization.ts";

// Bind this run's human approval independently of local artifacts and unsigned previews.
const approvedInitcodeHash="0xad7f68985c4978a117d467a8e89321f0b6d4b539492cd34beb1280f104b321d6";

/** Execute the separately approved creation preview. The caller checks its clean source before entry. */
export async function deployApprovedOpenClaim(c:any,passwordFd:number,repo:string){
  must(c.signingAuthorized===true&&c.deployment?.authorized===true&&c.rpcUrl==="https://rpc.testnet.arc.io");
  privateDirectory(c.directory);privateDirectory(c.journalRoot);
  const p=readOperatorJson(c.deployment.previewFile) as any,a=readOperatorJson(c.deployment.authorizationFile) as any;
  const buyer=sprintAddress(c.buyer.address),d=p.deployment;
  must(a.status==="user-approved-awaiting-deployment"&&a.userAnswer==="Approve exact deployment and 0.201 cap (Recommended)"&&
    a.chainId===5042002&&p.chainId===5042002&&sprintAddress(a.deployer)===buyer&&sprintAddress(d.deployer)===buyer&&
    a.maximumGas==="3072197"&&d.maximumGas==="3072197"&&a.maxFeePerGasWei==="25000000000"&&d.maxFeePerGasWei==="25000000000"&&
    a.maxPriorityFeePerGasWei==="25000000000"&&d.maxPriorityFeePerGasWei==="25000000000"&&a.aggregateSuiteGasCapUsdc==="0.201");
  const core=sprintAddress(a.constructorArgs[0]),verifier=sprintAddress(a.constructorArgs[1]),usdc=sprintAddress(a.constructorArgs[2]);
  must(usdc==="0x3600000000000000000000000000000000000000"&&a.constructorArgs.length===3);
  const artifact=JSON.parse(readFileSync(join(repo,"contracts/out/OpenClaimAdapter.sol/OpenClaimAdapter.json"),"utf8"));
  const data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[core,verifier,usdc]});
  must(sprintHash(d.creationDataKeccak256)===approvedInitcodeHash&&keccak256(data)===approvedInitcodeHash);
  const pub=createPublicClient({cacheTime:0,transport:http(c.rpcUrl,{retryCount:2,retryDelay:1000})}),raw=createPublicClient({transport:http(c.rpcUrl,{retryCount:0})});
  must(await pub.getChainId()===5042002);
  const head=await pub.getBlockNumber({cacheTime:0}),blockNumber=head-3n,block=await pub.getBlock({blockNumber});
  must(block.hash&&(await pub.getBlock({blockNumber:BigInt(p.fixedBlock.number)})).hash===p.fixedBlock.hash&&
    (await pub.getBlock({blockNumber:BigInt(p.priorFullAudit.block)})).hash===p.priorFullAudit.hash);
  for(const [address,expected] of [[core,p.fixedBlockChecks.coreProxyRuntimeCodeHash],
    [sprintAddress(p.fixedBlockChecks.coreImplementation),p.fixedBlockChecks.coreImplementationRuntimeCodeHash],[verifier,p.fixedBlockChecks.verifierRuntimeCodeHash]] as const){
    const code=await pub.getCode({address,blockNumber});must(code&&keccak256(code)===expected);
  }
  const slot=await pub.getStorageAt({address:core,slot:IMPLEMENTATION_SLOT,blockNumber});
  must(slot&&slot.slice(-40).toLowerCase()===p.fixedBlockChecks.coreImplementation.slice(2).toLowerCase());
  for(const f of ["platformFeeBP","evaluatorFeeBP"] as const)must(await pub.readContract({address:core,abi:arcCoreAbi,functionName:f,blockNumber})===0n);
  must(await pub.readContract({address:core,abi:arcCoreAbi,functionName:"paymentToken",blockNumber})===usdc);
  const events=parseAbi(["event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)","event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)",
    "event HookWhitelistUpdated(address indexed hook,bool status)","event RoleAdminChanged(bytes32 indexed role,bytes32 indexed previousAdminRole,bytes32 indexed newAdminRole)","event Upgraded(address indexed implementation)","event Initialized(uint64 version)"]);
  for(let from=BigInt(p.priorFullAudit.block)+1n;from<=blockNumber;from+=10000n){
    await new Promise(r=>setTimeout(r,2000));
    must((await pub.getLogs({address:core,events,fromBlock:from,toBlock:from+9999n<blockNumber?from+9999n:blockNumber})).length===0);
  }
  const call={account:buyer,data,value:0n,maxFeePerGas:25_000_000_000n,maxPriorityFeePerGas:25_000_000_000n};
  const result=await pub.call({...call,gas:3_072_197n,blockNumber});
  const runtime=sprintHash(d.simulatedRuntimeCodeHash);must(result.data&&keccak256(result.data)===runtime&&await pub.estimateGas(call)<=3_072_197n);
  must((await pub.getBlock({blockNumber})).hash===block.hash);
  const loaded=await loadOperatorKeystore({mode:"signing",keystorePath:c.buyer.keystorePath,expectedAddress:buyer,passwordSource:{kind:"fd",fd:passwordFd}});must(loaded.mode==="signing");
  const hash=await sendApprovedArcCreation({account:loaded.account,data,approvedDataHash:d.creationDataKeccak256,validUntil:BigInt(c.deployment.validUntil),journalRoot:c.journalRoot,public:pub,
    rawSend:(request,options)=>raw.request({method:request.method,params:[request.params[0]]},options)});
  try{return {phase:"deployment_confirmed",...await reconcileArcCreation({account:buyer,journalRoot:c.journalRoot,public:pub,expectedRuntimeHash:runtime})};}
  catch{return {phase:"deployment_sent",hash};}
}
