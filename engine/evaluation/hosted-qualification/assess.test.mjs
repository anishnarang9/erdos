import test from 'node:test';
import assert from 'node:assert/strict';
import {assessSupportedDraft} from './assess.mjs';
import {buildCorpus} from './corpus.mjs';
import {resolveEngine} from './host-run.mjs';
import {scoreTrial} from './score.mjs';

test('a returned supported plan is checked with the engine and the hidden oracle', async () => {
  const resolved = resolveEngine();
  assert.equal(resolved.ok, true, resolved.message);
  const challenge = buildCorpus().find((item) => item.id === 'pier-drawers');
  const assessed = await assessSupportedDraft(challenge, challenge.plan);
  assert.equal(assessed.engineValid, true);
  assert.ok(assessed.candidateResults.length > 0);
  assert.equal(assessed.candidateResults.every((item) => item.engine === item.oracle), true);
  const score = scoreTrial({
    challenge,
    response: {kind: 'draft', sourceQuotes: [{quote: 'Reconcile the Saturday pier drawers'}]},
    candidateResults: assessed.candidateResults,
    repairCount: 0,
    live: false,
  });
  assert.equal(score.live, false);
  assert.equal(score.semanticAgreement, true);
  assert.equal(score.falseAccepts, 0);
  assert.equal(score.malformedAccepts, 0);
  assert.equal(score.validInputFalseRejects, 0);

  const invalid = await assessSupportedDraft(challenge, {version: 1});
  assert.equal(invalid.engineValid, false);
  assert.deepEqual(invalid.candidateResults, []);
});
