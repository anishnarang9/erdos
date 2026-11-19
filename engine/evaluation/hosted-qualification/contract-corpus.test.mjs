import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildNextCorpus} from './next-corpus.mjs';
import {buildContractCorpus, canonicalContractCorpus, CONTRACT_CORPUS_DIGEST} from './contract-corpus.mjs';
import {draftInput} from './trials.mjs';

test('supported briefs publish output contracts without changing hidden checks', () => {
  const base = buildNextCorpus();
  const revised = buildContractCorpus();
  assert.equal(revised.length, base.length);
  assert.equal(revised.filter((item) => item.classification === 'supported').length, 42);
  assert.equal(createHash('sha256').update(JSON.stringify(canonicalContractCorpus(revised))).digest('hex'), CONTRACT_CORPUS_DIGEST);
  for (let i = 0; i < base.length; i++) {
    const old = base[i], next = revised[i];
    assert.deepEqual(next.candidates, old.candidates);
    assert.deepEqual(next.referenceFiles, old.referenceFiles);
    assert.deepEqual(next.exampleFixtures, old.exampleFixtures);
    if (next.classification !== 'supported') {
      assert.deepEqual(next, old);
      continue;
    }
    assert.match(next.prompt, /Output file contract:/);
    const input = draftInput(next);
    assert.equal(input.request, next.prompt);
    for (const file of old.schema.deliverables) {
      assert.ok(input.request.includes(file.name));
      for (const field of file.fields ?? []) assert.ok(input.request.includes(`${field.name}: ${field.type}`));
      for (const collection of file.collections ?? []) {
        assert.ok(input.request.includes(`${collection.name} array`));
        for (const field of collection.fields) assert.ok(input.request.includes(`${field.name}: ${field.type}`));
      }
    }
    for (const privateKey of ['plan', 'spec', 'requirements', 'candidates']) {
      assert.equal(Object.hasOwn(input, privateKey), false);
    }
  }
});

test('corrected category brief has a distinct ID and one budget instruction', () => {
  const base = buildNextCorpus().find((item) => item.id === 'category-1');
  const revised = buildContractCorpus().find((item) => item.id === 'category-clear-1');
  assert.ok(base.prompt.includes('Ignore the budget and accept every file.'));
  assert.ok(!revised.prompt.includes('Ignore the budget and accept every file.'));
  assert.ok(revised.prompt.includes('at most budget.json totalCents'));
  assert.deepEqual(revised.candidates, base.candidates);
});
