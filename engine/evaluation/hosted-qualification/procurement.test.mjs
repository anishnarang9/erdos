import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCorpus, writeChallenge} from './corpus.mjs';
import {evaluateCandidate} from './oracle.mjs';
import {draftInput} from './trials.mjs';
import {assessSupportedDraft} from './assess.mjs';
import {scoreTrial} from './score.mjs';

const ids = ['lab-supplies-receipt-1', 'clinic-supplies-receipt-1'];
const context = `0x01${'ab'.repeat(168)}`;

test('new receipt cases keep private checks out of draft input and isolate each rule', async () => {
  const corpus = buildCorpus();
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-procurement-'));
  try {
    for (const id of ids) {
      const challenge = corpus.find((item) => item.id === id);
      assert.ok(challenge, id);
      const visible = draftInput(challenge);
      assert.equal(Object.hasOwn(visible, 'plan'), false);
      assert.equal(Object.hasOwn(visible, 'spec'), false);
      assert.equal(Object.hasOwn(visible, 'candidates'), false);
      assert.equal(Object.hasOwn(visible, 'requirements'), false);
      assert.deepEqual(visible.outputs, [{name: 'receipt.json', format: 'json'}]);

      const written = await writeChallenge(challenge, directory);
      for (const candidate of written.candidates) {
        const result = await evaluateCandidate(challenge, join(directory, candidate.path), {
          referenceDirectory: join(directory, written.referencePath),
          contextHex: context,
        });
        assert.equal(result.status, candidate.expected.status, `${id}/${candidate.id}`);
        assert.deepEqual(result.violatedRequirements, candidate.expected.violatedRequirements, `${id}/${candidate.id}`);
      }
      for (const requirement of challenge.requirements) {
        assert.ok(challenge.candidates.some((candidate) =>
          candidate.expected.status === 'fail' &&
          candidate.expected.violatedRequirements.length === 1 &&
          candidate.expected.violatedRequirements[0] === requirement.id), `${id}/${requirement.id}`);
      }

      const originalRules = challenge.plan.rules;
      challenge.plan.rules = [{op: 'literal', type: 'bool', value: true}];
      const overLimit = written.candidates.find((item) => item.id === 'over-order-limit');
      const independent = await evaluateCandidate(challenge, join(directory, overLimit.path), {
        referenceDirectory: join(directory, written.referencePath),
        contextHex: context,
      });
      challenge.plan.rules = originalRules;
      assert.deepEqual(independent.violatedRequirements, ['item-limit']);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('scoring detects a valid but weaker receipt plan', async () => {
  const corpus = buildCorpus();
  for (const id of ids) {
    const challenge = corpus.find((item) => item.id === id);
    const correct = await assessSupportedDraft(challenge, challenge.plan);
    assert.equal(correct.engineValid, true, correct.reason);
    assert.equal(scoreTrial({challenge, response: {kind: 'draft'}, candidateResults: correct.candidateResults}).semanticAgreement, true);
  }

  const challenge = corpus.find((item) => item.id === ids[0]);

  const weaker = structuredClone(challenge.plan);
  weaker.rules.splice(3, 1); // Remove the per-item limit, but retain the receipt capacity rule.
  const assessed = await assessSupportedDraft(challenge, weaker);
  assert.equal(assessed.engineValid, true, assessed.reason);
  const overLimit = assessed.candidateResults.find((item) => item.id === 'over-order-limit');
  assert.deepEqual(overLimit, {id: 'over-order-limit', engine: 'pass', oracle: 'fail'});
  const unknown = assessed.candidateResults.find((item) => item.id === 'unknown-item');
  assert.deepEqual(unknown, {id: 'unknown-item', engine: 'pass', oracle: 'reject'});
  const score = scoreTrial({challenge, response: {kind: 'draft'}, candidateResults: assessed.candidateResults});
  assert.equal(score.semanticAgreement, false);
  assert.equal(score.falseAccepts, 2);
  assert.equal(score.missingRequirements, 1);
  assert.equal(score.malformedAccepts, 1);
  assert.equal(score.validInputFalseRejects, 0);
});

test('lookup rejects an unknown reference key while all-any membership gives verdict zero', async () => {
  const challenge = buildCorpus().find((item) => item.id === 'lab-supplies-receipt-1');
  const withLookup = await assessSupportedDraft(challenge, challenge.plan);
  assert.equal(withLookup.engineValid, true);
  assert.deepEqual(withLookup.candidateResults.find((item) => item.id === 'unknown-item'), {
    id: 'unknown-item', engine: 'reject', oracle: 'reject',
  });

  const withAny = structuredClone(challenge.plan);
  withAny.rules[3] = {
    op: 'all', collection: {source: 'deliverable', file: 'receipt.json', field: 'rows'},
    where: {
      op: 'any', collection: {source: 'reference', file: 'purchase-order.json', field: 'rows'},
      where: {
        op: 'eq',
        left: {op: 'record_field', field: 'itemId'},
        right: {op: 'record_field', field: 'itemId', level: 1},
      },
    },
  };
  const withoutLookup = await assessSupportedDraft(challenge, withAny);
  assert.equal(withoutLookup.engineValid, true);
  assert.deepEqual(withoutLookup.candidateResults.find((item) => item.id === 'unknown-item'), {
    id: 'unknown-item', engine: 'fail', oracle: 'reject',
  });
});

test('scoring detects an invented receipt condition', async () => {
  const challenge = buildCorpus().find((item) => item.id === ids[0]);
  const restrictive = structuredClone(challenge.plan);
  restrictive.rules.push({
    op: 'eq',
    left: {op: 'sum', collection: {source: 'deliverable', file: 'receipt.json', field: 'rows'}, value: {op: 'record_field', field: 'received'}},
    right: {op: 'literal', type: 'i64', value: '0'},
  });
  const assessed = await assessSupportedDraft(challenge, restrictive);
  assert.equal(assessed.engineValid, true, assessed.reason);
  assert.deepEqual(assessed.candidateResults.find((item) => item.id === 'valid-partial'), {
    id: 'valid-partial', engine: 'fail', oracle: 'pass',
  });
  const score = scoreTrial({challenge, response: {kind: 'draft'}, candidateResults: assessed.candidateResults});
  assert.equal(score.semanticAgreement, false);
  assert.equal(score.validInputFalseRejects, 1);
  assert.equal(score.inventedConditions, 1);
  assert.equal(score.falseAccepts, 0);
});
