import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreNonDraft} from './non-draft-oracle.mjs';

test('response type alone does not establish clarification fidelity',()=>{
  const scored=scoreNonDraft('ambiguous-1',{kind:'clarification',questions:['Please specify the output files and exact acceptance policy.']});
  assert.equal(scored.covered,false);
  assert.deepEqual(scored.missingFacets,['spending_limits','currency','rounding']);
});
test('clarification identifies missing rules and rejects unrelated policy assumptions',()=>{
  const scored=scoreNonDraft('ambiguous-6',{kind:'clarification',questions:[
    'Which signature profile and trusted signer should apply?',
    'Which artifact and job context must it bind, and what defines recent or scores well?']});
  assert.deepEqual(scored.missingFacets,[]);
  assert.deepEqual(scored.extraneousAssumptions,['unrequested_recency','unrequested_score']);
  assert.equal(scored.covered,false);
});
test('specific clarification covers all requested missing facets',()=>{
  assert.equal(scoreNonDraft('ambiguous-7',{kind:'clarification',questions:[
    'What units does the total use? Is 100 an inclusive or strict boundary?']}).covered,true);
});
test('unsupported explanation must name the missing capability',()=>{
  assert.equal(scoreNonDraft('unsupported-8',{kind:'unsupported',reason:'The requested operation is unavailable.'}).covered,false);
  assert.equal(scoreNonDraft('unsupported-8',{kind:'unsupported',reason:'SHA3-256 is absent from the supplied catalog.'}).covered,true);
});
test('unknown requests and mismatched types fail closed',()=>{
  assert.throws(()=>scoreNonDraft('unknown',{kind:'clarification',questions:[]}),/Unknown/);
  assert.equal(scoreNonDraft('ambiguous-7',{kind:'unsupported',reason:'units boundary'}).covered,false);
});
