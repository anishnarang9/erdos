import {expect,it} from 'vitest';
import {createApp,grokDraftModel} from '../../src/index.ts';
import {BUYER_TOKEN} from './helpers.ts';
import {DRAFT_BODY} from './helpers-t56.ts';
it('retains safe model identity, trace and actual usage on a rejected provider response',async()=>{
 const secret='synthetic-key-must-not-leak',modelName='grok-4.20-0309-non-reasoning';
 const app=createApp({dbPath:':memory:',buyerToken:BUYER_TOKEN,budget:{requestCeilingMicroUsd:5000000,dailyCeilingMicroUsd:10000000,inputMicroUsdPerMillion:2500000,outputMicroUsdPerMillion:5000000},draftModel:grokDraftModel({apiKey:secret,model:modelName,fetch:async()=>Response.json({id:'failed-provider-trace',model:modelName,usage:{prompt_tokens:32,completion_tokens:9,cost_in_usd_ticks:120001},choices:[{finish_reason:'length',message:{content:secret}}]})})});
 try{const response=await app.app.request('/v1/drafts',{method:'POST',headers:{authorization:`Bearer ${BUYER_TOKEN}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(DRAFT_BODY)});const body:any=await response.json();expect(response.status).toBe(502);expect(body.error.details).toMatchObject({reason:'finish_length',qualification:{model:modelName,traceIds:['failed-provider-trace'],repairCount:0},attempts:[{kind:'model_failed',model:modelName,traceId:'failed-provider-trace',usage:{promptTokens:32,completionTokens:9,reasoningTokens:0,costInUsdTicks:120001}}]});expect(body.error.details.qualification.promptVersion).toMatch(/^[0-9a-f]{64}$/);expect(JSON.stringify(body)).not.toContain(secret);}finally{app.close();}
});
import {draftReply} from './helpers-t56.ts';

it.each([
  {firstPriced:true, second:'draft', status:200, calls:2, settled:26},
  {firstPriced:true, second:'invalid', status:502, calls:2, settled:26},
  {firstPriced:true, second:'unpriced', status:502, calls:2, settled:null},
  {firstPriced:false, second:'draft', status:502, calls:1, settled:null},
] as const)('bounds recovery of a malformed first reply (%j)', async ({firstPriced, second, status, calls, settled}) => {
  let count = 0;
  const model = 'grok-4.20-0309-non-reasoning';
  const malformed = 'private-provider-text{';
  const usage = {prompt_tokens:32, completion_tokens:9, cost_in_usd_ticks:120001};
  const app = createApp({
    dbPath: ':memory:',
    buyerToken: BUYER_TOKEN,
    budget: {requestCeilingMicroUsd:5000000, dailyCeilingMicroUsd:10000000, inputMicroUsdPerMillion:2500000, outputMicroUsdPerMillion:5000000},
    draftModel: grokDraftModel({
      apiKey: 'synthetic-only',
      model,
      fetch: async (_url, init) => {
        count += 1;
        const repair = count === 2;
        if (repair) {
          expect(String(init?.body)).toContain('invalid_reply');
          expect(String(init?.body)).not.toContain(malformed);
        }
        const priced = repair ? second !== 'unpriced' : firstPriced;
        return Response.json({
          id: `malformed-repair-${count}`,
          model,
          ...(priced ? {usage} : {}),
          choices: [{finish_reason:'stop', message:{
            content: repair && second === 'draft' ? JSON.stringify(draftReply().result) : malformed,
          }}],
        });
      },
    }),
  });
  try {
    const response = await app.app.request('/v1/drafts', {
      method: 'POST',
      headers: {authorization:`Bearer ${BUYER_TOKEN}`, 'content-type':'application/json', 'idempotency-key':crypto.randomUUID()},
      body: JSON.stringify(DRAFT_BODY),
    });
    const body = await response.json() as {error?: {details:unknown}};
    const details = body.error?.details ?? body;
    expect(response.status, JSON.stringify(body)).toBe(status);
    expect(count).toBe(calls);
    expect(details).toHaveProperty('qualification.repairCount', calls - 1);
    expect(details).toHaveProperty('attempts.length', calls);
    expect(details).toHaveProperty('attempts.0.reason', 'invalid_reply');
    expect(JSON.stringify(body)).not.toContain(malformed);
    if (settled !== null) {
      expect(details).toHaveProperty('billing', expect.objectContaining({state:'settled', microUsd:settled}));
    } else if (calls === 2) {
      expect(details).toHaveProperty('billing.state', 'uncertain');
    }
  } finally {
    app.close();
  }
});

it('keeps the charged rejected repair separate from the original draft',async()=>{
 let calls=0;const name='grok-4.20-0309-non-reasoning';const app=createApp({dbPath:':memory:',buyerToken:BUYER_TOKEN,budget:{requestCeilingMicroUsd:5000000,dailyCeilingMicroUsd:10000000,inputMicroUsdPerMillion:2500000,outputMicroUsdPerMillion:5000000},engine:{mode:'real',validate:async()=>({ok:false,kind:'invalid',errors:[{path:'/version',message:'controlled invalid plan'}]}),compile:async()=>{throw Error('not used');}},draftModel:grokDraftModel({apiKey:'synthetic-only',model:name,fetch:async()=>Response.json({id:`repair-trace-${++calls}`,model:name,usage:{prompt_tokens:32,completion_tokens:9,cost_in_usd_ticks:120001},choices:[{finish_reason:calls===1?'stop':'length',message:{content:JSON.stringify(draftReply().result)}}]})})});
 try{const response=await app.app.request('/v1/drafts',{method:'POST',headers:{authorization:`Bearer ${BUYER_TOKEN}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(DRAFT_BODY)});const body:any=await response.json();expect(response.status,JSON.stringify(body)).toBe(200);expect(calls).toBe(2);expect(body.attempts).toHaveLength(2);expect(body.attempts[1]).toMatchObject({kind:'model_failed',reason:'finish_length',model:name,traceId:'repair-trace-2'});expect(body.qualification.traceIds).toEqual(['repair-trace-1','repair-trace-2']);expect(body.qualification.usage).toHaveLength(2);expect(body.billing).toMatchObject({state:'settled',microUsd:26,source:'actual'});}finally{app.close();}
});
