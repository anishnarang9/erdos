// This check makes no external requests. It uses synthetic accounts and a controlled model.
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.ts';
import {privateKeyToAccount} from 'viem/accounts';
import {runBenchmark} from '../../../engine/evaluation/hosted-qualification/trials.mjs';
async function main() {
 const source=process.argv[2]??'working-tree';
 if(source!=='working-tree'&&!/^[a-f0-9]{40}$/.test(source))throw new Error('Source must be a full commit SHA');
 const directory = await mkdtemp(join(tmpdir(),'ubc26-campaign-api-'));
 let now=Date.now(), modelCalls=0, taskPosts=0, taskReads=0, authReads=0;
 const made=createApp({dbPath:join(directory,'api.db'),buyerToken:'controlled-local-token-12345',now:()=>now,
  deployment:{mode:'local',serviceOrigin:'https://fixture.example.test'},
  budget:{requestCeilingMicroUsd:1000,dailyCeilingMicroUsd:1000000,inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1},
  draftModel:{id:'controlled-fixture',outputTokenBound:{parameter:'max_completion_tokens',maxTokens:8192},
   providerCostBound:{maxPromptTokens:1000000,inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1},
   async draft(){modelCalls++;return{model:'controlled-fixture',traceId:`controlled-call-${modelCalls}`,result:{kind:'clarification',questions:['Which fee table?']},usage:{promptTokens:10,completionTokens:10,cachedTokens:0,reasoningTokens:0,costInUsdTicks:10001}};}}});
 const issue=async(index)=>{
  const account=privateKeyToAccount(('0x'+index.toString(16).padStart(64,'0')));
  const challenge=await made.app.request('/v1/auth/challenge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:account.address})});
  assert.equal(challenge.status,200);
  const body=await challenge.json();
  const response=await made.app.request('/v1/auth/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challengeId:body.challengeId,signature:await account.signMessage({message:body.message})})});
  assert.equal(response.status,200);return ((await response.json())).key;
 };
 try {
  const keys=[await issue(101),await issue(102),await issue(103)];
  const fetchImpl=async(url,init)=>{
   if(String(url).endsWith('/v1/auth/keys/current'))authReads++;
   else if(init.method==='POST')taskPosts++;else taskReads++;
   const response=await made.app.request(url,init);
   if(init.method==='POST'&&String(url).endsWith('/v1/tasks'))await made.pumpTasks();
   return response;
  };
  const config={dispatch:true,live:false,baseUrl:'https://fixture.example.test',apiKeys:keys,scope:'benchmark',capMicroUsd:1000000,attemptPriceMicroUsd:1000,corpusId:'controlled-api-campaign',maxPolls:3,pollIntervalMs:0,minPostIntervalMs:0,now:()=>now};
  const challenges=[{id:'controlled-ambiguous',classification:'ambiguous',prompt:'Which fee table applies to this bill?',outputs:[{name:'bill.json',format:'json'}],referenceFiles:{}}];
  const ledgerPath=join(directory,'ledger.json');
  const first=await runBenchmark({challenges,config,ledgerPath,fetchImpl});
  assert.equal(first.freshTrials,3,JSON.stringify({reason:first.reason,trials:first.trials}));assert.equal(modelCalls,3);assert.equal(taskPosts,3);
  const resumed=await runBenchmark({challenges,config,ledgerPath,fetchImpl});
  assert.equal(resumed.freshTrials,3);assert.equal(resumed.paidTrialsRan,false);assert.equal(modelCalls,3);assert.equal(taskPosts,3);
  now+=10000;
  const stale=await runBenchmark({challenges,config:{...config,corpusId:'controlled-api-new-ledger'},ledgerPath:join(directory,'stale.json'),fetchImpl});
  assert.equal(stale.reason,'stale-task');assert.equal(stale.freshTrials,0);assert.equal(modelCalls,3);assert.equal(taskPosts,4);
  const aliases=[keys[0],await issue(101),await issue(101)];
  const before=taskPosts;
  const duplicated=await runBenchmark({challenges,config:{...config,apiKeys:aliases},ledgerPath:join(directory,'duplicate-wallet.json'),fetchImpl});
  assert.equal(duplicated.reason,'duplicate-wallet-principals');assert.equal(taskPosts,before);assert.equal(modelCalls,3);
  const report={version:1,status:'passed-controlled-api-integration',source,platform:process.platform,node:process.version,
   genuineModelCalls:0,controlledModelCalls:modelCalls,externalRequests:0,compilerCalls:0,proofs:0,chainTransactions:0,
   firstCampaign:{freshControlledTrials:first.freshTrials,taskPosts:3,distinctWallets:3},resume:{freshOriginalTrials:resumed.freshTrials,additionalTaskPosts:0,additionalControlledModelCalls:0},
   newLedger:{reason:stale.reason,additionalControlledModelCalls:0},duplicateWalletKeys:{reason:duplicated.reason,additionalTaskPosts:0},
   total:{taskPosts,taskReads,authReads},qualificationPassed:false,
   limits:['In-process Hono and SQLite with synthetic wallet accounts and a controlled model. No public host or genuine application inference was tested.','The harness paidTrialsRan flag means a task POST was attempted. It does not establish a provider charge.']};
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
 } finally {await made.drainTasks();made.close();await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
