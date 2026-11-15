import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildChallenges} from './generate-challenges.mjs';
import {assertAuthoringReplay} from './authoring-replay-gate.mjs';

const original=JSON.parse(readFileSync(new URL('./reports/authoring.json',import.meta.url)));
const suite={challenges:buildChallenges()};
test('published measurements match their explicit known model defects',()=>{
  const expected=JSON.parse(readFileSync(new URL('./authoring-expectations.json',import.meta.url)));
  const summary=assertAuthoringReplay(original,suite,expected.nonDraftFidelityDefects);
  assert.equal(summary.nonDraftFidelityPassed,21);
  assert.equal(summary.nonDraftFidelityDefects,39);
});
function resummarize(report) {
  for(const trial of report.trials) {
    const requests=trial.requests,attempts=requests.flatMap(row=>row.attempts);
    trial.summary={...trial.summary,requests:60,classificationMatched:requests.filter(row=>row.attempts[0].classificationMatched).length,
      firstDraftsValid:requests.filter(row=>row.attempts[0].validation?.ok).length,
      firstCoveragePassed:requests.filter(row=>row.attempts[0].coveragePassed).length,
      repairAttempts:attempts.filter(row=>row.attempt==='repair').length,
      finalCoveragePassed:requests.filter(row=>row.finalCoveragePassed).length,
      candidateChecks:attempts.reduce((n,row)=>n+row.candidates.length,0),
      semanticMismatches:attempts.reduce((n,row)=>n+row.mismatches.length,0)};
  }
  const requests=report.trials.flatMap(trial=>trial.requests),attempts=requests.flatMap(row=>row.attempts);
  const finalNonDraft=requests.filter(row=>row.expectedClassification!=='supported').map(row=>row.attempts.at(-1));
  report.summary={...report.summary,firstTrialResults:requests.length,classificationMatched:requests.filter(row=>row.attempts[0].classificationMatched).length,
    repairAttempts:attempts.filter(row=>row.attempt==='repair').length,
    firstDraftsValid:requests.filter(row=>row.attempts[0].validation?.ok).length,
    finalDraftsValid:requests.filter(row=>row.expectedClassification==='supported'&&row.attempts.at(-1).validation?.ok).length,
    firstCoveragePassed:requests.filter(row=>row.attempts[0].coveragePassed).length,
    finalCoveragePassed:requests.filter(row=>row.finalCoveragePassed).length,
    nonDraftFidelityPassed:finalNonDraft.filter(row=>row.nonDraftFidelity.covered).length,
    nonDraftFidelityDefects:finalNonDraft.filter(row=>!row.nonDraftFidelity.covered).length,
    candidateChecks:attempts.reduce((n,row)=>n+row.candidates.length,0),
    semanticMismatches:attempts.reduce((n,row)=>n+row.mismatches.length,0),selectedFamilies:report.selectedProofCases.length};
}
function fixture() {
  const report=structuredClone(original);
  for(const trial of report.trials)for(const request of trial.requests)for(const attempt of request.attempts)
    if(attempt.kind!=='draft') {
      attempt.nonDraftFidelity={covered:true,missingFacets:[],extraneousAssumptions:[]};
      attempt.coveragePassed=true;
      request.finalCoveragePassed=true;
    }
  resummarize(report);
  return report;
}

test('accepts complete measured evidence with explicit non-draft fidelity',()=>{
  assert.equal(assertAuthoringReplay(fixture(),suite).candidateChecks,1023);
});

test('rejects a mismatch outside the six selected proof cases',()=>{
  const report=fixture();
  const selected=new Set(report.selectedProofCases.map(row=>row.challenge));
  const request=report.trials[0].requests.find(row=>row.expectedClassification==='supported'&&!selected.has(row.challenge)&&row.attempts.at(-1).validation?.ok);
  request.attempts.at(-1).candidates[0].actual='fail';
  assert.throws(()=>assertAuthoringReplay(report,suite),/candidate.*mismatch/i);
});

test('rejects a missing or duplicate candidate row',()=>{
  const report=fixture(),attempt=report.trials[0].requests.find(row=>row.expectedClassification==='supported'&&row.attempts[0].validation?.ok).attempts[0];
  const removed=attempt.candidates.pop();
  assert.throws(()=>assertAuthoringReplay(report,suite),/candidate/i);
  attempt.candidates.push(removed,structuredClone(removed));
  assert.throws(()=>assertAuthoringReplay(report,suite),/candidate/i);
});

test('rejects summary count tampering',()=>{
  const report=fixture();report.summary.candidateChecks++;
  assert.throws(()=>assertAuthoringReplay(report,suite),/summary.*candidateChecks/i);
});

test('rejects an unlisted non-draft fidelity defect',()=>{
  const report=fixture(),request=report.trials[0].requests.find(row=>row.expectedClassification==='ambiguous');
  request.attempts[0].nonDraftFidelity={covered:false,missingFacets:['threshold'],extraneousAssumptions:[]};
  request.attempts[0].coveragePassed=false;request.finalCoveragePassed=false;resummarize(report);
  assert.throws(()=>assertAuthoringReplay(report,suite),/fidelity defect/i);
  assert.equal(assertAuthoringReplay(report,suite,[{trial:1,challenge:request.challenge,missingFacets:['threshold'],extraneousAssumptions:[]}]).candidateChecks,1023);
});

test('rejects coverage that disagrees with a non-draft fidelity score',()=>{
  const report=fixture(),request=report.trials[0].requests.find(row=>row.expectedClassification==='ambiguous');
  request.attempts[0].nonDraftFidelity={covered:false,missingFacets:['threshold'],extraneousAssumptions:[]};
  assert.throws(()=>assertAuthoringReplay(report,suite),/coverage differs from non-draft fidelity/i);
});
