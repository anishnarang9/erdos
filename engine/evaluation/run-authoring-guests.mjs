import assert from 'node:assert/strict';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {LocalEngineAdapter} from './engine-adapter.ts';
import {candidateFingerprint} from './artifacts.mjs';
import {evaluateCandidate} from './reference-oracle.mjs';
import {readJson,writeJson,sha256,runEngine,classifyEvaluation} from './run-challenges.mjs';

const [engineArg,authoringArg,suiteArg,outArg]=process.argv.slice(2);
if(!engineArg||!authoringArg||!suiteArg||!outArg)throw Error('Use node --experimental-transform-types run-authoring-guests.mjs ENGINE AUTHORING_RUN AUDITED_SUITE NEW_OUTPUT');
if(process.env.RUST_LOG!==undefined||process.env.RISC0_DEV_MODE!==undefined)throw Error('Unset RUST_LOG and RISC0_DEV_MODE');
const engine=resolve(engineArg),authoring=resolve(authoringArg),suiteDirectory=resolve(suiteArg),output=resolve(outArg);
const source=await readJson(join(authoring,'authoring-report.json')),suite=await readJson(join(suiteDirectory,'suite.json'));
assert.equal(source.engineSha256,sha256(await readFile(engine)));assert.ok(source.finishedAt);
const structures=new Map();
for(const trial of source.trials)for(const request of trial.requests)for(const attempt of request.attempts)
  if(attempt.kind==='draft'&&attempt.coveragePassed&&!structures.has(attempt.validation.report.structureHash))
    structures.set(attempt.validation.report.structureHash,{trial:trial.trial,request,attempt});
await mkdir(output,{mode:0o700});
const adapter=new LocalEngineAdapter({binary:engine,packagesDirectory:join(output,'packages')});
const bundle=async directory=>Promise.all((await readdir(directory)).sort().map(async name=>({name,content:await readFile(join(directory,name))})));
const report={version:1,startedAt:new Date().toISOString(),engineSha256:source.engineSha256,
  authoringReportSha256:sha256(await readFile(join(authoring,'authoring-report.json'))),
  acceptedDefinition:'Every distinct structure of a draft passing independent candidate and public-constant checks. Approval is simulated.',
  structures:[],failures:[]};
const save=()=>writeJson(join(output,'authoring-guests.json'),report);
for(const [structureHash,{trial,request,attempt}] of structures) {
  const challenge=suite.challenges.find(c=>c.id===request.challenge),referenceDirectory=join(suiteDirectory,challenge.referencePath);
  const reference=await bundle(referenceDirectory),plan=await readJson(attempt.planPath);
  const compiled=await adapter.compile({plan,reference});assert.ok(compiled.ok,JSON.stringify(compiled));
  assert.equal(compiled.engineManifest.structureHash,structureHash);
  assert.equal(compiled.engineManifest.rulesHash,attempt.validation.report.rulesHash);
  const job=await readJson(join(attempt.caseRoot,'job.json'));job.imageId=compiled.engineManifest.imageId;
  assert.equal(compiled.engineManifest.referenceHash,'0x'+job.context.slice(-64));
  const caseRoot=join(output,structureHash.slice(2));await mkdir(caseRoot);
  const jobPath=join(caseRoot,'job.json');await writeJson(jobPath,job);
  const entry={structureHash,imageId:compiled.engineManifest.imageId,trial,challenge:challenge.id,
    packagePath:compiled.packagePath,compileReport:compiled.compileReport,executions:[]};report.structures.push(entry);await save();
  for(const candidate of challenge.candidates) {
    const directory=join(attempt.caseRoot,candidate.id),fingerprint=await candidateFingerprint(directory,job.context);
    const expected=await evaluateCandidate(challenge,directory,{referenceDirectory,contextHex:job.context});
    const recorded=attempt.candidates.find(c=>c.candidate===candidate.id);
    assert.equal(expected.status,recorded.expected);assert.equal(recorded.actual,expected.status);
    const hostResult=await adapter.evaluate({plan,deliverables:await bundle(join(directory,'delivery')),reference,
      ...(challenge.plan.evidence?.length?{evidence:await bundle(join(directory,'evidence'))}:{}),job});
    const hostStatus=hostResult.ok?(hostResult.verdict===1?'pass':'fail'):hostResult.kind==='invalid'?'reject':'unsupported';
    assert.equal(hostStatus,expected.status);
    const args=['execute','--package',compiled.packagePath,'--job',jobPath,'--deliverables',join(directory,'delivery'),'--reference',referenceDirectory];
    if(challenge.plan.evidence?.length)args.push('--evidence',join(directory,'evidence'));
    const actual=runEngine(engine,args),status=classifyEvaluation(actual),identityMatched=fingerprint===await candidateFingerprint(directory,job.context);
    const guestExecuted=actual.exitCode===0&&Number.isSafeInteger(actual.value?.userCycles)&&actual.value.userCycles>0;
    const matched=identityMatched&&status===expected.status&&(expected.status==='reject'||guestExecuted);
    const row={candidate:candidate.id,expected:expected.status,actual:status,fingerprint,identityMatched,guestExecuted,matched,...actual};
    entry.executions.push(row);if(!matched)report.failures.push({structureHash,challenge:challenge.id,...row});await save();
  }
  console.log(JSON.stringify({structureHash,challenge:challenge.id,cacheHit:compiled.compileReport.cacheHit,executions:entry.executions.length,failures:report.failures.length}));
}
report.finishedAt=new Date().toISOString();const all=report.structures.flatMap(s=>s.executions);
report.summary={distinctAcceptedStructures:structures.size,compiledStructures:report.structures.length,
  actualGuestExecutions:all.filter(x=>x.guestExecuted).length,inputRejectionsBeforeGuest:all.filter(x=>x.actual==='reject').length,
  candidateChecks:all.length,failures:report.failures.length};
await save();console.log(JSON.stringify(report.summary));if(report.failures.length)process.exitCode=1;
