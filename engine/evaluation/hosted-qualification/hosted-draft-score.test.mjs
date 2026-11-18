import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreHostedDraftGates} from './score.mjs';

test('matching oracle outcomes cannot stand in for engine-checked examples', () => {
  const input = {
    challenge: {classification: 'supported', prompt: 'Check this'},
    response: {
      kind: 'draft',
      coverage: {ruleCoverageComplete: true},
      sourceQuotes: [{quote: 'Check this'}],
      quoteVerification: [{found: true}],
      exampleApprovalReady: false,
    },
    engineValid: true,
    candidateResults: [{engine: 'pass', oracle: 'pass'}],
  };
  assert.deepEqual(scoreHostedDraftGates(input), {checksMatch: true, readyForBuyerReview: false});
  input.response.exampleApprovalReady = true;
  assert.equal(scoreHostedDraftGates(input).readyForBuyerReview, true);
  input.challenge.exampleFixtures = [{name: 'buyer-pass'}];
  assert.equal(scoreHostedDraftGates(input).readyForBuyerReview, false);
  input.response.buyerFixtureApprovalReady = true;
  assert.equal(scoreHostedDraftGates(input).readyForBuyerReview, true);
});
