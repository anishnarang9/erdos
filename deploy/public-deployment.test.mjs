import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertPublicDeployment} from './start-api.mjs';
const manifestRoot=new URL('../contracts/deployments/',import.meta.url);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'ubc26-deployment-pins-'));
 for(const name of ['arc-testnet.json','open-claim-arc-testnet.json'])await copyFile(new URL(name,manifestRoot),join(root,name));
 const a=JSON.parse(await readFile(join(root,'arc-testnet.json'),'utf8')),o=JSON.parse(await readFile(join(root,'open-claim-arc-testnet.json'),'utf8'));
 return{root,env:{DEPLOYMENT_MODE:'public',CHAIN_RPC_URL:'https://rpc.example.test',CHAIN_ID:String(a.chain.chainId),CHAIN_CORE:a.contracts.core.address,CHAIN_HOOK:a.contracts.hook.address,CHAIN_USDC:a.usdc.address,OPEN_CLAIM_RPC_URL:'https://rpc.example.test',OPEN_CLAIM_CHAIN_ID:String(o.chainId),OPEN_CLAIM_CORE:o.core.address,OPEN_CLAIM_ADAPTER:o.adapter.address,OPEN_CLAIM_USDC:o.usdc.address,OPEN_CLAIM_VERIFIER:o.verifier.address}};
}
test('requires both deployed contract configurations before public API import',async()=>{
 const{root,env}=await fixture();try{
  assert.equal(assertPublicDeployment(env,root),undefined);
  for(const name of Object.keys(env).filter(name=>name!=='DEPLOYMENT_MODE')){const missing={...env};delete missing[name];assert.throws(()=>assertPublicDeployment(missing,root),/Image deployment configuration rejected/);}
  assert.equal(assertPublicDeployment({DEPLOYMENT_MODE:'local'},'/absent'),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rejects wrong deployment pins, unsafe RPC URLs and unconfirmed reads without secret details',async()=>{
 const{root,env}=await fixture();try{
  for(const override of [{CHAIN_ID:'1'},{OPEN_CLAIM_CHAIN_ID:'1'},...['CHAIN_CORE','CHAIN_HOOK','CHAIN_USDC','OPEN_CLAIM_CORE','OPEN_CLAIM_ADAPTER','OPEN_CLAIM_USDC','OPEN_CLAIM_VERIFIER'].map(name=>({[name]:'0x'+'11'.repeat(20)})),{OPEN_CLAIM_RPC_URL:'http://fixture-secret.invalid'},{CHAIN_RPC_URL:'https://fixture-secret:password@example.test'},{OPEN_CLAIM_CONFIRMATIONS:'0'},{OPEN_CLAIM_CONFIRMATIONS:'2'},{OPEN_CLAIM_CONFIRMATIONS:'-3'}]){
   assert.throws(()=>assertPublicDeployment({...env,...override},root),error=>error.message==='Image deployment configuration rejected');
  }
  assert.equal(assertPublicDeployment({...env,OPEN_CLAIM_CONFIRMATIONS:'3'},root),undefined);
  assert.equal(assertPublicDeployment({...env,OPEN_CLAIM_ADAPTER:env.OPEN_CLAIM_ADAPTER.toLowerCase()},root),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rejects linked, oversized and inconsistent image manifests',async()=>{
 const{root,env}=await fixture();try{
  const file=join(root,'open-claim-arc-testnet.json'),original=await readFile(file,'utf8'),value=JSON.parse(original);
  value.core.address='0x'+'11'.repeat(20);await writeFile(file,JSON.stringify(value));assert.throws(()=>assertPublicDeployment({...env,OPEN_CLAIM_CORE:value.core.address},root));
  await writeFile(file,'x'.repeat(1_048_577));assert.throws(()=>assertPublicDeployment(env,root));
  await writeFile(join(root,'actual.json'),original);await rm(file);await symlink(join(root,'actual.json'),file);assert.throws(()=>assertPublicDeployment(env,root));
 }finally{await rm(root,{recursive:true,force:true});}
});
