import assert from 'node:assert/strict';

const expectedFamilies=['allocation-scheduling','expenses-budgets','file-hash-size','inventory','ledger-reconciliation','signed-evidence-bindings'];
const kindFor={supported:'draft',ambiguous:'clarification',unsupported:'unsupported'};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

function expectedCandidateRows(challenge,attempt,label) {
  const expected=new Map(challenge.candidates.map(row=>[row.id,row.expected]));
  assert.equal(expected.size,challenge.candidates.length,`${label}: duplicate suite candidate`);
  assert.equal(attempt.candidates.length,expected.size,`${label}: candidate count differs`);
  const seen=new Set();
  for(const row of attempt.candidates) {
    assert.ok(expected.has(row.candidate),`${label}: unknown candidate ${row.candidate}`);
    assert.ok(!seen.has(row.candidate),`${label}: duplicate candidate ${row.candidate}`);
    seen.add(row.candidate);
    const oracle=expected.get(row.candidate);
    assert.equal(row.expected,oracle.status,`${label}: candidate expected result differs`);
    assert.equal(row.actual,oracle.status,`${label}: candidate mismatch ${row.candidate}`);
    assert.equal(row.matched,true,`${label}: candidate mismatch flag ${row.candidate}`);
    assert.deepEqual(row.requirementIds,oracle.violatedRequirements,`${label}: candidate requirement IDs differ`);
  }
  assert.deepEqual(attempt.mismatches,[],`${label}: reported semantic mismatches`);
  assert.deepEqual(attempt.policyDiagnostics?.unprovenConstants,[],`${label}: unproven constants`);
  assert.deepEqual(attempt.policyDiagnostics?.unapprovedTrustKeys,[],`${label}: unapproved trust keys`);
}

function checkFidelity(attempt,key,expected) {
  const fidelity=attempt.nonDraftFidelity;
  assert.ok(fidelity&&typeof fidelity.covered==='boolean',`${key}: missing non-draft fidelity`);
  assert.ok(Array.isArray(fidelity.missingFacets)&&Array.isArray(fidelity.extraneousAssumptions),`${key}: malformed non-draft fidelity`);
  assert.equal(attempt.coveragePassed,fidelity.covered,`${key}: coverage differs from non-draft fidelity`);
  const actual={missingFacets:fidelity.missingFacets,extraneousAssumptions:fidelity.extraneousAssumptions};
  const allowed=expected.get(key);
  if(fidelity.covered) {
    assert.deepEqual(actual,{missingFacets:[],extraneousAssumptions:[]},`${key}: covered response has defects`);
    assert.equal(allowed,undefined,`${key}: expected fidelity defect is absent`);
  } else {
    assert.ok(allowed,`${key}: unlisted fidelity defect`);
    assert.ok(!same(actual,{missingFacets:[],extraneousAssumptions:[]}),`${key}: uncovered response has no defect`);
    assert.deepEqual(actual,allowed,`${key}: fidelity defect differs from expectation`);
    expected.delete(key);
  }
}

