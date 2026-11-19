import {describe,expect,it} from 'vitest';
import {assessCoverage} from '../../src/coverage.ts';
import {draftResponseSchema,parseModelDraft} from '../../src/grok.ts';
const quotes=[{path:'/request',quote:'Check both conditions',found:true}];
const complete={requirements:[{id:'conditions',text:'Check both conditions',ruleIndices:[0,1],quoteIndices:[0]}],assumptions:[],unresolved:[]};
describe('reviewable requirement links',()=>{
 it('requires links for every rule and quotes that were found',()=>{
  const good=assessCoverage(2,complete,quotes);expect(good.ruleCoverageComplete).toBe(true);expect(good.coverageDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(assessCoverage(2,undefined,quotes).ruleCoverageComplete).toBe(false);
  expect(assessCoverage(2,{...complete,requirements:[{...complete.requirements[0]!,ruleIndices:[0]}]},quotes).unmappedRuleIndices).toEqual([1]);
  expect(assessCoverage(2,complete,[{...quotes[0]!,found:false}]).ruleCoverageComplete).toBe(false);
  expect(assessCoverage(2,{...complete,requirements:[{...complete.requirements[0]!,quoteIndices:[1]}]},quotes).ruleCoverageComplete).toBe(false);
 });
 it('blocks assumptions, unresolved requirements, invalid links and duplicate identities',()=>{
  for(const coverage of [{...complete,assumptions:['assume a trusted source']},{...complete,unresolved:['which threshold?']},{...complete,requirements:[{...complete.requirements[0]!,ruleIndices:[0,2]}]},{...complete,requirements:[...complete.requirements,...complete.requirements]}])expect(assessCoverage(2,coverage,quotes).ruleCoverageComplete).toBe(false);
 });
 it('binds review to exact normalized links and source quotes',()=>{
  const first=assessCoverage(2,complete,quotes).coverageDigest;
  expect(assessCoverage(2,{...complete,requirements:[{...complete.requirements[0]!,text:'A changed requirement'}]},quotes).coverageDigest).not.toBe(first);
  expect(assessCoverage(2,complete,[{...quotes[0]!,quote:'Different text'}]).coverageDigest).not.toBe(first);
 });
 it('requires bounded coverage in the strict provider wire schema while preserving legacy records',()=>{
  const schema:any=draftResponseSchema();expect(schema.anyOf[0].required).toContain('coverage');
  const draft={kind:'draft',plan:{rules:[true,true]},examples:[],sourceQuotes:[]};expect(parseModelDraft(draft)).toEqual(draft);
  expect(()=>parseModelDraft({...draft,coverage:{...complete,requirements:Array(65).fill(complete.requirements[0])}})).toThrow();
 });
});
import {createApp,EngineError,simulatedEngine} from '../../src/index.ts';
import {BUYER_TOKEN} from './helpers.ts';
it.each(['draft', 'unsupported', 'clarification', 'invalid-plan', 'checker-outage', 'examples-regression', 'coverage-regression'] as const)('handles a repair with outcome %s', async (repair) => {
  let calls = 0;
  const input = {request:'Check both conditions', outputs:[{name:'result.json',format:'json'}], expirySeconds:600, maxBudget:'10000'};
  const plan = {
    version: 1,
    deliverables: [{name:'result.json',parser:'json/v1'}],
    references: [],
    rules: [{op:'literal',type:'bool',value:true}, {op:'literal',type:'bool',value:true}],
  };
  const usage = {promptTokens:1, completionTokens:1, cachedTokens:0, reasoningTokens:0, costInUsdTicks:1};
  const controlledEngine = simulatedEngine();
  const app = createApp({
    dbPath: ':memory:',
    buyerToken: BUYER_TOKEN,
    engine: {
      ...controlledEngine,
      validate: async (candidate, options) => {
        if (calls === 2 && repair === 'checker-outage') throw new EngineError('spawn', 'Controlled checker outage');
        if ((candidate as {version?: number}).version === 0) {
          return {ok:false, kind:'invalid', errors:[{path:'/version', message:'Expected version 1'}]};
        }
        return controlledEngine.validate(candidate, options);
      },
      eval: async ({deliverables}) => {
        const losesNegative = (calls === 2 && repair === 'examples-regression') ||
          (calls === 1 && repair === 'coverage-regression');
        return {ok:true, verdict:losesNegative || deliverables[0]?.content[0] === 49 ? 1 : 0};
      },
    },
    draftModel: {
      draft: async () => {
        const reply = {model:'controlled', traceId:`coverage-${++calls}`, usage};
        if (calls === 2 && repair === 'unsupported') return {...reply, result:{kind:'unsupported', reason:'Cannot express this policy'}};
        if (calls === 2 && repair === 'clarification') return {...reply, result:{kind:'clarification', questions:['Which policy?']}};
        const incompleteCoverage = repair === 'coverage-regression' ? calls === 2 : calls === 1;
        return {
          ...reply,
          result: {
            kind: 'draft',
            plan: calls === 2 && repair === 'invalid-plan' ? {...plan, version:0} : plan,
            coverage: incompleteCoverage ? {...complete, unresolved:['which policy?']} : complete,
            sourceQuotes: quotes.map(({path, quote}) => ({path, quote})),
            examples: [
              {name:'pass', predictedVerdict:1, files:[{name:'result.json',content:'1'}]},
              {name:'fail', predictedVerdict:0, files:[{name:'result.json',content:'0'}]},
            ],
          },
        };
      },
    },
  });
  try {
    const response = await app.app.request('/v1/drafts', {
      method: 'POST',
      headers: {authorization:`Bearer ${BUYER_TOKEN}`, 'content-type':'application/json', 'idempotency-key':crypto.randomUUID()},
      body: JSON.stringify(input),
    });
    const body = await response.json();
    const repaired = repair === 'draft';
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(calls).toBe(2);
    expect(body).toHaveProperty('qualification', expect.objectContaining({
      repairCount: 1,
      traceId: repaired || repair === 'clarification' ? 'coverage-2' : 'coverage-1',
      traceIds: ['coverage-1', 'coverage-2'],
      usage: [usage, usage],
    }));
    expect(body).toHaveProperty('attempts.length', 2);
    if (repair === 'clarification') {
      expect(body).toMatchObject({kind:'clarification', questions:['Which policy?']});
    } else {
      expect(body).toMatchObject({
        kind: 'draft',
        revision: {plan},
        coverage: {ruleCoverageComplete:repaired || repair === 'coverage-regression', requirements:complete.requirements},
        exampleApprovalReady: repair !== 'coverage-regression',
        quoteVerification: quotes,
      });
      expect(body).toHaveProperty('coverage.coverageDigest', expect.stringMatching(/^[0-9a-f]{64}$/));
    }
  } finally {
    app.close();
  }
});
