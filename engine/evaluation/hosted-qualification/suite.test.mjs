import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const context = '0x01' + 'ab'.repeat(168);

async function load() {
  const corpus = await import('./corpus.mjs');
  const oracle = await import('./oracle.mjs');
  return {corpus, oracle};
}

test('pier drawer family has an independent oracle and isolated failures', async () => {
  const {corpus, oracle} = await load();
  const challenge = corpus.buildCorpus().find((item) => item.id === 'pier-drawers');
  assert.ok(challenge, 'pier-drawers must exist');
  assert.equal(challenge.classification, 'supported');
  assert.equal(challenge.family, 'pier-reconciliation');
  assert.ok(challenge.candidates.filter((item) => item.expected.status === 'pass').length >= 2);
  for (const requirement of challenge.requirements) {
    assert.ok(
      challenge.candidates.some((item) => item.expected.status !== 'pass'
        && item.expected.violatedRequirements.length === 1
        && item.expected.violatedRequirements[0] === requirement.id),
      requirement.id,
    );
  }
  assert.ok(challenge.candidates.some((item) => item.expected.status === 'reject'));

  const directory = await mkdtemp(join(tmpdir(), 'ubc26-pier-'));
  try {
    const written = await corpus.writeChallenge(challenge, directory);
    for (const candidate of written.candidates) {
      const actual = await oracle.evaluateCandidate(challenge, join(directory, candidate.path), {
        referenceDirectory: join(directory, written.referencePath),
        contextHex: context,
      });
      assert.equal(actual.status, candidate.expected.status, candidate.id);
      assert.deepEqual(actual.violatedRequirements, candidate.expected.violatedRequirements, candidate.id);
    }
    const rules = challenge.plan.rules;
    challenge.plan.rules = [{op: 'literal', type: 'bool', value: true}];
    const valid = written.candidates.find((item) => item.id === 'valid');
    const ignored = await oracle.evaluateCandidate(challenge, join(directory, valid.path), {
      referenceDirectory: join(directory, written.referencePath),
      contextHex: context,
    });
    challenge.plan.rules = rules;
    assert.equal(ignored.status, 'pass');
    const file = join(directory, valid.path, 'delivery', 'drawers.json');
    const body = JSON.parse(await readFile(file, 'utf8'));
    body.rows[0].countedCents = '1';
    await writeFile(file, JSON.stringify(body));
    const changed = await oracle.evaluateCandidate(challenge, join(directory, valid.path), {
      referenceDirectory: join(directory, written.referencePath),
      contextHex: context,
    });
    assert.equal(changed.status, 'fail');
    assert.deepEqual(changed.violatedRequirements, ['exact-count']);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
