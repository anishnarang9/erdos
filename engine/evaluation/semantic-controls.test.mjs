import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runEngine} from './run-challenges.mjs';
import {mismatchKind,policyDiagnostics} from './semantic-checks.mjs';

const binary=process.env.UBC26_ENGINE_BIN;
const results=[];
const request={request:'Keep the total at or below 10000 cents. Require markedComplete to be true.'};
const oracle=(total,complete)=>BigInt(total)<=10000n&&complete?'pass':'fail';
async function check(plan,total,complete) {
  const root=await mkdtemp(join(tmpdir(),'ubc26-semantic-control-'));
  try {
    await mkdir(join(root,'delivery'));
    await writeFile(join(root,'plan.json'),JSON.stringify(plan));
    await writeFile(join(root,'delivery/expense-report.json'),JSON.stringify({totalCents:total,markedComplete:complete}));
    const run=runEngine(binary,['eval','--plan',join(root,'plan.json'),'--deliverables',join(root,'delivery')]);
    assert.equal(run.exitCode,0,JSON.stringify(run));return run.value.verdict===1?'pass':'fail';
  } finally {await rm(root,{recursive:true,force:true});}
}
const original=async()=>JSON.parse(await readFile(new URL('../fixtures/expense-report-plan.json',import.meta.url),'utf8'));

test('independent counterexample catches an omitted requirement',{skip:!binary},async()=>{
  const plan=await original();plan.rules.pop();
  const expected=oracle('9400',false),actual=await check(plan,'9400',false);
  assert.equal(mismatchKind(expected,actual),'omitted_or_weakened_requirement');
  results.push({control:'omitted_requirement',expected,actual,detected:true});
});
test('independent counterexample catches a weaker budget predicate',{skip:!binary},async()=>{
  const plan=await original();plan.rules[0].right.value='11000';
  const expected=oracle('10400',true),actual=await check(plan,'10400',true);
  assert.equal(mismatchKind(expected,actual),'omitted_or_weakened_requirement');
  results.push({control:'weakened_predicate',expected,actual,detected:true});
});
test('a cents-to-whole-units translation error changes a valid result',{skip:!binary},async()=>{
  const plan=await original();plan.rules[0].right.value='100';
  const expected=oracle('9400',true),actual=await check(plan,'9400',true);
  assert.equal(mismatchKind(expected,actual),'overly_strict_predicate');
  assert.ok(policyDiagnostics(plan,request,[]).unprovenConstants.some(x=>x.value==='100'));
  results.push({control:'changed_units',expected,actual,detected:true});
});
test('constant screening catches an invented threshold that escapes two sample labels',{skip:!binary},async()=>{
  const plan=await original();plan.rules[0].right.value='10001';
  assert.equal(await check(plan,'9400',true),oracle('9400',true));
  assert.equal(await check(plan,'10400',true),oracle('10400',true));
  assert.ok(policyDiagnostics(plan,request,[]).unprovenConstants.some(x=>x.value==='10001'));
  results.push({control:'invented_constant',sampleLabelsUnchanged:true,detected:true});
});
after(async()=>{
  if(process.env.UBC26_SEMANTIC_CONTROL_REPORT)
    await writeFile(process.env.UBC26_SEMANTIC_CONTROL_REPORT,JSON.stringify({syntheticControls:true,modelCalls:0,
      independentOracle:'Direct buyer rule: integer cents <=10000 and markedComplete.',controls:results,
      passed:results.filter(x=>x.detected).length,expected:4},null,2)+'\n');
});
