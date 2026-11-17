import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCorpus, writeChallenge} from './corpus.mjs';
import {resolveEngine} from './host-run.mjs';
import {classifyEvaluation, encodeDirectory, runEngine, sha256, syntheticJob} from '../run-challenges.mjs';

const resolved = resolveEngine();
const engine = resolved.engine;

test('substituted commitments and deep delivery JSON reject', async () => {
  assert.equal(resolved.ok, true, resolved.message);
  const challenge = buildCorpus().find((item) => item.id === 'pier-drawers');
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-security-'));
  try {
    const written = await writeChallenge(challenge, directory);
    const planPath = join(directory, written.planPath);
    const reference = join(directory, written.referencePath);
    const validation = runEngine(engine, ['validate', '--plan', planPath]);
    assert.equal(validation.exitCode, 0, validation.stderr);
    const floatsPath = join(reference, 'floats.json');
    const originalFloats = await readFile(floatsPath);
    const referenceHash = sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'), await encodeDirectory(reference)]));
    const job = syntheticJob({rulesHash: validation.value.rulesHash, referenceHash}, 9001);
    const jobPath = join(directory, 'job.json');
    await writeFile(jobPath, JSON.stringify(job));
    const valid = written.candidates.find((item) => item.id === 'valid');
    const delivery = join(directory, valid.path, 'delivery');
    const args = ['eval', '--plan', planPath, '--deliverables', delivery, '--reference', reference, '--job', jobPath];
    assert.equal(classifyEvaluation(runEngine(engine, args)), 'pass');

    const rulesAt = 2 + (1 + 32 + 20 + 32 + 20) * 2;
    const flippedContext = `${job.context.slice(0, rulesAt)}${job.context[rulesAt] === '0' ? '1' : '0'}${job.context.slice(rulesAt + 1)}`;
    const flippedPath = join(directory, 'flipped-job.json');
    await writeFile(flippedPath, JSON.stringify({...job, context: flippedContext}));
    const flipped = runEngine(engine, ['eval', '--plan', planPath, '--deliverables', delivery, '--reference', reference, '--job', flippedPath]);
    assert.equal(flipped.exitCode, 2);
    assert.equal(flipped.value?.code, 'invalid_deliverable');

    await writeFile(floatsPath, originalFloats.toString('utf8').replace('400', '401'));
    const changed = runEngine(engine, args);
    assert.equal(changed.exitCode, 2);
    assert.equal(changed.value?.code, 'invalid_deliverable');
    await writeFile(floatsPath, originalFloats);

    let pad = '"x"';
    for (let level = 0; level < 31; level += 1) pad = `{"a":${pad}}`;
    const drawersPath = join(delivery, 'drawers.json');
    const drawers = await readFile(drawersPath, 'utf8');
    await writeFile(drawersPath, drawers.replace(/}\s*$/, `,"pad":${pad}}`));
    const deep = runEngine(engine, args);
    assert.equal(deep.exitCode, 2);
    assert.equal(deep.value?.code, 'invalid_deliverable');

    const rows = Array.from({length: 257}, (_, index) => ({drawerId: `drawer-${index}`, countedCents: '1'}));
    await writeFile(drawersPath, JSON.stringify({rows}));
    const wide = runEngine(engine, args);
    assert.equal(wide.exitCode, 2);
    assert.equal(wide.value?.code, 'invalid_deliverable');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
