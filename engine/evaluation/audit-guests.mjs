import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readJson,writeJson,sha256,encodeDirectory} from './run-challenges.mjs';
import {auditedCandidate} from './artifacts.mjs';
import {evaluateCandidate} from './reference-oracle.mjs';

const [hostArg,executionArg,outputArg]=process.argv.slice(2);
if(!hostArg||!executionArg||!outputArg)throw Error('Use node audit-guests.mjs BOUND_HOST_RUN COMPLETED_EXECUTION_RUN REPORT_JSON');
const host=resolve(hostArg),execution=resolve(executionArg),output=resolve(outputArg);
const hostReport=await readJson(join(host,'host-report.json')),guestReport=await readJson(join(execution,'execution-report.json'));
assert.equal(hostReport.summary?.failures,0);assert.equal(guestReport.summary?.failures,0);
assert.equal(hostReport.engineSha256,guestReport.engineSha256);
assert.equal(hostReport.suiteSha256,sha256(await readFile(join(host,'suite/suite.json'))));
assert.equal(hostReport.summary.candidateCases,341);assert.equal(guestReport.summary.candidateCases,341);
const suite=await readJson(join(host,'suite/suite.json'));
const report={version:1,hostReportSha256:sha256(await readFile(join(host,'host-report.json'))),
  executionReportSha256:sha256(await readFile(join(execution,'execution-report.json'))),
  engineSha256:hostReport.engineSha256,checks:[],failures:[]};
for(const challenge of suite.challenges.filter(c=>c.classification==='supported')) {
  const job=await readJson(join(execution,challenge.id,'job.json'));
  const hostJob=await readJson(join(host,'suite/supported',challenge.id,'job.json'));
  const manifest=guestReport.packages.find(p=>p.challenge===challenge.id);
  const reference=join(host,'suite',challenge.referencePath);
  const referenceHash=sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'),await encodeDirectory(reference)]));
  assert.equal(job.context,hostJob.context);
  assert.equal(manifest.referenceHash,referenceHash);
  assert.equal(manifest.imageId,job.imageId);
  for(const candidate of challenge.candidates) {
    const directory=join(execution,challenge.id,candidate.id);
    const expected=await evaluateCandidate(challenge,directory,{referenceDirectory:reference,contextHex:job.context});
    const row=guestReport.executions.find(r=>r.challenge===challenge.id&&r.id===candidate.id);
    const matches=await auditedCandidate(hostReport,challenge,candidate,directory,job.context,expected);
    const verdictMatches=row?.actualStatus===expected.status&&row?.matched===true
      &&(expected.status==='reject'||row.guestExecuted===true&&row.value?.verdict===expected.verdict);
    const passed=matches&&verdictMatches;
    report.checks.push({challenge:challenge.id,id:candidate.id,artifactAndExpectationMatched:matches,executionMatched:verdictMatches,passed});
    if(!passed)report.failures.push({challenge:challenge.id,id:candidate.id,expected,row,artifactMatched:matches});
  }
}
report.summary={candidateChecks:report.checks.length,failures:report.failures.length,
  actualGuestExecutions:guestReport.summary.actualGuestExecutions,inputRejectionsBeforeGuest:guestReport.summary.inputRejectionsBeforeGuest,
  distinctStructures:guestReport.summary.distinctStructures,distinctImages:guestReport.summary.distinctImages};
await writeJson(output,report);console.log(JSON.stringify(report.summary));if(report.failures.length)process.exitCode=1;
