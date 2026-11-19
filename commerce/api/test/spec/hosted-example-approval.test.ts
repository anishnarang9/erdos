import {afterEach,expect,it} from "vitest";
import {createApp,simulatedEngine,type CreateAppOptions,type Revision} from "../../src/index.ts";
import {hostedClient} from "@ubc26/sdk";
import {privateKeyToAccount} from "viem/accounts";
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
it("requires the exact buyer-reviewed coverage digest before public approval",async()=>{
 const {privateKeyToAccount}=await import('viem/accounts');const {hostedClient}=await import('@ubc26/sdk');
 const a=createApp({dbPath:':memory:',buyerToken:token,engine:{...simulatedEngine(),mode:'real',eval:async({deliverables})=>({ok:true,verdict:Buffer.from(deliverables[0]!.content).toString().includes('true')?1:0})},deployment:{mode:'public',serviceOrigin:'https://api.example.test'},budget:{requestCeilingMicroUsd:500000,dailyCeilingMicroUsd:5000000,inputMicroUsdPerMillion:1000000,outputMicroUsdPerMillion:1000000},draftModel:{outputTokenBound:{parameter:'max_tokens',maxTokens:8192},draft:async()=>({model:'controlled',traceId:'reviewed-coverage',usage,result:{kind:'draft',plan,examples:examples as any,sourceQuotes:[{path:'/request',quote:input.request}],coverage:{requirements:[{id:'ok',text:input.request,ruleIndices:[0],quoteIndices:[0]}],assumptions:[],unresolved:[]}}})}});apps.push(a);
 const transport=((url:string|URL|Request,init?:RequestInit)=>a.app.request(String(url),init)) as typeof fetch,account=privateKeyToAccount(`0x${'ac'.repeat(32)}`),anon=hostedClient({baseUrl:'https://api.example.test',fetch:transport});const key=await anon.authenticate(account.address,message=>account.signMessage({message}),'review-login');
 const client=hostedClient({baseUrl:'https://api.example.test',apiKey:key.key,fetch:transport}),task=await client.draft(input,'review-draft');await a.pumpTasks();const done:any=await client.task(task.id),result=done.result;expect(done.state).toBe('succeeded');expect(result.coverage.ruleCoverageComplete).toBe(true);
 const job:any=await client.createJob({source:'grok',draftId:result.draftId,revision:result.revision},'review-job'),body={revisionHash:result.revisionHash,referenceDigest:result.revision.referenceDigest};
 for(const review of [undefined,'0'.repeat(64)])await expect(client.approve(job.jobId,{...body,...(review?{coverageDigest:review}:{})},`review-bad-${review??'missing'}`)).rejects.toMatchObject({status:409,code:'approval_required'});
 expect(await client.approve(job.jobId,{...body,coverageDigest:result.coverage.coverageDigest},'review-good')).toMatchObject({state:'approved'});
});

it.each([
  ["/clarifications/0/answer", "The capacity is 40 units.", true],
  ["/clarifications/0/answer", "What capacity should I use?", false],
  ["/clarifications/0/question", "What capacity should I use?", false],
  ["/clarifications/0/answer", "The capacity is 90 units.", false],
  ["/clarifications/2/answer", "The capacity is 40 units.", false],
] as const)("checks clarification quote %s (%s) before approval", async (path, quote, found) => {
  const origin = "https://api.example.test";
  const sourceQuotes = [{path, quote}];
  const buyerInput = {
    request: "Check the shipment capacity.",
    clarifications: [
      {question:"What capacity should I use?", answer:"The capacity is 40 units."},
      {question:"What is the reserve capacity?", answer:"The capacity is 90 units."},
    ],
    outputs: [{name:"shipment.json", format:"json"}],
    expirySeconds: 600,
    maxBudget: "10000",
  };
  const app = createApp({
    dbPath: ":memory:",
    buyerToken: token,
    deployment: {mode:"public", serviceOrigin:origin},
    budget: {requestCeilingMicroUsd:500000, dailyCeilingMicroUsd:5000000, inputMicroUsdPerMillion:1000000, outputMicroUsdPerMillion:1000000},
    engine: {
      ...simulatedEngine(),
      mode: "real",
      async eval({deliverables}) {
        const shipment = JSON.parse(Buffer.from(deliverables[0]!.content).toString()) as {units:string};
        return {ok:true, verdict:Number(shipment.units) <= 40 ? 1 : 0};
      },
    },
    draftModel: {
      outputTokenBound: {parameter:"max_tokens", maxTokens:8192},
      async draft() {
        return {
          model: "controlled",
          traceId: "clarification-quote",
          usage,
          result: {
            kind: "draft",
            plan: {
              version: 1,
              deliverables: [{name:"shipment.json", parser:"json/v1", fields:[{name:"units", type:"i64"}]}],
              references: [],
              rules: [{
                op: "lte",
                left: {op:"field", source:"deliverable", file:"shipment.json", field:"units"},
                right: {op:"literal", type:"i64", value:"40"},
              }],
            },
            examples: [
              {name:"pass", predictedVerdict:1, files:[{name:"shipment.json", content:'{"units":"40"}'}]},
              {name:"fail", predictedVerdict:0, files:[{name:"shipment.json", content:'{"units":"41"}'}]},
            ],
            sourceQuotes,
            coverage: {
              requirements: [{id:"capacity", text:"Check the shipment capacity.", ruleIndices:[0], quoteIndices:[0]}],
              assumptions: [],
              unresolved: [],
            },
          },
        };
      },
    },
  });
  apps.push(app);
  const transport = ((url: string | URL | Request, init?: RequestInit) => app.app.request(String(url), init)) as typeof fetch;
  const account = privateKeyToAccount(`0x${"ad".repeat(32)}`);
  const anon = hostedClient({baseUrl:origin, fetch:transport});
  const key = await anon.authenticate(account.address, message => account.signMessage({message}), "clarification-login");
  const client = hostedClient({baseUrl:origin, apiKey:key.key, fetch:transport});
  const task = await client.draft(buyerInput, "clarification-draft");
  await app.pumpTasks();
  const done = await client.task(task.id);
  expect(done.state).toBe("succeeded");
  const draft = done.result as {
    draftId: string;
    revision: Revision;
    revisionHash: string;
    exampleApprovalReady: boolean;
    quoteVerification: unknown;
    coverage: {ruleCoverageComplete:boolean; coverageDigest:string};
  };
  expect(draft.exampleApprovalReady).toBe(true);
  expect(draft.quoteVerification).toEqual([{path,quote,found}]);
  expect(draft.coverage.ruleCoverageComplete).toBe(found);
  const job = await client.createJob({source:"grok", draftId:draft.draftId, revision:draft.revision}, "clarification-job") as {jobId:string};
  const approval = client.approve(job.jobId, {
    revisionHash: draft.revisionHash,
    referenceDigest: draft.revision.referenceDigest,
    coverageDigest: draft.coverage.coverageDigest,
  }, "clarification-approval");
  if (found) await expect(approval).resolves.toMatchObject({state:"approved"});
  else await expect(approval).rejects.toMatchObject({status:409, code:"approval_required"});
});