/** Rejects incomplete or internally inconsistent measured authoring evidence. */
export function assertAuthoringReplay(report,suite,expectedFidelityDefects=[]) {
  assert.ok(Array.isArray(suite?.challenges)&&Array.isArray(report?.trials));
  assert.equal(suite.challenges.length,60,'Suite must contain 60 challenges');
  const challenges=new Map(suite.challenges.map(row=>[row.id,row]));
  assert.equal(challenges.size,60,'Suite challenge IDs must be unique');
  const classes={supported:0,ambiguous:0,unsupported:0};
  for(const challenge of suite.challenges) {
    assert.ok(challenge.classification in classes,`Unknown classification: ${challenge.id}`);
    classes[challenge.classification]++;
  }
  assert.deepEqual(classes,{supported:40,ambiguous:10,unsupported:10});
  assert.equal(report.trials.length,3,'Three trials are required');
  const expected=new Map();
  for(const defect of expectedFidelityDefects) {
    const key=`${defect.trial}/${defect.challenge}`;
    assert.ok(!expected.has(key),`Duplicate expected fidelity defect: ${key}`);
    assert.ok(Array.isArray(defect.missingFacets)&&Array.isArray(defect.extraneousAssumptions),`Malformed expected fidelity defect: ${key}`);
    expected.set(key,{missingFacets:defect.missingFacets,extraneousAssumptions:defect.extraneousAssumptions});
  }
  let firstValid=0,repairs=0,candidateChecks=0,firstCoveragePassed=0,finalCoveragePassed=0;
  let nonDraftFidelityPassed=0,nonDraftFidelityDefects=0;
  const finalByTrialChallenge=new Map();
  const allTrialIds=new Set();
  for(const trial of report.trials) {
    assert.ok([1,2,3].includes(trial.trial)&&!allTrialIds.has(trial.trial),`Invalid or duplicate trial: ${trial.trial}`);
    allTrialIds.add(trial.trial);
    assert.equal(trial.requests.length,60,`Trial ${trial.trial}: expected 60 requests`);
    const ids=new Set(),requestIds=new Set();
    let trialFirstValid=0,trialRepairs=0,trialChecks=0,trialFirstCoverage=0,trialFinalCoverage=0;
    for(const request of trial.requests) {
      const label=`trial ${trial.trial} ${request.challenge}`;
      const challenge=challenges.get(request.challenge);
      assert.ok(challenge,`${label}: unknown challenge`);
      assert.ok(!ids.has(request.challenge),`${label}: duplicate challenge`);
      assert.ok(typeof request.requestId==='string'&&!requestIds.has(request.requestId),`${label}: duplicate request ID`);
      ids.add(request.challenge);requestIds.add(request.requestId);
      assert.equal(request.family,challenge.family,`${label}: family differs`);
      assert.equal(request.expectedClassification,challenge.classification,`${label}: classification differs`);
      assert.ok(Array.isArray(request.attempts)&&[1,2].includes(request.attempts.length),`${label}: expected one attempt or one repair`);
      assert.equal(request.attempts[0].attempt,'first',`${label}: first attempt is missing`);
      const first=request.attempts[0],final=request.attempts.at(-1);
      if(request.attempts.length===2) {
        assert.equal(request.attempts[1].attempt,'repair',`${label}: invalid repair label`);
        assert.equal(challenge.classification,'supported',`${label}: repair is not a draft`);
        assert.equal(first.kind,'draft',`${label}: repair is not a draft`);
        assert.equal(first.validation?.ok,false,`${label}: repair did not follow validation failure`);
        assert.equal(first.coveragePassed,false,`${label}: invalid first draft passed`);
        trialRepairs++;
      }
      for(const attempt of request.attempts) {
        assert.equal(attempt.kind,kindFor[challenge.classification],`${label}: wrong response kind`);
        assert.equal(attempt.classificationMatched,true,`${label}: classification flag differs`);
        assert.ok(Array.isArray(attempt.candidates)&&Array.isArray(attempt.mismatches),`${label}: missing result arrays`);
        if(challenge.classification==='supported') {
          if(attempt.validation?.ok) {
            expectedCandidateRows(challenge,attempt,`${label} ${attempt.attempt}`);
            trialChecks+=attempt.candidates.length;
            assert.equal(attempt.coveragePassed,true,`${label}: valid draft did not pass coverage`);
          } else {
            assert.equal(attempt.validation?.ok,false,`${label}: missing validation result`);
            assert.deepEqual(attempt.candidates,[],`${label}: invalid draft has candidates`);
            assert.deepEqual(attempt.mismatches,[],`${label}: invalid draft has mismatches`);
            assert.equal(attempt.coveragePassed,false,`${label}: invalid draft passed coverage`);
          }
        } else {
          assert.equal(attempt.validation,null,`${label}: non-draft validation exists`);
          assert.deepEqual(attempt.candidates,[],`${label}: non-draft has candidates`);
          assert.deepEqual(attempt.mismatches,[],`${label}: non-draft has mismatches`);
          checkFidelity(attempt,`${trial.trial}/${request.challenge}`,expected);
          if(attempt.nonDraftFidelity.covered)nonDraftFidelityPassed++;
          else nonDraftFidelityDefects++;
        }
      }
      if(first.validation?.ok)trialFirstValid++;
      if(first.coveragePassed)trialFirstCoverage++;
      if(final.coveragePassed)trialFinalCoverage++;
      assert.equal(request.finalCoveragePassed,final.coveragePassed,`${label}: final coverage flag differs`);
      if(challenge.classification==='supported')assert.equal(final.validation?.ok,true,`${label}: final supported draft is invalid`);
      finalByTrialChallenge.set(`${trial.trial}/${request.challenge}`,{request,final});
    }
    assert.deepEqual([...ids].sort(),[...challenges.keys()].sort(),`Trial ${trial.trial}: challenge set differs`);
    const trialSummary={requests:60,classificationMatched:60,firstDraftsValid:trialFirstValid,
      firstCoveragePassed:trialFirstCoverage,repairAttempts:trialRepairs,
      finalCoveragePassed:trialFinalCoverage,candidateChecks:trialChecks,semanticMismatches:0};
    for(const [key,value] of Object.entries(trialSummary))assert.equal(trial.summary?.[key],value,`Trial ${trial.trial} summary ${key} differs`);
    firstValid+=trialFirstValid;repairs+=trialRepairs;candidateChecks+=trialChecks;
    firstCoveragePassed+=trialFirstCoverage;finalCoveragePassed+=trialFinalCoverage;
  }
  assert.equal(expected.size,0,`Expected fidelity defect was absent: ${[...expected.keys()].join(', ')}`);
  assert.equal(firstValid,85,'Expected 85 valid initial supported drafts');
  assert.equal(repairs,35,'Expected 35 validation-only repairs');
  assert.equal(candidateChecks,1023,'Expected 1,023 candidate checks');
  assert.ok(Array.isArray(report.selectedProofCases)&&report.selectedProofCases.length===6,'Six selected families are required');
  const selectedFamilies=new Set();
  for(const selected of report.selectedProofCases) {
    const challenge=challenges.get(selected.challenge),record=finalByTrialChallenge.get(`${selected.trial}/${selected.challenge}`);
    assert.ok(challenge&&record,`Invalid selected proof case: ${selected.challenge}`);
    assert.equal(challenge.classification,'supported');
    assert.equal(selected.family,challenge.family);
    assert.equal(selected.requestId,record.request.requestId);
    assert.equal(selected.attempt,record.final.attempt);
    assert.equal(record.final.coveragePassed,true);
    assert.ok(!selectedFamilies.has(selected.family),`Duplicate selected family: ${selected.family}`);
    selectedFamilies.add(selected.family);
  }
  assert.deepEqual([...selectedFamilies].sort(),expectedFamilies,'Selected families differ');
  const summary={firstTrialResults:180,classificationMatched:180,repairAttempts:repairs,
    firstDraftsValid:firstValid,finalDraftsValid:120,firstCoveragePassed,finalCoveragePassed,
    nonDraftFidelityPassed,nonDraftFidelityDefects,candidateChecks,semanticMismatches:0,selectedFamilies:6};
  for(const [key,value] of Object.entries(summary))assert.equal(report.summary?.[key],value,`Summary ${key} differs`);
  assert.deepEqual(report.failures,[],'Authoring report contains failures');
  assert.ok(report.finishedAt,'Authoring report is unfinished');
  return summary;
}
