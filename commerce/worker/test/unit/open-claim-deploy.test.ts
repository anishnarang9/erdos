import {expect,it,vi} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync} from "node:fs";
import {join} from "node:path";
import {createPublicClient,encodeDeployData,keccak256} from "viem";
import {deployApprovedOpenClaim} from "../../src/open-claim/deploy.ts";
vi.mock("viem",async original=>({...await original<typeof import("viem")>(),createPublicClient:vi.fn(()=>{throw Error("RPC boundary reached");})}));

it("rejects a different artifact even when an unsigned preview matches that artifact",async()=>{
  const root=realpathSync(mkdtempSync(join(process.cwd(),".deploy-approval-")));
  const buyer="0x638202cCB15315dBc5b22e02717B908bEAc3AeBd",args=["0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8","0xCf8D70A203b40D3A17d023c0CDDF752870BC3992","0x3600000000000000000000000000000000000000"];
  const abi=[{type:"constructor",inputs:[{type:"address"},{type:"address"},{type:"address"}],stateMutability:"nonpayable"}] as const;
  const bytecode="0x6000",data=encodeDeployData({abi,bytecode,args:args as any});
  const a={status:"user-approved-awaiting-deployment",userAnswer:"Approve exact deployment and 0.201 cap (Recommended)",chainId:5042002,deployer:buyer,
    maximumGas:"3072197",maxFeePerGasWei:"25000000000",maxPriorityFeePerGasWei:"25000000000",aggregateSuiteGasCapUsdc:"0.201",constructorArgs:args};
  const p={chainId:5042002,deployment:{...a,creationDataKeccak256:keccak256(data)}};
  try{
    const out=join(root,"contracts/out/OpenClaimAdapter.sol");mkdirSync(out,{recursive:true,mode:0o700});
    writeFileSync(join(out,"OpenClaimAdapter.json"),JSON.stringify({abi,bytecode:{object:bytecode}}),{mode:0o600});
    for(const [name,value] of [["approval",a],["preview",p]] as const)writeFileSync(join(root,name+".json"),JSON.stringify(value),{mode:0o600});
    const c={signingAuthorized:true,rpcUrl:"https://rpc.testnet.arc.io",directory:root,journalRoot:root,buyer:{address:buyer},
      deployment:{authorized:true,previewFile:join(root,"preview.json"),authorizationFile:join(root,"approval.json")}};
    await expect(deployApprovedOpenClaim(c,3,root)).rejects.toThrow();
    expect(createPublicClient).not.toHaveBeenCalled();
  }finally{rmSync(root,{recursive:true,force:true});}
});
