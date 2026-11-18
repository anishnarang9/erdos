import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCorpus, writeChallenge} from './corpus.mjs';
import {buildNextCorpus, canonicalNextCorpus, NEXT_CORPUS_DIGEST} from './next-corpus.mjs';
import {draftInput} from './trials.mjs';
import {evaluateCandidate} from './oracle.mjs';
import {resolveEngine} from './host-run.mjs';
import {classifyEvaluation, runEngine} from '../run-challenges.mjs';

const bundle = (files) => JSON.stringify(Object.entries(files).map(([name, bytes]) =>
  [name, Buffer.from(bytes).toString('base64')]).sort(([a], [b]) => a.localeCompare(b)));
const fixtureFiles = (fixture) => Object.fromEntries(fixture.files.map((file) => [
  file.name, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'),
]));

test('new public examples change the frozen corpus without changing hidden candidates', () => {
  const base = buildCorpus();
  const next = buildNextCorpus();
  assert.equal(next.length, base.length);
  assert.equal(createHash('sha256').update(JSON.stringify(canonicalNextCorpus(next))).digest('hex'), NEXT_CORPUS_DIGEST);
  const changed = next.filter((item, i) => item.exampleFixtures && !base[i].exampleFixtures);
  assert.equal(changed.length, 8);
  for (const challenge of changed) {
    const original = base.find((item) => item.id === challenge.id);
    assert.deepEqual(challenge.candidates, original.candidates);
    assert.deepEqual(challenge.exampleFixtures.map((item) => item.predictedVerdict).sort(), [0, 1]);
    const hidden = new Set(challenge.candidates.map((item) => bundle(item.deliveryFiles)));
    for (const fixture of challenge.exampleFixtures) {
      assert.deepEqual(fixture.files.map((file) => file.name).sort(), challenge.outputs.map((item) => item.name).sort());
      assert.equal(hidden.has(bundle(fixtureFiles(fixture))), false, `${challenge.id}/${fixture.name}`);
    }
    const publicBody = draftInput(challenge);
    assert.deepEqual(publicBody.exampleFixtures, challenge.exampleFixtures);
    for (const privateKey of ['plan', 'spec', 'requirements', 'candidates']) {
      assert.equal(Object.hasOwn(publicBody, privateKey), false);
    }
  }
});

test('each public example agrees with the independent oracle and native engine', async () => {
  const resolved = resolveEngine();
  assert.equal(resolved.ok, true);
  const root = await mkdtemp(join(tmpdir(), 'ubc26-public-examples-'));
  try {
    for (const challenge of buildNextCorpus().filter((item) => item.exampleFixtures &&
      ['pier-drawers','lot-range-1','badge-zone-1','nights-1','firmware-note-1',
        'lab-supplies-receipt-1','clinic-supplies-receipt-1','route-1'].includes(item.id))) {
      const written = await writeChallenge(challenge, root);
      const plan = join(root, written.planPath);
      const reference = join(root, written.referencePath);
      for (const fixture of challenge.exampleFixtures) {
        const at = join(root, 'public', challenge.id, fixture.name);
        const delivery = join(at, 'delivery');
        await mkdir(delivery, {recursive: true});
        for (const [name, bytes] of Object.entries(fixtureFiles(fixture))) await writeFile(join(delivery, name), bytes);
        const expected = fixture.predictedVerdict === 1 ? 'pass' : 'fail';
        const oracle = await evaluateCandidate(challenge, at, {referenceDirectory: reference});
        const actual = classifyEvaluation(runEngine(resolved.engine, [
          'eval', '--plan', plan, '--deliverables', delivery, '--reference', reference,
        ]));
        assert.equal(oracle.status, expected, `${challenge.id}/${fixture.name} oracle`);
        assert.equal(actual, expected, `${challenge.id}/${fixture.name} engine`);
      }
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
