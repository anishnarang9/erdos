import {afterEach,expect,it} from "vitest";
import {createApp,simulatedEngine,type CreateAppOptions} from "../../src/index.ts";
const token="synthetic-example-approval-token",apps:ReturnType<typeof createApp>[]=[];
afterEach(()=>{for(const a of apps.splice(0))a.close();});
const input={request:"Accept result only when ok is true",outputs:[{name:"result.json",format:"json"}],expirySeconds:600,maxBudget:"10000"};
const plan={version:1,deliverables:[{name:"result.json",parser:"json/v1"}],references:[],rules:[{op:"literal",type:"bool",value:true}]};
const usage={promptTokens:10,completionTokens:10,cachedTokens:0,reasoningTokens:0,costInUsdTicks:10000};
const examples=[{name:"pass",predictedVerdict:1,files:[{name:"result.json",content:'{"ok":true}'}]},{name:"fail",predictedVerdict:0,files:[{name:"result.json",content:'{"ok":false}'}]}];
function service(model:unknown,engine:CreateAppOptions["engine"]){const a=createApp({dbPath:":memory:",buyerToken:token,engine,draftModel:model as CreateAppOptions["draftModel"]});apps.push(a);return a;}
async function draft(a:ReturnType<typeof service>){const res=await a.app.request('/v1/drafts',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(input)});expect(res.status,await res.clone().text()).toBe(200);return res.json() as Promise<any>;}
it("repairs actual example disagreement once and keeps an unresolved draft unapprovable",async()=>{
 let calls=0;const a=service({draft:async()=>({model:"controlled",traceId:`trace-${++calls}`,usage,result:{kind:"draft",plan,examples,sourceQuotes:[{path:"/request",quote:input.request}]}})}, {...simulatedEngine(),eval:async()=>({ok:true,verdict:1})});
 const result=await draft(a);expect(calls).toBe(2);expect(result.exampleApprovalReady).toBe(false);
 expect(result.coverage.usablePositiveExamples).toBe(1);expect(result.coverage.usableNegativeExamples).toBe(0);expect(result.qualification.repairCount).toBe(1);
});
it("keeps missing evaluator and malformed negative examples outside usable counts",async()=>{
 const a=service({draft:async()=>({model:"controlled",traceId:"trace-none",result:{kind:"draft",plan,examples,sourceQuotes:[]}})},simulatedEngine());
 const result=await draft(a);expect(result.exampleApprovalReady).toBe(false);expect(result.coverage.usablePositiveExamples).toBe(0);expect(result.coverage.usableNegativeExamples).toBe(0);
});
it.each(["clarification","unsupported"])("records model identity and usage on a %s terminal",async(kind)=>{
 const a=service({draft:async()=>({model:"controlled",traceId:`trace-${kind}`,usage,result:kind==='clarification'?{kind,questions:["Which policy?"]}:{kind,reason:"network truth requires an external verifier"}})},simulatedEngine());
 const result=await draft(a);expect(result.qualification).toMatchObject({model:"controlled",repairCount:0,traceId:`trace-${kind}`,traceIds:[`trace-${kind}`],usage:[usage]});
 expect(result.qualification.promptVersion).toMatch(/^[0-9a-f]{64}$/);expect(result.qualification.catalogVersion).toMatch(/^[0-9a-f]{64}$/);
});
it("blocks public approval of an authored revision with unusable examples",async()=>{
 const {privateKeyToAccount}=await import('viem/accounts');const {hostedClient}=await import('@ubc26/sdk');
 const engine={...simulatedEngine(),mode:'real' as const,eval:async()=>({ok:true as const,verdict:1 as const})};
 let calls=0;const a=createApp({dbPath:':memory:',buyerToken:token,engine,deployment:{mode:'public',serviceOrigin:'https://api.example.test'},budget:{requestCeilingMicroUsd:500000,dailyCeilingMicroUsd:5000000,inputMicroUsdPerMillion:1000000,outputMicroUsdPerMillion:1000000},draftModel:{outputTokenBound:{parameter:'max_tokens',maxTokens:8192},draft:async()=>({model:'controlled',traceId:`public-${++calls}`,usage,result:{kind:'draft',plan,examples:examples as any,sourceQuotes:[{path:'/request',quote:input.request}]}})}});apps.push(a);
 const transport=((url:string|URL|Request,init?:RequestInit)=>a.app.request(String(url),init)) as typeof fetch;
 const account=privateKeyToAccount(`0x${'ab'.repeat(32)}`),anon=hostedClient({baseUrl:'https://api.example.test',fetch:transport});const key=await anon.authenticate(account.address,message=>account.signMessage({message}),'approval-login');
 const client=hostedClient({baseUrl:'https://api.example.test',apiKey:key.key,fetch:transport}),task=await client.draft(input,'approval-draft');await a.pumpTasks();const done:any=await client.task(task.id);expect(done.state).toBe('succeeded');
 const result=done.result;const job:any=await client.createJob({source:'grok',draftId:result.draftId,revision:result.revision},'approval-job');
 await expect(client.approve(job.jobId,{revisionHash:result.revisionHash,referenceDigest:result.revision.referenceDigest},'approval-submit')).rejects.toMatchObject({status:409,code:'approval_required'});
});
