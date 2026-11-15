import assert from 'node:assert/strict';
import {cp,mkdir,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {LocalEngineAdapter} from './engine-adapter.ts';
import {RecordedDraftModel} from './recorded-draft-model.ts';
import {makeAuthoringInputs} from './authoring-inputs.mjs';
import {writeCandidateEvidence} from './generate-challenges.mjs';
import {evaluateCandidate} from './reference-oracle.mjs';
import {mismatchKind,policyDiagnostics} from './semantic-checks.mjs';
import {readJson,writeJson,sha256,encodeDirectory,syntheticJob} from './run-challenges.mjs';

const [engineArg,hostArg,recordsArg,outArg]=process.argv.slice(2);
if(!engineArg||!hostArg||!recordsArg||!outArg)throw Error('Use node --experimental-transform-types run-authoring.mjs ENGINE HOST_RUN MODEL_RECORDS NEW_OUTPUT');
const engine=resolve(engineArg),host=resolve(hostArg),records=resolve(recordsArg),output=resolve(outArg);
await mkdir(output,{mode:0o700});
const hostReport=await readJson(join(host,'host-report.json'));
assert.equal(hostReport.summary?.failures,0);assert.equal(hostReport.engineSha256,sha256(await readFile(engine)));
const suite=await readJson(join(host,'suite/suite.json')),provenance=await readJson(join(records,'provenance.json'));
const adapter=new LocalEngineAdapter({binary:engine,packagesDirectory:join(output,'packages')});
const bundle=async directory=>Promise.all((await readdir(directory)).sort().map(async name=>({name,content:await readFile(join(directory,name))})));
const report={version:1,startedAt:new Date().toISOString(),engineSha256:hostReport.engineSha256,
  sourceSuiteSha256:hostReport.suiteSha256,model:'gpt-6-luna',reasoningEffort:'low',syntheticJobs:true,simulatedApproval:true,
  samplingUnit:provenance.samplingUnit,independence:provenance.independence,isolation:provenance.isolation,
  usage:null,usageNote:provenance.usageNote,
  criterion:'Independent positive and isolated negative examples, plus a conservative public-constant and trust-key screen. This does not prove full natural-language equivalence.',
  trials:[],selectedProofCases:[],failures:[]};
const save=()=>writeJson(join(output,'authoring-report.json'),report);
let jobId=2000;
for(let trial=1;trial<=3;trial++) {
  const inputPath=join(records,`trial-${trial}.inputs.json`),firstPath=join(records,`trial-${trial}.first.json`);
  const p=provenance.batches.find(b=>b.trial===trial);
  assert.equal(sha256(await readFile(inputPath)).slice(2),p.inputSha256);
  assert.equal(sha256(await readFile(firstPath)).slice(2),p.outputSha256);
  assert.equal(sha256(await readFile(join(records,'authoring-schema.json'))).slice(2),p.schemaSha256);
  const inputs=await readJson(inputPath),first=await readJson(firstPath);
  const regenerated=await makeAuthoringInputs(join(host,'suite'),trial);
  assert.deepEqual(inputs.requests,regenerated.requests,'Public authoring inputs changed');
  assert.equal(first.trial,trial);assert.equal(first.results.length,60);
  const firstModel=new RecordedDraftModel({model:p.model,tracePrefix:p.taskName+'/first',inputs:inputs.requests,results:first.results});
  let repairFile=null;
  try{repairFile=await readJson(join(records,`trial-${trial}.repair.json`));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(repairFile)assert.equal(repairFile.trial,trial);
  const repairIds=new Set(repairFile?.results.map(row=>row.requestId)??[]);
  const repairModel=repairFile?new RecordedDraftModel({model:p.model,tracePrefix:p.taskName+'/repair',
    inputs:inputs.requests.filter(row=>repairIds.has(row.requestId)),results:repairFile.results}):null;
  const trialReport={trial,requests:[],firstOutputSha256:sha256(await readFile(firstPath)),
    repairOutputSha256:repairFile?sha256(await readFile(join(records,`trial-${trial}.repair.json`))):null};
  report.trials.push(trialReport);
  for(const request of inputs.requests) {
    const challenge=suite.challenges.find(c=>c.id===regenerated.index[request.requestId]);
    assert.ok(challenge);
    const requestReport={requestId:request.requestId,challenge:challenge.id,family:challenge.family,
      expectedClassification:challenge.classification,attempts:[]};trialReport.requests.push(requestReport);
    const firstDraft=await firstModel.draft(request.input);
    async function score(draftRecord,attempt) {
      const result=draftRecord.result,expectedKind={supported:'draft',ambiguous:'clarification',unsupported:'unsupported'}[challenge.classification];
      const scored={attempt,traceId:draftRecord.traceId,kind:result.kind,classificationMatched:result.kind===expectedKind,
        model:p.model,validation:null,candidates:[],mismatches:[],coveragePassed:false};
      if(result.kind!=='draft') {
        scored.coveragePassed=scored.classificationMatched;
        return scored;
      }
      const validation=await adapter.validate(result.plan);scored.validation=validation;
      if(!validation.ok)return scored;
      const revalidated=await adapter.validate(validation.report.preview);
      assert.ok(revalidated.ok);assert.equal(revalidated.report.rulesHash,validation.report.rulesHash);
      assert.equal(revalidated.report.structureHash,validation.report.structureHash);
      scored.approvalHashReproduced=true;
      if(challenge.classification!=='supported')return scored;
      const caseRoot=join(output,`trial-${trial}`,request.requestId,attempt);await mkdir(caseRoot,{recursive:true,mode:0o700});
      const planPath=join(caseRoot,'approved-plan.json');await writeJson(planPath,validation.report.preview);
      const referenceDirectory=join(host,'suite',challenge.referencePath),reference=await bundle(referenceDirectory);
      scored.policyDiagnostics=policyDiagnostics(validation.report.preview,request.input,reference);
      scored.sourceQuoteIssues=(result.sourceQuotes??[]).filter(q=>!request.input.request.includes(q.quote));
      const referenceHash=sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'),await encodeDirectory(referenceDirectory)]));
      const job=syntheticJob({rulesHash:validation.report.rulesHash,referenceHash},jobId++);
      await writeJson(join(caseRoot,'job.json'),job);
      for(const candidate of challenge.candidates) {
        const directory=join(caseRoot,candidate.id);await cp(join(host,'suite',candidate.path),directory,{recursive:true});
        await writeCandidateEvidence(challenge,candidate,directory,job.context);
        const expected=await evaluateCandidate(challenge,directory,{referenceDirectory,contextHex:job.context});
        const actual=await adapter.evaluate({plan:validation.report.preview,deliverables:await bundle(join(directory,'delivery')),
          reference,...(challenge.plan.evidence?.length?{evidence:await bundle(join(directory,'evidence'))}:{}),job});
        const actualStatus=actual.ok?(actual.verdict===1?'pass':'fail'):actual.kind==='invalid'?'reject':'unsupported';
        const mismatch=mismatchKind(expected.status,actualStatus);
        const row={candidate:candidate.id,expected:expected.status,actual:actualStatus,matched:mismatch===null,
          requirementIds:expected.violatedRequirements,...(mismatch?{kind:mismatch}:{})};
        scored.candidates.push(row);if(mismatch)scored.mismatches.push(row);
      }
      scored.coveragePassed=scored.classificationMatched&&scored.mismatches.length===0
        &&scored.policyDiagnostics.unprovenConstants.length===0&&scored.policyDiagnostics.unapprovedTrustKeys.length===0;
      scored.planPath=planPath;scored.caseRoot=caseRoot;
      return scored;
    }
    const firstScore=await score(firstDraft,'first');requestReport.attempts.push(firstScore);
    let final=firstScore;
    if(repairIds.has(request.requestId)) {
      assert.ok(firstScore.validation?.ok===false,'A validation repair was attempted without a validation failure');
      final=await score(await repairModel.draft(request.input),'repair');requestReport.attempts.push(final);
    }
    requestReport.finalCoveragePassed=final.coveragePassed;
    if(challenge.classification==='supported'&&final.coveragePassed&&!report.selectedProofCases.some(c=>c.family===challenge.family)) {
      report.selectedProofCases.push({family:challenge.family,challenge:challenge.id,trial,attempt:final.attempt,
        requestId:request.requestId,approvedPlanPath:final.planPath,caseRoot:final.caseRoot,
        referenceDirectory:join(host,'suite',challenge.referencePath),
        passCandidate:challenge.candidates.find(c=>c.expected.status==='pass').id,
        failCandidate:challenge.candidates.find(c=>c.expected.status==='fail').id});
    }
    await save();
  }
  const rows=trialReport.requests,attempts=rows.flatMap(r=>r.attempts);
  trialReport.summary={requests:rows.length,classificationMatched:rows.filter(r=>r.attempts[0].classificationMatched).length,
    firstDraftsValid:rows.filter(r=>r.attempts[0].validation?.ok).length,
    firstCoveragePassed:rows.filter(r=>r.attempts[0].coveragePassed).length,
    repairAttempts:attempts.filter(a=>a.attempt==='repair').length,
    finalCoveragePassed:rows.filter(r=>r.finalCoveragePassed).length,
    candidateChecks:attempts.reduce((n,a)=>n+a.candidates.length,0),
    semanticMismatches:attempts.reduce((n,a)=>n+a.mismatches.length,0)};
  console.log(JSON.stringify({trial,...trialReport.summary}));await save();
}
report.finishedAt=new Date().toISOString();
const rows=report.trials.flatMap(t=>t.requests),attempts=rows.flatMap(r=>r.attempts);
report.summary={firstTrialResults:rows.length,repairAttempts:attempts.filter(a=>a.attempt==='repair').length,
  firstDraftsValid:rows.filter(r=>r.attempts[0].validation?.ok).length,
  firstCoveragePassed:rows.filter(r=>r.attempts[0].coveragePassed).length,
  finalCoveragePassed:rows.filter(r=>r.finalCoveragePassed).length,
  candidateChecks:attempts.reduce((n,a)=>n+a.candidates.length,0),semanticMismatches:attempts.reduce((n,a)=>n+a.mismatches.length,0),
  selectedFamilies:report.selectedProofCases.length};
await save();await writeJson(join(output,'proof-selection.json'),{suiteDirectory:join(host,'suite'),cases:report.selectedProofCases});
console.log(JSON.stringify(report.summary));
