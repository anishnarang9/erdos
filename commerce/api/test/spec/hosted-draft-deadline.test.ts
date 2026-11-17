import {afterEach,expect,it,vi} from 'vitest';
import {createApp,simulatedEngine} from '../../src/index.ts';
import {draftRecordKey} from '../../src/grok.ts';
import {BUYER_TOKEN} from './helpers.ts';
afterEach(()=>vi.useRealTimers());
it('uses one deadline across initial model, checks and repair',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));let calls=0,aborted=0;const signals:AbortSignal[]=[];
 const wait=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal)signals.push(signal);const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{aborted++;clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
 const plan={version:1,deliverables:[{name:'result.json',parser:'json/v1'}],references:[],rules:[{op:'literal',type:'bool',value:true}]};
 const app=createApp({dbPath:':memory:',buyerToken:BUYER_TOKEN,engine:{...simulatedEngine(),validate:async(_plan,options)=>{await wait(20000,options?.signal);return{ok:true};},eval:async(input)=>{await wait(10000,input.signal);return{ok:true,verdict:1};}},draftModel:{draft:async(input)=>{calls++;await wait(calls===1?1000:40000,(input as any).signal);return{model:'controlled',traceId:`deadline-${calls}`,usage:{promptTokens:1,completionTokens:1,cachedTokens:0,reasoningTokens:0,costInUsdTicks:1},result:{kind:'draft',plan,sourceQuotes:[],examples:[{name:'yes',predictedVerdict:1,files:[{name:'result.json',content:'1'}]},{name:'no',predictedVerdict:0,files:[{name:'result.json',content:'0'}]}]}};}}});
 try{const pending=Promise.resolve(app.app.request('/v1/drafts',{method:'POST',headers:{authorization:`Bearer ${BUYER_TOKEN}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({request:'Check result',outputs:[{name:'result.json',format:'json'}],expirySeconds:600,maxBudget:'10000'})}));
 await vi.advanceTimersByTimeAsync(120000);let done=false;void pending.then(()=>{done=true;});await vi.advanceTimersByTimeAsync(0);expect(done).toBe(true);const response=await pending;expect(response.status,await response.clone().text()).toBe(502);expect(await response.json()).toMatchObject({error:{code:'model_failed',details:{reason:'timeout'}}});expect(calls).toBe(2);expect(signals.length).toBeGreaterThan(4);expect(new Set(signals).size).toBe(1);expect(aborted).toBeGreaterThan(0);
 }finally{app.close();}
});
it('excludes runtime cancellation from persistent model recording identity',()=>{
 const input={request:'Check',outputs:[],referenceNames:[],clarifications:[],schema:{}};expect(draftRecordKey({...input,signal:new AbortController().signal} as any)).toBe(draftRecordKey(input));
});
