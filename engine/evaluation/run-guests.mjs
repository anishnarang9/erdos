import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {sha256,readJson,writeJson,runEngine,syntheticJob,classifyEvaluation} from './run-challenges.mjs';
import {writeCandidateEvidence} from './generate-challenges.mjs';
import {evaluateCandidate} from './reference-oracle.mjs';
import {auditedCandidate} from './artifacts.mjs';

const [engineArg,hostArg,outArg]=process.argv.slice(2);
if(!engineArg||!hostArg||!outArg||process.argv.length!==5)
  throw Error('Use node run-guests.mjs ENGINE HOST_RUN_DIRECTORY NEW_GUEST_OUTPUT');
const engine=resolve(engineArg),host=resolve(hostArg),output=resolve(outArg);
if(process.env.RUST_LOG!==undefined||process.env.RISC0_DEV_MODE!==undefined)
  throw Error('Unset RUST_LOG and RISC0_DEV_MODE before actual guest execution');
const hostReport=await readJson(join(host,'host-report.json'));
if(hostReport.summary?.failures!==0||hostReport.summary?.candidateCases!==341)
  throw Error('Complete the independent host challenge check first');
const engineSha256=sha256(await readFile(engine));
if(engineSha256!==hostReport.engineSha256)throw Error('Engine binary differs from the host check. Rerun phase 1.');
if(hostReport.suiteSha256!==sha256(await readFile(join(host,'suite/suite.json'))))
  throw Error('Suite differs from the audited host report. Rerun phase 1.');
await mkdir(output,{mode:0o700});
const suite=await readJson(join(host,'suite/suite.json'));
const report={version:1,startedAt:new Date().toISOString(),syntheticJobs:true,simulatedApproval:true,
  engineSha256,sourceSuiteSha256:sha256(await readFile(join(host,'suite/suite.json'))),
  compilations:[],executions:[],imagesByStructure:{},failures:[]};
const save=()=>writeJson(join(output,'guest-report.json'),report);
let jobId=1000;
for(const challenge of suite.challenges.filter(c=>c.classification==='supported')) {
  const caseRoot=join(output,challenge.id),plan=join(host,'suite',challenge.planPath),reference=join(host,'suite',challenge.referencePath);
  await mkdir(caseRoot);
  const packagePath=join(caseRoot,'package');
  const compiled=runEngine(engine,['compile','--plan',plan,'--reference',reference,'--out',packagePath],{timeout:30*60*1000});
  const entry={challenge:challenge.id,family:challenge.family,...compiled};
  report.compilations.push(entry);
  if(compiled.exitCode!==0) {
    report.failures.push({challenge:challenge.id,kind:'compilation',actual:compiled});
    await save();continue;
  }
  const manifest=await readJson(join(packagePath,'manifest.json'));
  const expected=hostReport.validations.find(v=>v.id===challenge.id).value;
  if(manifest.rulesHash!==expected.rulesHash||manifest.structureHash!==expected.structureHash)
    report.failures.push({challenge:challenge.id,kind:'commitment_mismatch',manifest,expected});
  const images=report.imagesByStructure[manifest.structureHash]??=[];
  if(images.some(x=>x.imageId!==manifest.imageId))report.failures.push({challenge:challenge.id,kind:'parameter_edit_changed_image',images,manifest});
  images.push({challenge:challenge.id,imageId:manifest.imageId,rulesHash:manifest.rulesHash,referenceHash:manifest.referenceHash});
  const job=syntheticJob(manifest,jobId++),jobPath=join(caseRoot,'job.json');
  await writeJson(jobPath,job);
  await save();
  for(const candidate of challenge.candidates) {
    const directory=join(host,'suite',candidate.path);
    await writeCandidateEvidence(challenge,candidate,directory,job.context);
    const expected=await evaluateCandidate(challenge,directory,{referenceDirectory:reference,contextHex:job.context});
    if(!await auditedCandidate(hostReport,challenge,candidate,directory,job.context,expected))
      throw Error(`Candidate differs from its audited expectation: ${challenge.id}/${candidate.id}`);
    const args=['execute','--package',packagePath,'--job',jobPath,'--deliverables',join(directory,'delivery'),'--reference',reference];
    if(challenge.plan.evidence?.length)args.push('--evidence',join(directory,'evidence'));
    const actual=runEngine(engine,args),status=classifyEvaluation(actual),matched=status===expected.status;
    const record={challenge:challenge.id,id:candidate.id,expectedStatus:expected.status,actualStatus:status,matched,
      guestExecuted:actual.exitCode===0&&Number.isSafeInteger(actual.value?.userCycles)&&actual.value.userCycles>0,...actual};
    if(expected.status!=='reject'&&!record.guestExecuted)record.matched=false;
    report.executions.push(record);
    if(!record.matched)report.failures.push({challenge:challenge.id,candidate:candidate.id,kind:'guest_disagreement',expected,actual});
    await save();
  }
  console.log(JSON.stringify({challenge:challenge.id,compiled:true,cacheHit:compiled.value.cacheHit,
    candidates:challenge.candidates.length,failures:report.failures.length}));
}
report.finishedAt=new Date().toISOString();
report.summary={compiledPlans:report.compilations.filter(x=>x.exitCode===0).length,
  distinctStructures:Object.keys(report.imagesByStructure).length,
  distinctImages:new Set(Object.values(report.imagesByStructure).flat().map(x=>x.imageId)).size,
  guestExecutions:report.executions.filter(x=>x.guestExecuted).length,
  inputRejectionsBeforeGuest:report.executions.filter(x=>x.actualStatus==='reject').length,
  candidateCases:report.executions.length,failures:report.failures.length};
await save();console.log(JSON.stringify(report.summary));
if(report.failures.length)process.exitCode=1;
