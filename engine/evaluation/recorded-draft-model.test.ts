import test from 'node:test';
import assert from 'node:assert/strict';
import type {DraftModelInput} from '../../commerce/api/src/grok.ts';

const input:DraftModelInput={request:'Cap the total at 100 cents.',outputs:[],referenceNames:[],clarifications:[],schema:{version:1}};
const result={kind:'clarification' as const,questions:['Which file contains the total?']};

test('recorded model replays an actual result only for its exact authoring input',async()=>{
  let api;try{api=await import('./recorded-draft-model.ts');}catch{assert.fail('Recorded model adapter must exist');}
  const model=new api.RecordedDraftModel({model:'gpt-6-luna',tracePrefix:'trial-1',
    inputs:[{requestId:'q-a',input}],results:[{requestId:'q-a',result}]});
  assert.deepEqual(await model.draft(input),{model:'gpt-6-luna',traceId:'trial-1/q-a',result});
  await assert.rejects(()=>model.draft({...input,request:'Cap the total at 100 dollars.'}),/recorded input/);
  const first=await model.draft(input);first.result.kind==='clarification'&&first.result.questions.push('mutation');
  assert.deepEqual((await model.draft(input)).result,result);
});

test('recorded model rejects missing, duplicate, or malformed authoring outcomes',async()=>{
  const api=await import('./recorded-draft-model.ts');
  const options={model:'gpt-6-luna',tracePrefix:'trial',inputs:[{requestId:'q-a',input}]};
  assert.throws(()=>new api.RecordedDraftModel({...options,results:[]}),/missing/i);
  assert.throws(()=>new api.RecordedDraftModel({...options,results:[{requestId:'q-a',result},{requestId:'q-a',result}]}),/duplicate/i);
  assert.throws(()=>new api.RecordedDraftModel({...options,results:[{requestId:'q-a',result:{kind:'draft'}}]}),/malformed/i);
});
