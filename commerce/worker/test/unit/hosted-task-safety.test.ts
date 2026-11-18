import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { hostedClient } from "@ubc26/sdk";
import { createApp, type DraftModel } from "@ubc26/api";
const roots:string[]=[],apps:ReturnType<typeof createApp>[]=[];
afterEach(()=>{for(const app of apps.splice(0))app.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it("keeps queued model work paused after restart with emergency disable",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ubc26-queue-disable-"));roots.push(root);let calls=0;
  const model:DraftModel={draft:async()=>{calls++;return{model:"controlled-test-model",traceId:"test",result:{kind:"clarification",questions:["Which policy?"]}};}};
  const options={dbPath:join(root,"state.db"),buyerToken:"local-compatibility-only-token",deployment:{mode:"local" as const,serviceOrigin:"http://localhost"},draftModel:model};
  let active=createApp(options);apps.push(active);
  const transport=((input:string|URL|Request,init?:RequestInit)=>active.app.request(String(input),init)) as typeof fetch;
  const signer=privateKeyToAccount(`0x${"11".repeat(32)}`),anonymous=hostedClient({baseUrl:"http://localhost",fetch:transport});
  const key=await anonymous.authenticate(signer.address,message=>signer.signMessage({message}),"disable-test-login");
  const client=hostedClient({baseUrl:"http://localhost",apiKey:key.key,fetch:transport});
  const task=await client.draft({request:"Check the requested policy",outputs:[{name:"result.json",format:"json"}],references:[],expirySeconds:3600,maxBudget:"10000"},"disable-test-draft");
  expect(task.state).toBe("queued");expect(calls).toBe(0);
  apps.pop();active.close();active=createApp({...options,expensiveDisabled:true});apps.push(active);
  active.reconcileTasks();await active.pumpTasks();
  expect(calls).toBe(0);expect((await client.task(task.id)).state).toBe("queued");
});

it("rejects an old service-origin challenge after a state restore at another origin",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ubc26-restored-origin-"));roots.push(root);
  const options={dbPath:join(root,"state.db"),buyerToken:"local-compatibility-only-token"};
  let active=createApp({...options,deployment:{mode:"local",serviceOrigin:"https://first.example.test"}});apps.push(active);
  const signer=privateKeyToAccount(`0x${"33".repeat(32)}`);
  const challengeResponse=await active.app.request("https://first.example.test/v1/auth/challenge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet:signer.address})});
  const challenge=await challengeResponse.json() as {challengeId:string;message:string};
  const signature=await signer.signMessage({message:challenge.message});
  apps.pop();active.close();active=createApp({...options,deployment:{mode:"local",serviceOrigin:"https://restored.example.test"}});apps.push(active);
  const response=await active.app.request("https://restored.example.test/v1/auth/keys",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({challengeId:challenge.challengeId,signature})});
  expect(response.status).toBe(401);
  apps.pop();active.close();active=createApp({...options,deployment:{mode:"local",serviceOrigin:"https://first.example.test"}});apps.push(active);
  const original=await active.app.request("https://first.example.test/v1/auth/keys",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({challengeId:challenge.challengeId,signature})});
  expect(original.status).toBe(200);
  const replay=await active.app.request("https://first.example.test/v1/auth/keys",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({challengeId:challenge.challengeId,signature})});
  expect(replay.status).toBe(401);
});

it("creates only one paid task when concurrent requests reuse a key with different bodies",async()=>{
  let calls=0;
  const active=createApp({dbPath:":memory:",buyerToken:"local-compatibility-only-token",deployment:{mode:"local",serviceOrigin:"http://localhost"},draftModel:{draft:async()=>{calls++;return{model:"controlled-test-model",traceId:"test",result:{kind:"clarification",questions:["Which policy?"]}};}}});apps.push(active);
  const transport=((input:string|URL|Request,init?:RequestInit)=>active.app.request(String(input),init)) as typeof fetch;
  const signer=privateKeyToAccount(`0x${"44".repeat(32)}`),anonymous=hostedClient({baseUrl:"http://localhost",fetch:transport});
  const key=await anonymous.authenticate(signer.address,message=>signer.signMessage({message}),"concurrent-test-login");
  const client=hostedClient({baseUrl:"http://localhost",apiKey:key.key,fetch:transport});
  const input={request:"Check policy A",outputs:[{name:"result.json",format:"json" as const}],references:[],expirySeconds:3600,maxBudget:"10000"};
  const outcomes=await Promise.allSettled([client.draft(input,"same-cost-key"),client.draft({...input,request:"Check policy B"},"same-cost-key")]);
  expect(outcomes.filter(item=>item.status==="fulfilled")).toHaveLength(1);
  expect(outcomes.filter(item=>item.status==="rejected")).toHaveLength(1);
  await active.pumpTasks();
  expect(calls).toBe(1);
});
