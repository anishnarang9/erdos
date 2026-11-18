import {afterEach,expect,it} from "vitest";
import {grokDraftModel,createApp,simulatedEngine} from "@ubc26/api";
import {privateKeyToAccount} from "viem/accounts";
import {hostedClient} from "@ubc26/sdk";
const apps:ReturnType<typeof createApp>[]=[];
afterEach(()=>{for(const app of apps.splice(0))app.close();});

it("cancels an oversized provider response before buffering its complete body",async()=>{
  let cancelled=false,pulls=0;
  const chunk=new TextEncoder().encode("x".repeat(256*1024));
  const response=new Response(new ReadableStream<Uint8Array>({
    pull(controller){pulls++;if(pulls===1)controller.enqueue(new TextEncoder().encode('{"choices":[{"finish_reason":"stop","message":{"content":"'));else if(pulls<18)controller.enqueue(chunk);else{controller.enqueue(new TextEncoder().encode('"}}],"id":"test"}'));controller.close();}},
    cancel(){cancelled=true;},
  }),{headers:{"content-type":"application/json"}});
  const model=grokDraftModel({apiKey:"synthetic-test-api-key",model:"controlled-test-model",fetch:async()=>response});
  await expect(model.draft({request:"Check a policy",outputs:[],referenceNames:[],clarifications:[],schema:{}})).rejects.toMatchObject({reason:"output_too_large"});
  expect(cancelled).toBe(true);expect(pulls).toBeLessThan(18);
});

it("does not dispatch a repair when the first call exhausted the request spend ceiling",async()=>{
  let calls=0;
  const engine={...simulatedEngine(),validate:async()=>({ok:false as const,kind:"invalid" as const,errors:[{path:"/version",message:"Invalid version"}]})};
  const app=createApp({dbPath:":memory:",buyerToken:"local-compatibility-only-token",engine,
    deployment:{mode:"local",serviceOrigin:"http://localhost"},
    budget:{requestCeilingMicroUsd:200000,dailyCeilingMicroUsd:1000000,inputMicroUsdPerMillion:1000000,outputMicroUsdPerMillion:1000000},
    draftModel:{draft:async()=>{calls++;return{model:"controlled-test-model",traceId:"test",usage:{promptTokens:200000,completionTokens:0,cachedTokens:null,reasoningTokens:null,costInUsdTicks:null},result:{kind:"draft",plan:{version:0},examples:[],sourceQuotes:[]}};}}});apps.push(app);
  const transport=((input:string|URL|Request,init?:RequestInit)=>app.app.request(String(input),init)) as typeof fetch;
  const signer=privateKeyToAccount(`0x${"55".repeat(32)}`),anonymous=hostedClient({baseUrl:"http://localhost",fetch:transport});
  const key=await anonymous.authenticate(signer.address,message=>signer.signMessage({message}),"budget-test-login");
  const client=hostedClient({baseUrl:"http://localhost",apiKey:key.key,fetch:transport});
  await client.draft({request:"Check a policy",outputs:[{name:"result.json",format:"json"}],references:[],expirySeconds:3600,maxBudget:"10000"},"budget-test-draft");
  await app.pumpTasks();expect(calls).toBe(1);
});

it("checks the full reference and catalog prompt before the first paid dispatch",async()=>{
  let calls=0;
  const app=createApp({dbPath:":memory:",buyerToken:"local-compatibility-only-token",
    deployment:{mode:"local",serviceOrigin:"http://localhost"},
    budget:{requestCeilingMicroUsd:1000,dailyCeilingMicroUsd:10000,inputMicroUsdPerMillion:1000000,outputMicroUsdPerMillion:1000000},
    draftModel:{draft:async()=>{calls++;return{model:"controlled-test-model",traceId:"test",result:{kind:"clarification",questions:["Which policy?"]}};}}});apps.push(app);
  const transport=((input:string|URL|Request,init?:RequestInit)=>app.app.request(String(input),init)) as typeof fetch;
  const signer=privateKeyToAccount(`0x${"77".repeat(32)}`),anonymous=hostedClient({baseUrl:"http://localhost",fetch:transport});
  const key=await anonymous.authenticate(signer.address,message=>signer.signMessage({message}),"full-prompt-login");
  const client=hostedClient({baseUrl:"http://localhost",apiKey:key.key,fetch:transport});
  const task=await client.draft({request:"Check the supplied policy",outputs:[{name:"result.json",format:"json"}],references:[{name:"policy.txt",contentBase64:Buffer.from("界".repeat(10000)).toString("base64")}],expirySeconds:3600,maxBudget:"10000"},"full-prompt-draft");
  expect(task.state).toBe("queued");await app.pumpTasks();expect(calls).toBe(0);
});
