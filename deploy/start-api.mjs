// The reviewed immutable image supplies its pins. Operator credentials remain in the original environment.
import {lstatSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const rejected=()=>{throw new Error('Image configuration rejected');};
function pin(root,name,pattern,digestOnly=false){
 try{
  const path=join(root,name),info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<1||info.size>512)rejected();
  const value=readFileSync(path,'utf8').trim();
  if(!pattern.test(value))rejected();
  return digestOnly?value.slice(0,64):value;
 }catch{rejected();}
}
/** Testable parser. The executable entry always uses /app/pins, never an environment-selected pin directory. */
export function imageEnvironment(root='/app/pins',environment=process.env){
 const digest=/^[0-9a-f]{64}(?:[ \t]+[^\r\n]+)?$/;
 const image=/^[a-z0-9._/:-]+@sha256:[0-9a-f]{64}$/;
 const values={
  SOURCE_SHA:pin(root,'source-sha',/^[0-9a-f]{40}$/),
  ENGINE_SHA256:pin(root,'engine.sha256',digest,true),
  COMPILER_WRAPPER_SHA256:pin(root,'compiler-wrapper.sha256',digest,true),
  DOCKERFILE_FRONTEND:pin(root,'dockerfile-frontend',image),
  GUEST_BUILDER_IMAGE:pin(root,'guest-builder-image',image),
  ENGINE_MODE:'native',ENGINE_PATH:'/usr/local/bin/ubc26-engine',
  COMPILER_WRAPPER_PATH:'/opt/ubc26/docker-bin/docker',
  COMPILER_READY_PATH:'/var/lib/ubc26/compiler-ready.json',
 };
 for(const[key,value]of Object.entries(values))if(environment[key]!==undefined&&environment[key]!==value)rejected();
 return values;
}
/** Check public configuration against image-owned manifests. No network or credential validation occurs. */
export function assertPublicDeployment(environment=process.env,root='/app/contracts/deployments'){
 if(environment.DEPLOYMENT_MODE!=='public')return;
 const reject=()=>{throw new Error('Image deployment configuration rejected');};
 try{
  const load=name=>{
   const file=join(root,name),info=lstatSync(file);
   if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<2||info.size>1_048_576)reject();
   return JSON.parse(readFileSync(file,'utf8'));
  };
  const address=value=>{if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))reject();return value.toLowerCase();};
  const selected=load('arc-testnet.json'),open=load('open-claim-arc-testnet.json');
  if(selected.schemaVersion!==1||selected.network!=='arc-testnet'||selected.status!=='frozen'||selected.chain.chainId!==5042002||
     open.schemaVersion!==1||open.interfaceVersion!=='open-claim-v1'||open.network!=='arc-testnet'||open.status!=='deployed-verified'||open.chainId!==5042002)reject();
  if(address(selected.contracts.core.address)!==address(open.core.address)||address(selected.usdc.address)!==address(open.usdc.address)||address(selected.contracts.verifier.address)!==address(open.verifier.address))reject();
  const pins={CHAIN_ID:'5042002',CHAIN_CORE:selected.contracts.core.address,CHAIN_HOOK:selected.contracts.hook.address,CHAIN_USDC:selected.usdc.address,
   OPEN_CLAIM_CHAIN_ID:'5042002',OPEN_CLAIM_CORE:open.core.address,OPEN_CLAIM_ADAPTER:open.adapter.address,OPEN_CLAIM_USDC:open.usdc.address,OPEN_CLAIM_VERIFIER:open.verifier.address};
  for(const[name,value]of Object.entries(pins)){
   if(name.endsWith('_ID')){if(environment[name]!==value)reject();}
   else if(address(environment[name])!==address(value))reject();
  }
  for(const name of ['CHAIN_RPC_URL','OPEN_CLAIM_RPC_URL']){
   if(typeof environment[name]!=='string'||environment[name].length>4096)reject();
   const url=new URL(environment[name]);
   if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)reject();
  }
  const confirmations=environment.OPEN_CLAIM_CONFIRMATIONS??'3';
  if(!/^[0-9]{1,6}$/.test(confirmations)||Number(confirmations)<3)reject();
 }catch{reject();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 Object.assign(process.env,imageEnvironment());
 assertPublicDeployment();
 await import('../commerce/api/src/server.mjs');
}
