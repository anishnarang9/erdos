import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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

test('nested all stays under the typecheck cap and rejects above the visit cap', async () => {
  assert.equal(resolved.ok, true, resolved.message);
  const plan = nestedAllPlan();
  assert.equal(countOps(plan.rules[0]), 4);
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-visits-'));
  try {
    const below = await evalPlan(engine, directory, 'below', plan, {'sets.json': collectionDelivery(99)});
    assert.equal(below.validation.exitCode, 0, below.validation.stderr);
    assert.equal(below.evaluation.exitCode, 0, below.evaluation.stderr);
    assert.equal(below.evaluation.value.verdict, 1);

    const failedRule = await evalPlan(engine, directory, 'rule-fail', plan, {'sets.json': collectionDelivery(1, false)});
    assert.equal(failedRule.evaluation.exitCode, 0, failedRule.evaluation.stderr);
    assert.equal(failedRule.evaluation.value.verdict, 0);

    const above = await evalPlan(engine, directory, 'above', plan, {'sets.json': collectionDelivery(100)});
    assert.equal(above.validation.exitCode, 0, above.validation.stderr);
    assert.equal(above.evaluation.exitCode, 2);
    assert.equal(above.evaluation.value?.code, 'invalid_deliverable');
    assert.equal(above.evaluation.value?.message, 'Invalid rule expression');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a supported plan rejects past the rule depth cap', async () => {
  assert.equal(resolved.ok, true, resolved.message);
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-depth-'));
  try {
    const below = await evalPlan(engine, directory, 'depth-below', nestedNotPlan(30), {'note.txt': 'ok\n'});
    assert.equal(below.validation.exitCode, 0, below.validation.stderr);
    assert.equal(below.evaluation.exitCode, 0, below.evaluation.stderr);
    assert.equal(below.evaluation.value.verdict, 1);

    const above = await evalPlan(engine, directory, 'depth-above', nestedNotPlan(32), {'note.txt': 'ok\n'});
    assert.equal(above.validation.exitCode, 2);
    assert.equal(above.validation.value?.code, 'invalid_plan');
    assert.equal(above.validation.value?.message, 'Rules exceed the depth or node limit');
    assert.equal(above.evaluation, null);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

function nestedAllPlan() {
  const collection = (field) => ({source: 'deliverable', file: 'sets.json', field});
  return {
    version: 1,
    deliverables: [{
      name: 'sets.json',
      parser: 'json/v1',
      collections: ['outer', 'middle', 'inner'].map((name) => ({
        name,
        fields: [{name: 'ok', type: 'bool'}],
      })),
    }],
    references: [],
    rules: [{
      op: 'all',
      collection: collection('outer'),
      where: {
        op: 'all',
        collection: collection('middle'),
        where: {
          op: 'all',
          collection: collection('inner'),
          where: {op: 'record_field', field: 'ok'},
        },
      },
    }],
  };
}

function collectionDelivery(count, ok = true) {
  const rows = Array.from({length: count}, () => ({ok}));
  return JSON.stringify({outer: rows, middle: rows, inner: rows});
}

function nestedNotPlan(depth) {
  let rule = {op: 'literal', type: 'bool', value: true};
  for (let index = 0; index < depth; index += 1) rule = {op: 'not', value: rule};
  return {
    version: 1,
    deliverables: [{name: 'note.txt', parser: 'text/v1'}],
    references: [],
    rules: [rule],
  };
}

function countOps(expression) {
  const nested = ['where', 'value', 'left', 'right'].reduce((total, key) => (
    expression[key] && typeof expression[key] === 'object' ? total + countOps(expression[key]) : total
  ), 0);
  return 1 + nested;
}

async function evalPlan(engine, directory, name, plan, files) {
  const planPath = join(directory, `${name}-plan.json`);
  await writeFile(planPath, JSON.stringify(plan));
  const delivery = join(directory, `${name}-delivery`);
  await mkdir(delivery, {recursive: true});
  for (const [fileName, content] of Object.entries(files)) await writeFile(join(delivery, fileName), content);
  const validation = runEngine(engine, ['validate', '--plan', planPath]);
  const evaluation = validation.exitCode === 0
    ? runEngine(engine, ['eval', '--plan', planPath, '--deliverables', delivery])
    : null;
  return {validation, evaluation};
}
