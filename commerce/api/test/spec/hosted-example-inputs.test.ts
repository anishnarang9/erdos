import {afterEach,expect,it} from "vitest";
import {createHash} from "node:crypto";
import {createApp,simulatedEngine,type CreateAppOptions} from "../../src/index.ts";
const TOKEN="synthetic-example-inputs-token";
const body={request:"Check the supplied result",outputs:[{name:"result.json",format:"json"}],references:[],expirySeconds:600,maxBudget:"10000"};
const apps:ReturnType<typeof createApp>[]=[];
afterEach(()=>{for(const app of apps.splice(0))app.close();});
function app(model:unknown,engine:CreateAppOptions["engine"]=simulatedEngine()){
 const a=createApp({dbPath:":memory:",buyerToken:TOKEN,engine,draftModel:model as CreateAppOptions["draftModel"]});apps.push(a);return a;
}
function post(a:ReturnType<typeof app>,input:unknown){return a.app.request('/v1/drafts',{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(input)});}
it("passes exact opaque reference bytes to the model as explicit base64 identity data",async()=>{
 const bytes=Buffer.from([0xff,0xfe,0,0x80]);let seen:any;
 const a=app({draft:async(input:unknown)=>{seen=input;return{model:"controlled",traceId:"opaque-1",result:{kind:"clarification",questions:["Which byte limit?"]}};}});
 const res=await post(a,{...body,references:[{name:"blob.bin",contentBase64:bytes.toString('base64')}]});
 expect(res.status,await res.clone().text()).toBe(200);
 expect(seen.referenceFiles).toEqual([{name:"blob.bin",encoding:"base64",contentBase64:bytes.toString('base64'),byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]);
});
it("resolves public fixture selections and evaluates exact decoded files, evidence and context",async()=>{
 const context=`0x01${'00'.repeat(168)}`,seen:any[]=[];
 const fixtures=[1,0].map(v=>({name:`fixture-${v}`,predictedVerdict:v,files:[{name:"result.json",content:Buffer.from(JSON.stringify({ok:v===1})).toString('base64'),encoding:"base64"}],evidence:[{name:"custody.json",content:'{"signed":"public-example"}'}],context}));
 const a=app({draft:async()=>({model:"controlled",traceId:"fixtures-1",result:{kind:"draft",plan:{version:1,deliverables:[{name:"result.json",parser:"json/v1"}],references:[],rules:[{op:"literal",type:"bool",value:true}]},examples:fixtures.map(f=>({name:f.name,predictedVerdict:f.predictedVerdict,fixtureName:f.name})),sourceQuotes:[{path:"/request",quote:body.request}]}})},
 {...simulatedEngine(),eval:async(input:any)=>{seen.push(input);return{ok:true,verdict:JSON.parse(Buffer.from(input.deliverables[0].content).toString()).ok?1:0};}});
 const res=await post(a,{...body,exampleFixtures:fixtures});expect(res.status,await res.clone().text()).toBe(200);
 const result=await res.json() as any;expect(result.examples.map((e:any)=>e.checkerVerdict)).toEqual([1,0]);
 expect(result.buyerFixtureChecks.map((e:any)=>e.checkerVerdict)).toEqual([1,0]);
 expect(result.buyerFixtureApprovalReady).toBe(true);
 expect(result.exampleInputs).toEqual(fixtures.map(f=>({...f,fixtureName:f.name,status:"complete"})));
 expect(seen).toHaveLength(2);expect(seen[0].context).toBe(context);expect(Buffer.from(seen[0].evidence[0].content).toString()).toBe('{"signed":"public-example"}');
 expect(Buffer.from(seen[0].deliverables[0].content).toString()).toBe('{"ok":true}');
});
it("rejects excess illustrative fixtures before any model call",async()=>{
 let calls=0;const a=app({draft:async()=>{calls++;throw Error("must not dispatch");}});
 const fixture={name:"x",predictedVerdict:1,files:[{name:"result.json",content:"{}"}]};
 const res=await post(a,{...body,exampleFixtures:Array.from({length:9},(_,i)=>({...fixture,name:`x${i}`}))});
 expect(res.status).toBe(400);expect(calls).toBe(0);
});

it("normalizes buyer-proven duplicate collection fields before native validation and revision hashing", async () => {
 const fixtures=[1,0].map(value=>({
  name:`fixture-${value}`,
  predictedVerdict:value,
  files:[{name:"result.json",content:JSON.stringify({rows:[{id:value===1?"good":"bad"}]})}],
 })) as any;
 const plan={version:1,deliverables:[{name:"result.json",parser:"json/v1",fields:[{name:"rows",type:"string"}],collections:[{name:"rows",fields:[{name:"id",type:"string"}]}]}],references:[],rules:[{op:"literal",type:"bool",value:true}]};
 let validated:any;
 const a=app({draft:async()=>({model:"controlled",traceId:"duplicate-shape",result:{kind:"draft",plan,examples:fixtures.map((fixture:any)=>({name:fixture.name,predictedVerdict:fixture.predictedVerdict,fixtureName:fixture.name})),sourceQuotes:[]}})},
 {...simulatedEngine(),validate:async(candidate:unknown)=>{validated=candidate;return{ok:true};},eval:async(input:any)=>({ok:true,verdict:JSON.parse(Buffer.from(input.deliverables[0].content).toString()).rows[0].id==="good"?1:0})});
 const response=await post(a,{...body,exampleFixtures:fixtures});
 expect(response.status,await response.clone().text()).toBe(200);
 const result:any=await response.json();
 expect(result.planNormalizations).toEqual(["/deliverables/0/fields/0"]);
 expect(validated.deliverables[0].fields).toEqual([]);
 expect(result.revision.plan).toEqual(validated);
 expect(plan.deliverables[0]!.fields).toHaveLength(1);
 expect(result.buyerFixtureApprovalReady).toBe(true);
});

it("uses an explicit output contract without buyer fixtures for duplicate collection fields", async () => {
 const plan={version:1,deliverables:[{name:"result.json",parser:"json/v1",fields:[{name:"rows",type:"string"}],collections:[{name:"rows",fields:[{name:"id",type:"string"}]}]}],references:[],rules:[{op:"literal",type:"bool",value:true}]};
 let validated:any;
 const a=app({draft:async()=>({model:"controlled",traceId:"contract-shape",result:{kind:"draft",plan,examples:[],sourceQuotes:[]}})},
  {...simulatedEngine(),validate:async(candidate:unknown)=>{validated=candidate;return{ok:true};}});
 const request="Check the supplied result\n\nOutput file contract: result.json: JSON object. rows array of records with fields: id: string.";
 const response=await post(a,{...body,request});
 expect(response.status,await response.clone().text()).toBe(200);
 const result:any=await response.json();
 expect(result.planNormalizations).toEqual(["/deliverables/0/fields/0"]);
 expect(validated.deliverables[0].fields).toEqual([]);
 expect(result.revision.plan).toEqual(validated);
 expect(plan.deliverables[0]!.fields).toHaveLength(1);
});

it("removes an unused output scalar omitted by accepted buyer fixtures", async () => {
 const fixtures=[1,0].map(value=>({
  name:`fixture-${value}`,predictedVerdict:value,
  files:[{name:"result.json",content:JSON.stringify({rows:[{id:value===1?"good":"bad"}]})}],
 })) as any;
 const plan={version:1,deliverables:[{name:"result.json",parser:"json/v1",fields:[{name:"capacity",type:"i64"}],collections:[{name:"rows",fields:[{name:"id",type:"string"}]}]}],references:[],rules:[{op:"literal",type:"bool",value:true}]};
 let validated:any;
 const a=app({draft:async()=>({model:"controlled",traceId:"omitted-scalar",result:{kind:"draft",plan,examples:fixtures.map((fixture:any)=>({name:fixture.name,predictedVerdict:fixture.predictedVerdict,fixtureName:fixture.name})),sourceQuotes:[]}})},
 {...simulatedEngine(),validate:async(candidate:unknown)=>{validated=candidate;return{ok:true};},eval:async(input:any)=>({ok:true,verdict:JSON.parse(Buffer.from(input.deliverables[0].content).toString()).rows[0].id==="good"?1:0})});
 const response=await post(a,{...body,exampleFixtures:fixtures});
 expect(response.status,await response.clone().text()).toBe(200);
 const result:any=await response.json();
 expect(result.planNormalizations).toEqual(["/deliverables/0/fields/0"]);
 expect(validated.deliverables[0].fields).toEqual([]);
 expect(result.revision.plan).toEqual(validated);
 expect(result.buyerFixtureApprovalReady).toBe(true);
});

it("returns the exact bounded generated file bytes for buyer review",async()=>{
 const examples=[{name:"generated",predictedVerdict:1,files:[{name:"result.json",content:"{\"ok\":true}"}]}];
 const a=app({draft:async()=>({model:"controlled",traceId:"generated-review",result:{kind:"draft",plan:{version:1,deliverables:[{name:"result.json",parser:"json/v1"}],references:[],rules:[{op:"literal",type:"bool",value:true}]},examples,sourceQuotes:[]}})});
 const response=await post(a,body);const result:any=await response.json();expect(response.status).toBe(200);expect(result.exampleInputs).toEqual(examples.map(e=>({...e,status:"complete"})));
});
