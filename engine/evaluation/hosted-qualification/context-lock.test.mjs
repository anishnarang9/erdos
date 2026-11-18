import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assessSupportedDraft} from './assess.mjs';
import {buildCorpus, writeChallenge} from './corpus.mjs';
import {classifyExampleEval, separateDraftScores, withLiteralTrue} from './example-approval.mjs';
import {resolveEngine} from './host-run.mjs';
import {runEngine} from '../run-challenges.mjs';
import {scoreTrial} from './score.mjs';
import {draftInput} from './trials.mjs';
import {signingKey} from './shape.mjs';

const SIGNED = ['seal-1', 'crate-1', 'transfer-1', 'dual-seal-1'];

test('example approval does not relabel a rules-hash mismatch as a semantic miss', () => {
  const lock = {outcome: 'rules-hash-differs', blocksApproval: true};
  const separated = separateDraftScores(true, [lock, lock]);
  assert.equal(separated.semanticAgreement, true);
  assert.equal(separated.approvalReady, false);
  assert.equal(separated.passCount, 0);
  assert.equal(separated.verdict0Count, 0);
  assert.deepEqual(separated.blockers, ['rules-hash-differs', 'rules-hash-differs']);

  const incomplete = separateDraftScores(true, [{outcome: 'pass', blocksApproval: false}]);
  assert.equal(incomplete.approvalReady, false);
  const rejected = separateDraftScores(true, [
    {outcome: 'pass', blocksApproval: false},
    {outcome: 'verdict-0', blocksApproval: false},
    {outcome: 'reject', blocksApproval: true},
  ]);
  assert.equal(rejected.passCount, 1);
  assert.equal(rejected.approvalReady, false);
  const semanticMiss = separateDraftScores(false, [
    {outcome: 'pass', blocksApproval: false},
    {outcome: 'verdict-0', blocksApproval: false},
  ]);
  assert.equal(semanticMiss.semanticAgreement, false);
  assert.equal(semanticMiss.approvalReady, false);
  const ready = separateDraftScores(true, [
    {outcome: 'pass', blocksApproval: false},
    {outcome: 'verdict-0', blocksApproval: false},
  ]);
  assert.equal(ready.semanticAgreement, true);
  assert.equal(ready.approvalReady, true);
  assert.deepEqual(ready.blockers, []);
  const relabeled = separateDraftScores(true, [
    {outcome: 'pass', blocksApproval: false},
    {outcome: 'verdict-0', blocksApproval: false},
    {outcome: 'rules-hash-differs', blocksApproval: false},
  ]);
  assert.equal(relabeled.approvalReady, false);
  assert.deepEqual(relabeled.blockers, ['rules-hash-differs']);
});

test('a literal-true plan stays semantically agreed when the fixed preview context rejects', async () => {
  const resolved = resolveEngine();
  assert.equal(resolved.ok, true, resolved.message);
  const privateKey = signingKey().export({type: 'pkcs8', format: 'der'}).toString('hex');
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-context-lock-'));
  try {
    for (const id of SIGNED) {
      const challenge = buildCorpus().find((item) => item.id === id);
      const body = JSON.stringify(draftInput(challenge));
      assert.equal(body.includes(privateKey), false, id);
      assert.equal(body.includes('"plan"'), false, id);
      const equivalent = withLiteralTrue(challenge.plan);
      const assessed = await assessSupportedDraft(challenge, equivalent);
      assert.equal(assessed.engineValid, true, id);
      assert.ok(assessed.candidateResults.length > 0, id);
      assert.equal(assessed.candidateResults.every((item) => item.engine === item.oracle), true, id);
      const score = scoreTrial({
        challenge,
        response: {kind: 'draft', sourceQuotes: []},
        candidateResults: assessed.candidateResults,
        repairCount: 0,
        live: false,
      });
      assert.equal(score.semanticAgreement, true, id);
      assert.equal(score.falseAccepts, 0, id);
      assert.equal(score.malformedAccepts, 0, id);
      assert.equal(score.validInputFalseRejects, 0, id);

      const written = await writeChallenge(challenge, directory);
      const originalPath = join(directory, written.planPath);
      const equivalentPath = join(directory, `${id}-equivalent.json`);
      await writeFile(equivalentPath, `${JSON.stringify(equivalent)}\n`);
      const originalValidation = runEngine(resolved.engine, ['validate', '--plan', originalPath]);
      const equivalentValidation = runEngine(resolved.engine, ['validate', '--plan', equivalentPath]);
      assert.equal(originalValidation.exitCode, 0, originalValidation.stderr);
      assert.equal(equivalentValidation.exitCode, 0, equivalentValidation.stderr);
      assert.notEqual(originalValidation.value.rulesHash, equivalentValidation.value.rulesHash, id);

      const reference = join(directory, written.referencePath);
      const passFixture = challenge.exampleFixtures.find((item) => item.name === 'illustrative-pass');
      const lowFixture = challenge.exampleFixtures.find((item) => item.predictedVerdict === 0);
      const lockedPass = classifyExampleEval(await evalFixture(resolved.engine, directory, id, 'equivalent-pass', equivalentPath, reference, passFixture));
      const lockedLow = classifyExampleEval(await evalFixture(resolved.engine, directory, id, 'equivalent-low', equivalentPath, reference, lowFixture));
      assert.equal(lockedPass.outcome, 'rules-hash-differs', id);
      assert.equal(lockedLow.outcome, 'rules-hash-differs', id);
      const separated = separateDraftScores(score.semanticAgreement, [lockedPass, lockedLow]);
      assert.equal(separated.semanticAgreement, true, id);
      assert.equal(separated.approvalReady, false, id);
      assert.equal(separated.passCount, 0, id);
      assert.deepEqual(separated.blockers, ['rules-hash-differs', 'rules-hash-differs'], id);

      const canonicalPass = classifyExampleEval(await evalFixture(resolved.engine, directory, id, 'canonical-pass', originalPath, reference, passFixture));
      const canonicalLow = classifyExampleEval(await evalFixture(resolved.engine, directory, id, 'canonical-low', originalPath, reference, lowFixture));
      assert.equal(canonicalPass.outcome, 'pass', id);
      assert.equal(canonicalLow.outcome, 'verdict-0', id);
      const matched = separateDraftScores(true, [canonicalPass, canonicalLow]);
      assert.equal(matched.approvalReady, true, id);
      assert.equal(matched.semanticAgreement, true, id);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

async function evalFixture(engine, directory, id, label, planPath, reference, fixture) {
  const root = join(directory, 'fixtures', id, label);
  await mkdir(join(root, 'delivery'), {recursive: true});
  await mkdir(join(root, 'evidence'), {recursive: true});
  for (const file of fixture.files) await writeFile(join(root, 'delivery', file.name), file.content);
  for (const file of fixture.evidence ?? []) await writeFile(join(root, 'evidence', file.name), file.content);
  const jobPath = join(root, 'job.json');
  await writeFile(jobPath, JSON.stringify({context: fixture.context}));
  return runEngine(engine, [
    'eval', '--plan', planPath, '--deliverables', join(root, 'delivery'),
    '--reference', reference, '--evidence', join(root, 'evidence'), '--job', jobPath,
  ]);
}
