import assert from 'node:assert/strict';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readJson,writeJson,runEngine,sha256} from './run-challenges.mjs';

const [engineArg,hostArg,packagesArg,outArg]=process.argv.slice(2);
if(!engineArg||!hostArg||!packagesArg||!outArg)throw Error('Use node check-invariants.mjs ENGINE HOST_RUN PACKAGES NEW_OUTPUT');
const engine=resolve(engineArg),host=resolve(hostArg),packages=resolve(packagesArg),output=resolve(outArg);
await mkdir(output,{mode:0o700});
const report={version:1,syntheticJobs:true,engineSha256:sha256(await readFile(engine)),checks:[]};
const save=()=>writeJson(join(output,'invariants.json'),report);
function requireSuccess(run) {assert.equal(run.exitCode,0,JSON.stringify(run));return run.value;}
async function check(name,action) {
  try {const evidence=await action();report.checks.push({name,passed:true,evidence});}
  catch(error) {report.checks.push({name,passed:false,message:error.message});}
  await save();
}
const expense=await readJson(join(packages,'expense-1/package/manifest.json'));
const expenseReference=join(host,'suite/supported/expense-1/reference');
let changedExpense;
await check('parameter changes preserve image and generated source, and change rules commitment',async()=>{
  const plan=await readJson(join(host,'suite/supported/expense-1/plan.json'));
  plan.rules[3].right.value=String(BigInt(plan.rules[3].right.value)+1n);
  const planPath=join(output,'parameter-plan.json');await writeJson(planPath,plan);
  changedExpense=requireSuccess(runEngine(engine,['compile','--plan',planPath,'--reference',expenseReference,'--out',join(output,'parameter-package')],{timeout:30*60*1000}));
  for(const key of ['structureHash','imageId','referenceHash','guestSha256'])assert.equal(expense[key],changedExpense[key]);
  assert.notEqual(expense.rulesHash,changedExpense.rulesHash);
  assert.deepEqual(await readFile(join(packages,'expense-1/package/source/src/generated.rs')),
    await readFile(join(output,'parameter-package/source/src/generated.rs')));
  return {imageId:expense.imageId,originalRulesHash:expense.rulesHash,changedRulesHash:changedExpense.rulesHash,cacheHit:changedExpense.cacheHit};
});
await check('changed rules cannot execute against the original synthetic funded terms',async()=>{
  const actual=runEngine(engine,['execute','--package',join(output,'parameter-package'),'--job',join(packages,'expense-1/job.json'),
    '--deliverables',join(host,'suite/supported/expense-1/candidates/valid/delivery'),'--reference',expenseReference]);
  assert.equal(actual.exitCode,2);assert.equal(actual.value?.code,'job_mismatch');return actual;
});
const ledger=await readJson(join(packages,'ledger-1/package/manifest.json'));
const ledgerReference=join(host,'suite/supported/ledger-1/reference'),changedReference=join(output,'changed-reference');
await cp(ledgerReference,changedReference,{recursive:true});
const ledgerData=await readJson(join(changedReference,'ledger.json'));
ledgerData.rows[0].amountCents=String(BigInt(ledgerData.rows[0].amountCents)+1n);
await writeJson(join(changedReference,'ledger.json'),ledgerData);
await check('reference changes preserve image and rules, and change reference commitment',async()=>{
  const actual=requireSuccess(runEngine(engine,['compile','--plan',join(host,'suite/supported/ledger-1/plan.json'),'--reference',changedReference,'--out',join(output,'reference-package')],{timeout:30*60*1000}));
  for(const key of ['structureHash','imageId','rulesHash','guestSha256'])assert.equal(ledger[key],actual[key]);
  assert.notEqual(ledger.referenceHash,actual.referenceHash);
  return {imageId:ledger.imageId,originalReferenceHash:ledger.referenceHash,changedReferenceHash:actual.referenceHash,cacheHit:actual.cacheHit};
});
for(const packageName of [join(packages,'ledger-1/package'),join(output,'reference-package')]) {
  await check('changed reference or package cannot execute against original terms: '+(packageName.endsWith('reference-package')?'changed-package':'original-package'),async()=>{
    const actual=runEngine(engine,['execute','--package',packageName,'--job',join(packages,'ledger-1/job.json'),
      '--deliverables',join(host,'suite/supported/ledger-1/candidates/valid/delivery'),'--reference',changedReference]);
    assert.equal(actual.exitCode,2);assert.equal(actual.value?.code,'job_mismatch');return actual;
  });
}
await check('rule shape changes alter structure and rules commitments',async()=>{
  const plan=await readJson(join(host,'suite/supported/expense-1/plan.json'));plan.rules[3].op='lt';
  const path=join(output,'shape-plan.json');await writeJson(path,plan);
  const actual=requireSuccess(runEngine(engine,['validate','--plan',path]));
  assert.notEqual(expense.structureHash,actual.structureHash);assert.notEqual(expense.rulesHash,actual.rulesHash);
  return {originalStructureHash:expense.structureHash,changedStructureHash:actual.structureHash};
});
report.summary={checks:report.checks.length,failures:report.checks.filter(x=>!x.passed).length};
await save();console.log(JSON.stringify(report.summary));if(report.summary.failures)process.exitCode=1;
