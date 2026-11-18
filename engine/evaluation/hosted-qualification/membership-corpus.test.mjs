import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildContractCorpus} from './contract-corpus.mjs';
import {buildMembershipCorpus, canonicalMembershipCorpus, MEMBERSHIP_CORPUS_DIGEST} from './membership-corpus.mjs';
import {draftInput} from './trials.mjs';

test('membership briefs expose the reject policy without changing private evidence', () => {
  const prior = buildContractCorpus();
  const next = buildMembershipCorpus();
  assert.equal(next.length, prior.length);
  assert.equal(createHash('sha256').update(JSON.stringify(canonicalMembershipCorpus(next))).digest('hex'), MEMBERSHIP_CORPUS_DIGEST);
  assert.equal(new Set(next.map(c => c.id)).size, next.length);
  let changed = 0;
  for (const [index, before] of prior.entries()) {
    const after = next[index];
    const membershipReject = before.candidates?.some(candidate => candidate.expected.status === 'reject'
      && candidate.expected.violatedRequirements.includes('reference-membership'));
    if (!membershipReject) {
      assert.deepEqual(after, before, before.id);
      continue;
    }
    changed++;
    assert.equal(after.id, before.id + '-membership');
    assert.deepEqual({...after, id: before.id, prompt: before.prompt}, before);
    const previous = draftInput(before);
    const input = draftInput(after);
    assert.deepEqual({...input, request: previous.request}, previous);
    assert.match(input.request, /An unknown key is an input error and has no rule verdict\./);
    const bindings = [...input.request.matchAll(/Reject the input if a row in (\S+) uses a (\w+) missing from (\S+)\./g)];
    assert.ok(bindings.length > 0, before.id);
    for (const [, output, field, reference] of bindings) {
      const schema = before.schema.deliverables.find(file => file.name === output);
      assert.ok(schema?.collections?.some(collection => collection.fields.some(item => item.name === field)), before.id);
      const values = JSON.parse(Buffer.from(before.referenceFiles[reference]).toString());
      assert.ok(Object.values(values).some(rows => Array.isArray(rows) && rows.length
        && rows.every(row => Object.hasOwn(row, field))), before.id);
    }
  }
  assert.equal(changed, 26);
});
