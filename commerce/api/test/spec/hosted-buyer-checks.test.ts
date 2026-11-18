import {afterEach,expect,it} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {privateKeyToAccount} from 'viem/accounts';
import {hostedClient} from '@ubc26/sdk';
import {createApp,simulatedEngine} from '../../src/index.ts';
const apps:ReturnType<typeof createApp>[]=[];afterEach(()=>{for(const app of apps.splice(0))app.close();});
const origin='https://api.example.test',context='0x01'+'a'.repeat(336);
const examples=[{name:'pass',predictedVerdict:1,files:[{name:'result.json',content:'{"ok":true}'}],evidence:[{name:'signed.json',content:'{"signature":"controlled"}'}],context},{name:'fail',predictedVerdict:0,files:[{name:'result.json',content:'{"ok":false}'}],evidence:[{name:'signed.json',content:'{"signature":"controlled"}'}],context}];
async function fixture(){
 let evaluations=0,modelCalls=0;const dbPath=join(mkdtempSync(join(tmpdir(),'hosted-buyer-checks-')),'api.sqlite'),plan={version:1,deliverables:[{name:'result.json',parser:'json/v1'}],references:[],rules:[{op:'literal',type:'bool',value:true}]},input={request:'Check that ok is true',outputs:[{name:'result.json',format:'json'}],expirySeconds:600,maxBudget:'10000'};
 const app=createApp({dbPath,buyerToken:'controlled-buyer',deployment:{mode:'public',serviceOrigin:origin},engine:{...simulatedEngine(),mode:'real',eval:async input=>{evaluations++;if(input.context!==context||!input.evidence?.length)return{ok:false,kind:'invalid',errors:[{path:'/evidence',message:'Invalid signed context'}]};return{ok:true,verdict:Buffer.from(input.deliverables[0]!.content).toString().includes('true')?1:0};}},budget:{requestCeilingMicroUsd:500000,dailyCeilingMicroUsd:5000000,inputMicroUsdPerMillion:1000000,outputMicroUsdPerMillion:1000000},draftModel:{outputTokenBound:{parameter:'max_tokens',maxTokens:8192},draft:async()=>({model:'controlled',traceId:`buyer-check-${++modelCalls}`,usage:{promptTokens:1,completionTokens:1,cachedTokens:0,reasoningTokens:0,costInUsdTicks:1},result:{kind:'draft',plan,examples:examples.map(({evidence,context,...rest})=>rest) as any,sourceQuotes:[{path:'/request',quote:input.request}],coverage:{requirements:[{id:'ok',text:input.request,ruleIndices:[0],quoteIndices:[0]}],assumptions:[],unresolved:[]}}})}});apps.push(app);
 const transport=((url:string|URL|Request,init?:RequestInit)=>app.app.request(String(url),init)) as typeof fetch;
 const login=async(byte:string)=>{const account=privateKeyToAccount(`0x${byte.repeat(32)}`),anon=hostedClient({baseUrl:origin,fetch:transport}),key=await anon.authenticate(account.address,message=>account.signMessage({message}),`login-${byte}`);return{key:key.key,client:hostedClient({baseUrl:origin,apiKey:key.key,fetch:transport})};};
 const owner=await login('ad'),other=await login('ae'),task=await owner.client.draft(input,'buyer-check-draft');await app.pumpTasks();const done:any=await owner.client.task(task.id);expect(done.state).toBe('succeeded');expect(done.result.exampleApprovalReady).toBe(false);
 const result=done.result,job:any=await owner.client.createJob({source:'grok',draftId:result.draftId,revision:result.revision},'buyer-check-job');
 const post=(body:unknown,key=owner.key,replay=crypto.randomUUID(),hash=result.revisionHash)=>app.app.request(`/v1/drafts/${result.draftId}/example-checks`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','idempotency-key':replay,'if-match':`"${hash}"`},body:JSON.stringify(body)});
 return{app,dbPath,owner,other,result,task,job,post,evaluations:()=>evaluations,modelCalls:()=>modelCalls,body:{draftId:result.draftId,revisionHash:result.revisionHash,examples}};
}
it('appends exact buyer witnesses, retains failures and leaves the original task unchanged',async()=>{
 const f=await fixture(),calls=f.modelCalls(),before=f.evaluations();
 const failed=await f.post({...f.body,examples:examples.map(e=>({...e,context:'0x01'+'b'.repeat(336)}))});expect(failed.status,await failed.clone().text()).toBe(201);const bad:any=await failed.json();expect(bad.exampleApprovalReady).toBe(false);
 const key=crypto.randomUUID(),checked=await f.post(f.body,f.owner.key,key);expect(checked.status,await checked.clone().text()).toBe(201);const check:any=await checked.json();expect(check).toMatchObject({draftId:f.result.draftId,revisionHash:f.result.revisionHash,exampleApprovalReady:true,usablePositiveExamples:1,usableNegativeExamples:1});expect(check.exampleCheckId).toBeTruthy();
 const replay=await f.post(f.body,f.owner.key,key);expect(await replay.json()).toEqual(check);expect(f.evaluations()).toBe(before+4);expect(f.modelCalls()).toBe(calls);expect((await f.owner.client.task(f.task.id)).result).toEqual(f.result);
 const approval={revisionHash:f.result.revisionHash,referenceDigest:f.result.revision.referenceDigest,coverageDigest:f.result.coverage.coverageDigest};
 await expect(f.owner.client.approve(f.job.jobId,{...approval,exampleCheckId:bad.exampleCheckId} as any,'bad-check')).rejects.toMatchObject({status:409,code:'approval_required'});
 const approved:any=await f.owner.client.approve(f.job.jobId,{...approval,exampleCheckId:check.exampleCheckId} as any,'good-check');expect(approved.approval).toMatchObject({exampleCheckId:check.exampleCheckId,coverageDigest:approval.coverageDigest});
 const raw=new DatabaseSync(f.dbPath);try{expect((raw.prepare('SELECT COUNT(*) AS n FROM example_checks WHERE draft_id = ?').get(f.result.draftId) as any).n).toBe(3);expect(()=>raw.prepare('UPDATE example_checks SET result_json = ? WHERE id = ?').run('{}',bad.exampleCheckId)).toThrow();}finally{raw.close();}
});
it('rejects foreign ownership, changed revision and attempts to replace the plan before evaluation',async()=>{
 const f=await fixture(),before=f.evaluations();expect((await f.post(f.body,f.other.key)).status).toBe(404);expect((await f.post({...f.body,revisionHash:'0'.repeat(64)})).status).toBe(409);expect((await f.post({...f.body,plan:{rules:[]}})).status).toBe(400);expect(f.evaluations()).toBe(before);
});
