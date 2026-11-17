import {expect,it} from "vitest";
import {grokDraftModel,readModelUsage} from "../../src/grok.ts";
import {authoringCharge,quoteAuthoringCost} from "../../src/tasks.ts";
const budget={requestCeilingMicroUsd:1000000,dailyCeilingMicroUsd:10000000,inputMicroUsdPerMillion:1000000,outputMicroUsdPerMillion:1000000};
it("does not advertise a total spend bound for reasoning or unknown Grok models",()=>{
 for(const model of ['grok-4.7','grok-4.6','grok-4.5','grok-4.3','unreviewed-model']){
  expect(grokDraftModel({apiKey:'synthetic-only',model}).outputTokenBound).toBeUndefined();
 }
});
it("advertises the visible cap only for the reviewed exact non-reasoning model",async()=>{
 let sent:any;const model=grokDraftModel({apiKey:'synthetic-only',model:'grok-4.20-0309-non-reasoning',fetch:async(_url,init)=>{
  sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({id:'trace-no-reasoning',model:'grok-4.20-0309-non-reasoning',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'clarification',questions:['Which policy?']})}}]}));
 }});
 expect(model.outputTokenBound).toEqual({parameter:'max_completion_tokens',maxTokens:8192});
 await model.draft({request:'Check a policy',outputs:[],referenceNames:[],clarifications:[],schema:{}});
 expect(sent.max_completion_tokens).toBe(8192);expect(sent.max_tokens).toBeUndefined();expect(sent.n).toBe(1);expect(sent.search_parameters).toEqual({mode:'off'});
});
it("preserves reasoning tokens that exceed visible completion tokens and keeps the exact bill",()=>{
 const usage=readModelUsage({usage:{prompt_tokens:32,completion_tokens:9,total_tokens:135,completion_tokens_details:{reasoning_tokens:94},cost_in_usd_ticks:120000}});
 expect(usage).toMatchObject({promptTokens:32,completionTokens:9,reasoningTokens:94,costInUsdTicks:120000});
 expect(authoringCharge(usage!,budget)).toEqual({microUsd:12,source:'actual',costInUsdTicks:120000});
 expect(quoteAuthoringCost({...usage!,costInUsdTicks:null},budget)).toBe(135);
});
it("does not turn unreported reasoning consumption into a zero-cost tariff",()=>{
 const usage={promptTokens:32,completionTokens:9,cachedTokens:0,reasoningTokens:null,costInUsdTicks:null};
 expect(quoteAuthoringCost(usage,budget)).toBeNull();expect(authoringCharge(usage,budget)).toBeNull();
});

import {createApp} from "../../src/index.ts";
import {DRAFT_BODY} from "./helpers-t56.ts";
import {BUYER_TOKEN} from "./helpers.ts";
it("prices the reviewed model using its provider context ceiling and highest tier before dispatch",async()=>{
 let calls=0;const model=grokDraftModel({apiKey:"synthetic-only",model:"grok-4.20-0309-non-reasoning",fetch:async()=>{calls++;throw new Error("must not dispatch");}});
 for(const config of [
  {requestCeilingMicroUsd:1000000,dailyCeilingMicroUsd:10000000,inputMicroUsdPerMillion:2500000,outputMicroUsdPerMillion:5000000},
  {requestCeilingMicroUsd:5000000,dailyCeilingMicroUsd:10000000,inputMicroUsdPerMillion:1250000,outputMicroUsdPerMillion:2500000},
 ]){
  const app=createApp({dbPath:":memory:",buyerToken:BUYER_TOKEN,draftModel:model,budget:config});
  try{const response=await app.app.request("/v1/drafts",{method:"POST",headers:{authorization:`Bearer ${BUYER_TOKEN}`,"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify(DRAFT_BODY)});
   expect(response.status,await response.clone().text()).toBe(503);
  }finally{app.close();}
 }
 expect(calls).toBe(0);
});
