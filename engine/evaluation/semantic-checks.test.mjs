import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

test('semantic scoring identifies weakened and overly strict predicates separately',async()=>{
  let api;try{api=await import('./semantic-checks.mjs');}catch{assert.fail('Semantic checks must exist');}
  assert.equal(api.mismatchKind('fail','pass'),'omitted_or_weakened_requirement');
  assert.equal(api.mismatchKind('pass','fail'),'overly_strict_predicate');
  assert.equal(api.mismatchKind('reject','pass'),'invalid_input_accepted');
  assert.equal(api.mismatchKind('pass','pass'),null);
});

test('a hash of the exact requested text has public provenance',async()=>{
  const api=await import('./semantic-checks.mjs');
  const value='0x'+createHash('sha256').update('Requested report.\n').digest('hex');
  const diagnostics=api.policyDiagnostics({rules:[{op:'literal',type:'string',value}]},
    {request:'Set report.txt to exactly "Requested report.\\n".'},[]);
  assert.equal(diagnostics.unprovenConstants.length,0);
});

test('constant screening flags unsupported policy values and changed trust keys',async()=>{
  const api=await import('./semantic-checks.mjs');
  const input={request:'Keep the budget at or below 1000 cents. Set label to "ok". Public signer: 0x1234'};
  const base={rules:[{op:'literal',type:'i64',value:'1000'},{op:'literal',type:'string',value:'ok'}],evidence:[{signer:'0x1234'}]};
  assert.equal(api.policyDiagnostics(base,input,[]).unprovenConstants.length,0);
  const changed=structuredClone(base);changed.rules[0].value='1001';changed.evidence[0].signer='0x9999';
  const d=api.policyDiagnostics(changed,input,[]);
  assert.equal(d.unprovenConstants.length,1);assert.equal(d.unapprovedTrustKeys.length,1);
});
