// Execute prepared packages without repeating their Docker builds.
import {cp,mkdir,readFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readJson,writeJson,sha256,runEngine,classifyEvaluation,syntheticJob} from './run-challenges.mjs';
import {writeCandidateEvidence} from './generate-challenges.mjs';
import {evaluateCandidate} from './reference-oracle.mjs';
import {auditedCandidate} from './artifacts.mjs';

const [engineArg,hostArg,packagesArg,outArg,preparerPid]=process.argv.slice(2);
if(!engineArg||!hostArg||!packagesArg||!outArg)
  throw Error('Use node execute-packages.mjs ENGINE HOST_RUN PACKAGES NEW_OUTPUT [LIVE_PREPARER_PID]');
if(process.env.RUST_LOG!==undefined||process.env.RISC0_DEV_MODE!==undefined)
  throw Error('Unset RUST_LOG and RISC0_DEV_MODE before actual guest execution');
const engine=resolve(engineArg),host=resolve(hostArg),packages=resolve(packagesArg),output=resolve(outArg);
const hostReport=await readJson(join(host,'host-report.json'));
const engineSha256=sha256(await readFile(engine));
if(hostReport.summary?.failures!==0||hostReport.engineSha256!==engineSha256)
  throw Error('A passing host report for this exact binary is required');
const suite=await readJson(join(host,'suite/suite.json'));
if(hostReport.suiteSha256!==sha256(await readFile(join(host,'suite/suite.json'))))
  throw Error('Suite differs from the audited host report. Rerun phase 1.');
await mkdir(output,{mode:0o700});
const report={version:1,startedAt:new Date().toISOString(),syntheticJobs:true,engineSha256,
  hostReportSha256:sha256(await readFile(join(host,'host-report.json'))),
  packages:[],executions:[],imagesByStructure:{},failures:[]};
const save=()=>writeJson(join(output,'execution-report.json'),report);
let jobId=1000;
for(const challenge of suite.challenges.filter(c=>c.classification==='supported')) {
  const packagePath=join(packages,challenge.id,'package'),manifestPath=join(packagePath,'manifest.json');
  const started=Date.now();
  while(true) {
    try {await stat(manifestPath);break;} catch(error) {
      if(error.code!=='ENOENT')throw error;
      if(!preparerPid)throw Error(`Package is missing: ${challenge.id}`);
      try {process.kill(Number(preparerPid),0);} catch {throw Error(`Package preparer stopped before ${challenge.id}`);}
      if(Date.now()-started>30*60*1000)throw Error(`Package wait exceeded 30 minutes: ${challenge.id}`);
      await delay(3000);
    }
  }
  const manifest=await readJson(manifestPath),expected=hostReport.validations.find(v=>v.id===challenge.id).value;
  const guestSha256=sha256(await readFile(join(packagePath,'guest.elf')));
  if(manifest.structureHash!==expected.structureHash||manifest.rulesHash!==expected.rulesHash||manifest.guestSha256!==guestSha256)
    throw Error(`Package commitments differ for ${challenge.id}`);
  const group=report.imagesByStructure[manifest.structureHash]??=[];
  if(group.some(p=>p.imageId!==manifest.imageId))report.failures.push({challenge:challenge.id,kind:'parameter_edit_changed_image'});
  group.push({challenge:challenge.id,imageId:manifest.imageId,rulesHash:manifest.rulesHash,referenceHash:manifest.referenceHash});
  report.packages.push({challenge:challenge.id,family:challenge.family,...manifest});
  const caseRoot=join(output,challenge.id);await mkdir(caseRoot);
  const job=syntheticJob(manifest,jobId++),jobPath=join(caseRoot,'job.json');await writeJson(jobPath,job);
  const reference=join(host,'suite',challenge.referencePath);
  for(const candidate of challenge.candidates) {
    const directory=join(caseRoot,candidate.id);await cp(join(host,'suite',candidate.path),directory,{recursive:true});
    await writeCandidateEvidence(challenge,candidate,directory,job.context);
    const expected=await evaluateCandidate(challenge,directory,{referenceDirectory:reference,contextHex:job.context});
    if(!await auditedCandidate(hostReport,challenge,candidate,directory,job.context,expected))
      throw Error(`Candidate differs from its audited expectation: ${challenge.id}/${candidate.id}`);
    const args=['execute','--package',packagePath,'--job',jobPath,'--deliverables',join(directory,'delivery'),'--reference',reference];
    if(challenge.plan.evidence?.length)args.push('--evidence',join(directory,'evidence'));
    const actual=runEngine(engine,args),status=classifyEvaluation(actual);
    const guestExecuted=actual.exitCode===0&&Number.isSafeInteger(actual.value?.userCycles)&&actual.value.userCycles>0;
    const matched=status===expected.status&&(expected.status==='reject'||guestExecuted);
    report.executions.push({challenge:challenge.id,id:candidate.id,expectedStatus:expected.status,actualStatus:status,
      guestExecuted,matched,...actual});
    if(!matched)report.failures.push({challenge:challenge.id,candidate:candidate.id,kind:'guest_disagreement',expected,actual});
    await save();
  }
  console.log(JSON.stringify({challenge:challenge.id,candidates:challenge.candidates.length,failures:report.failures.length}));
}
report.finishedAt=new Date().toISOString();
report.summary={compiledPlans:report.packages.length,distinctStructures:Object.keys(report.imagesByStructure).length,
  distinctImages:new Set(report.packages.map(x=>x.imageId)).size,
  actualGuestExecutions:report.executions.filter(x=>x.guestExecuted).length,
  inputRejectionsBeforeGuest:report.executions.filter(x=>x.actualStatus==='reject').length,
  candidateCases:report.executions.length,failures:report.failures.length};
await save();console.log(JSON.stringify(report.summary));
if(report.failures.length)process.exitCode=1;
