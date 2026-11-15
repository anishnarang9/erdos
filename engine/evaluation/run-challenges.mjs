import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeChallengeSuite, writeCandidateEvidence} from './generate-challenges.mjs';
import {evaluateCandidate} from './reference-oracle.mjs';
import {candidateFingerprint,sameExpectation} from './artifacts.mjs';

export const sha256 = bytes => '0x'+createHash('sha256').update(bytes).digest('hex');
export const readJson = async path => JSON.parse(await readFile(path,'utf8'));
export const writeJson = async (path,value) => writeFile(path,JSON.stringify(value,null,2)+'\n');

// This encoder is independent from the engine. It implements the published wire format.
export async function encodeDirectory(directory) {
  const names=(await readdir(directory)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const header=Buffer.alloc(3); header[0]=1; header.writeUInt16BE(names.length,1);
  const chunks=[header];
  for(const name of names) {
    const bytes=await readFile(join(directory,name)), filename=Buffer.from(name);
    const nameLength=Buffer.alloc(2), byteLength=Buffer.alloc(4);
    nameLength.writeUInt16BE(filename.length); byteLength.writeUInt32BE(bytes.length);
    chunks.push(nameLength,filename,byteLength,bytes);
  }
  return Buffer.concat(chunks);
}

export function syntheticJob(manifest,jobId=1000) {
  const uint=n=>BigInt(n).toString(16).padStart(64,'0');
  return {context:'0x01'+uint(5042002)+'11'.repeat(20)+uint(jobId)+'22'.repeat(20)
    +manifest.rulesHash.slice(2)+manifest.referenceHash.slice(2),imageId:manifest.imageId??'0x'+'00'.repeat(32)};
}

export function runEngine(engine,args,{timeout=120000}={}) {
  const start=performance.now();
  const result=spawnSync(engine,args,{encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  let value=null;
  try {value=JSON.parse(result.status===0?result.stdout:result.stderr);} catch {}
  return {exitCode:result.status,signal:result.signal,error:result.error?.message??null,
    value,millis:Math.round(performance.now()-start),
    ...(value===null?{stdout:result.stdout?.slice(-4000),stderr:result.stderr?.slice(-4000)}:{})};
}

export const classifyEvaluation=result=>result.exitCode===0?(result.value?.verdict===1?'pass':result.value?.verdict===0?'fail':'invalid_result')
  :result.exitCode===2&&['invalid_deliverable','bundle_input'].includes(result.value?.code)?'reject':'engine_failure';

export async function runChallenges({engine,output}) {
  engine=resolve(engine); output=resolve(output);
  await mkdir(output,{recursive:true});
  const suite=await writeChallengeSuite(join(output,'suite'));
  const report={version:1,startedAt:new Date().toISOString(),syntheticJobs:true,simulatedApproval:true,
    engineSha256:sha256(await readFile(engine)),counts:suite.counts,
    modelTrials:0,ambiguous:'Not sent to a model. Expected clarification labels only.',
    oracle:'Independent domain functions read actual candidate files. Engine results do not supply expected answers.',
    suiteSha256:sha256(await readFile(join(output,'suite/suite.json'))),artifacts:{},
    shapes:{},coverage:{families:{},operations:{},outcomes:{}},validations:[],candidates:[],failures:[]};
  let jobId=1000;
  for(const challenge of suite.challenges) {
    if(challenge.classification==='ambiguous') continue;
    if(challenge.classification==='unsupported') {
      const validation=runEngine(engine,['validate','--plan',join(output,'suite',challenge.draftPath)]);
      const expected=challenge.capabilityRequests[0];
      const matched=validation.exitCode===2&&validation.value?.code==='unsupported_capability'
        &&validation.value?.request?.kind===expected.kind&&validation.value?.request?.name===expected.name;
      report.validations.push({id:challenge.id,classification:'unsupported',matched,...validation});
      if(!matched)report.failures.push({id:challenge.id,kind:'unsupported_classification',expected,actual:validation});
      continue;
    }
    const planPath=join(output,'suite',challenge.planPath),reference=join(output,'suite',challenge.referencePath);
    const validation=runEngine(engine,['validate','--plan',planPath]);
    report.validations.push({id:challenge.id,classification:'supported',matched:validation.exitCode===0,...validation});
    if(validation.exitCode!==0) {report.failures.push({id:challenge.id,kind:'plan_validation',actual:validation});continue;}
    const validated=validation.value;
    (report.shapes[validated.structureHash]??=[]).push(challenge.id);
    report.coverage.families[challenge.family]=(report.coverage.families[challenge.family]??0)+1;
    for(const op of challenge.supportedOperations)report.coverage.operations[op]=(report.coverage.operations[op]??0)+1;
    const referenceHash=sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'),await encodeDirectory(reference)]));
    const job=syntheticJob({rulesHash:validated.rulesHash,referenceHash},jobId++);
    const jobPath=join(output,'suite','supported',challenge.id,'job.json');
    await writeJson(jobPath,job);
    for(const candidate of challenge.candidates) {
      const directory=join(output,'suite',candidate.path);
      await writeCandidateEvidence(challenge,candidate,directory,job.context);
      const expected=await evaluateCandidate(challenge,directory,{referenceDirectory:reference,contextHex:job.context});
      const oracleMatched=sameExpectation(candidate.expected,expected);
      report.artifacts[challenge.id+'/'+candidate.id]=await candidateFingerprint(directory,job.context);
      const args=['eval','--plan',planPath,'--deliverables',join(directory,'delivery'),'--reference',reference,'--job',jobPath];
      if(challenge.plan.evidence?.length)args.push('--evidence',join(directory,'evidence'));
      const actual=runEngine(engine,args), actualStatus=classifyEvaluation(actual), matched=oracleMatched&&actualStatus===expected.status;
      report.coverage.outcomes[actualStatus]=(report.coverage.outcomes[actualStatus]??0)+1;
      report.candidates.push({challenge:challenge.id,id:candidate.id,expected,actualStatus,oracleMatched,matched,...actual});
      if(!matched) report.failures.push({id:challenge.id,candidate:candidate.id,
        kind:!oracleMatched?'independent_oracle_disagreement':actualStatus==='engine_failure'?'engine_failure':'evaluator_disagreement',expected,actual});
    }
    await writeJson(join(output,'host-report.json'),report);
  }
  report.finishedAt=new Date().toISOString();
  report.summary={challenges:suite.challenges.length,supportedPlans:report.validations.filter(x=>x.classification==='supported').length,
    unsupportedPlans:report.validations.filter(x=>x.classification==='unsupported').length,
    candidateCases:report.candidates.length,distinctStructures:Object.keys(report.shapes).length,failures:report.failures.length};
  await writeJson(join(output,'host-report.json'),report);
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [engine,output]=process.argv.slice(2);
  if(!engine||!output||process.argv.length!==4)throw Error('Use node run-challenges.mjs ENGINE OUTPUT_DIRECTORY');
  const report=await runChallenges({engine,output});
  console.log(JSON.stringify(report.summary));
  if(report.failures.length)process.exitCode=1;
}
