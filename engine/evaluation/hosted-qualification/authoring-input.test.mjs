import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TextDecoder} from 'node:util';
import {buildCorpus, canonicalCorpus, CORPUS_DIGEST, PREVIOUS_CORPUS_DIGEST} from './corpus.mjs';
import {evaluateCandidate} from './oracle.mjs';
import {draftInput} from './trials.mjs';
import {resolveEngine} from './host-run.mjs';
import {classifyEvaluation, runEngine} from '../run-challenges.mjs';
import {syntheticSigner} from './shape.mjs';

const SIGNED = ['seal-1', 'crate-1', 'transfer-1', 'dual-seal-1'];
const PRE_FACET_DIGEST = '621ac9137f29ee3969150da63430860af0f9c706d3745aafbb1a374f72953391';
const HIDDEN_DIGEST = '591f9766bbb51388f6f488781826ce1e33da236de5ece8608b2fbc9bf23d2d10';
const PRIVATE_SEED = Buffer.alloc(32, 0x31).toString('hex');
const PRIVATE_HEADER = '302e020100300506032b657004220420';
const RUBRIC_OUTPUTS = {
  'hq-ambiguous-1': [{name: 'manifest.json', format: 'json'}],
  'hq-ambiguous-2': [{name: 'lot.json', format: 'json'}],
  'hq-ambiguous-3': [{name: 'invoice.json', format: 'json'}],
  'hq-ambiguous-4': [{name: 'guest.json', format: 'json'}],
  'hq-ambiguous-5': [{name: 'block.json', format: 'json'}],
  'hq-ambiguous-6': [{name: 'berth.json', format: 'json'}],
  'hq-ambiguous-7': [{name: 'route.json', format: 'json'}],
  'hq-ambiguous-8': [{name: 'take.json', format: 'json'}],
  'hq-ambiguous-9': [{name: 'release.json', format: 'json'}],
  'hq-ambiguous-10': [{name: 'channel.json', format: 'json'}],
  'hq-unsupported-1': [{name: 'notice.txt', format: 'text'}],
  'hq-unsupported-2': [{name: 'ratio.json', format: 'json'}],
  'hq-unsupported-3': [{name: 'route.json', format: 'json'}],
  'hq-unsupported-4': [{name: 'lot.json', format: 'json'}],
  'hq-unsupported-5': [{name: 'date.json', format: 'json'}],
  'hq-unsupported-6': [{name: 'rate.json', format: 'json'}],
  'hq-unsupported-7': [{name: 'cover.txt', format: 'text'}],
  'hq-unsupported-8': [{name: 'blob.bin', format: 'binary'}],
  'hq-unsupported-9': [{name: 'lots.pdf', format: 'binary'}],
  'hq-unsupported-10': [{name: 'chain.pem', format: 'text'}],
};

const sha = (value) => createHash('sha256').update(value).digest('hex');

function hiddenPack(challenges) {
  return challenges.map((challenge) => ({
    id: challenge.id,
    family: challenge.family,
    classification: challenge.classification,
    requirements: challenge.requirements ?? [],
    spec: challenge.spec ?? null,
    plan: challenge.plan ?? null,
    unsupportedDraft: challenge.unsupportedDraft ?? null,
    clarificationQuestions: challenge.clarificationQuestions ?? [],
    facets: challenge.facets ?? [],
    capabilityRequests: challenge.capabilityRequests ?? [],
    boundary: challenge.boundary ?? null,
    referenceFiles: Object.fromEntries(Object.entries(challenge.referenceFiles ?? {}).map(([name, bytes]) => [
      name,
      Buffer.from(bytes).toString('base64'),
    ])),
    candidates: (challenge.candidates ?? []).map((item) => ({
      id: item.id,
      expected: item.expected,
      evidenceVariant: item.evidenceVariant ?? null,
      deliveryFiles: Object.fromEntries(Object.entries(item.deliveryFiles).map(([name, bytes]) => [
        name,
        Buffer.from(bytes).toString('base64'),
      ])),
    })),
  }));
}

function fileBytes(file) {
  if (file.encoding === 'base64') return Buffer.from(file.content, 'base64');
  return Buffer.from(file.content, 'utf8');
}

test('rubric requests declare outputs that match the stated task', () => {
  const challenges = buildCorpus().filter((item) => item.classification !== 'supported');
  assert.equal(challenges.length, 20);
  for (const challenge of challenges) {
    assert.deepEqual(challenge.outputs, RUBRIC_OUTPUTS[challenge.id], challenge.id);
    const prompt = challenge.prompt.toLowerCase();
    for (const output of challenge.outputs) {
      const stem = output.name.replace(/\.[^.]+$/, '');
      assert.ok(prompt.includes(output.name) || prompt.includes(stem) || prompt.includes(stem.replace(/s$/, '')), challenge.id);
    }
    const body = draftInput(challenge);
    assert.deepEqual(body.outputs, challenge.outputs);
    assert.equal(Object.hasOwn(body, 'plan'), false);
    assert.equal(Object.hasOwn(body, 'unsupportedDraft'), false);
  }
});

test('signed requests publish the approved public key and separate illustrative fixtures', () => {
  const challenges = buildCorpus().filter((item) => SIGNED.includes(item.id));
  assert.equal(challenges.length, 4);
  for (const challenge of challenges) {
    const visible = `${challenge.prompt}\n${Object.values(challenge.referenceFiles ?? {}).join('\n')}`;
    assert.equal(visible.includes(challenge.plan.evidence[0].signer), true, challenge.id);
    assert.equal(challenge.plan.evidence[0].signer, syntheticSigner);
    assert.equal(visible.includes(PRIVATE_SEED), false, challenge.id);
    assert.equal(visible.includes(PRIVATE_HEADER), false, challenge.id);
    assert.equal(challenge.exampleFixtures.length, 2, challenge.id);
    const verdicts = challenge.exampleFixtures.map((item) => item.predictedVerdict).sort();
    assert.deepEqual(verdicts, [0, 1]);
    const held = new Set();
    for (const candidate of challenge.candidates) {
      for (const bytes of Object.values(candidate.deliveryFiles)) held.add(Buffer.from(bytes).toString('utf8'));
    }
    held.add(challenge.spec.artifactBytes);
    if (challenge.spec.secondArtifactFile) held.add('other-tag');
    for (const fixture of challenge.exampleFixtures) {
      const syntheticPrefix = `0x01${'aa'.repeat(32)}${'bb'.repeat(20)}${'cc'.repeat(32)}${'dd'.repeat(20)}`;
      assert.equal(fixture.context.startsWith(syntheticPrefix), true, challenge.id);
      assert.match(fixture.context, /^0x01[0-9a-f]{336}$/);
      assert.equal(fixture.evidence.length, 1);
      assert.equal(fixture.evidence[0].name, 'custody.json');
      for (const file of fixture.files) {
        assert.equal(held.has(file.content), false, `${challenge.id}:${file.name}`);
        assert.equal(file.content.includes(PRIVATE_SEED), false);
      }
    }
    const body = draftInput(challenge);
    assert.deepEqual(body.exampleFixtures, challenge.exampleFixtures);
    assert.deepEqual(Object.keys(body), [
      'request', 'outputs', 'references', 'exampleFixtures', 'clarifications', 'expirySeconds', 'maxBudget',
    ]);
    const packed = JSON.stringify(body);
    assert.equal(packed.includes(syntheticSigner), true);
    assert.equal(packed.includes(PRIVATE_SEED), false);
    assert.equal(packed.includes(PRIVATE_HEADER), false);
    assert.equal(Object.hasOwn(body, 'plan'), false);
    assert.equal(Object.hasOwn(body, 'spec'), false);
    assert.equal(Object.hasOwn(body, 'candidates'), false);
    assert.equal(packed.includes('violatedRequirements'), false);
    for (const candidate of challenge.candidates) {
      assert.equal(packed.includes(`"${candidate.id}"`), false, candidate.id);
      for (const bytes of Object.values(candidate.deliveryFiles)) {
        const text = Buffer.from(bytes).toString('utf8');
        assert.equal(packed.includes(text), false, `${challenge.id}:${text}`);
      }
    }
  }
});

test('opaque firmware stays a binary reference in the draft input', () => {
  const challenge = buildCorpus().find((item) => item.id === 'firmware-opaque-1');
  assert.throws(() => new TextDecoder('utf-8', {fatal: true}).decode(challenge.referenceFiles['blob.bin']));
  assert.equal(challenge.outputs.some((item) => item.format === 'binary'), true);
  const body = draftInput(challenge);
  assert.equal(Object.hasOwn(body, 'exampleFixtures'), false);
  assert.equal(body.references.some((item) => item.name === 'blob.bin'), true);
  const decoded = Buffer.from(body.references.find((item) => item.name === 'blob.bin').contentBase64, 'base64');
  assert.deepEqual(decoded, Buffer.from(challenge.referenceFiles['blob.bin']));
});

test('hidden candidates stay fixed while the public digest records the correction', () => {
  const challenges = buildCorpus();
  assert.equal(sha(JSON.stringify(hiddenPack(challenges))), HIDDEN_DIGEST);
  const digest = sha(JSON.stringify(canonicalCorpus(challenges)));
  assert.equal(digest, CORPUS_DIGEST);
  assert.notEqual(digest, PREVIOUS_CORPUS_DIGEST);
  const stripped = canonicalCorpus(challenges).map((item) => {
    const copy = {...item};
    delete copy.facets;
    delete copy.boundary;
    delete copy.outputs;
    delete copy.exampleFixtures;
    delete copy.clarifications;
    return copy;
  });
  const strippedDigest = sha(JSON.stringify(stripped));
  assert.notEqual(strippedDigest, PREVIOUS_CORPUS_DIGEST);
  assert.notEqual(strippedDigest, PRE_FACET_DIGEST);
  const mutated = buildCorpus();
  mutated.find((item) => item.id === 'seal-1').exampleFixtures[0].name = 'altered-fixture';
  assert.notEqual(sha(JSON.stringify(canonicalCorpus(mutated))), digest);
});

test('public fixtures pass or fail in the engine and a bad signature is a rejection', async () => {
  const resolved = resolveEngine();
  assert.equal(resolved.ok, true, resolved.message);
  const challenges = buildCorpus().filter((item) => SIGNED.includes(item.id));
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-fixtures-'));
  try {
    for (const challenge of challenges) {
      const written = await import('./corpus.mjs').then((corpus) => corpus.writeChallenge(challenge, directory));
      const planPath = join(directory, written.planPath);
      const reference = join(directory, written.referencePath);
      for (const fixture of challenge.exampleFixtures) {
        const root = join(directory, 'fixtures', challenge.id, fixture.name);
        await placeFixture(root, fixture);
        const jobPath = join(root, 'job.json');
        await writeFile(jobPath, JSON.stringify({context: fixture.context}));
        const oracle = await evaluateCandidate(challenge, root, {
          referenceDirectory: reference,
          contextHex: fixture.context,
        });
        const actual = runEngine(resolved.engine, [
          'eval', '--plan', planPath, '--deliverables', join(root, 'delivery'),
          '--reference', reference, '--evidence', join(root, 'evidence'), '--job', jobPath,
        ]);
        const status = classifyEvaluation(actual);
        const expected = fixture.predictedVerdict === 1 ? 'pass' : 'fail';
        assert.equal(oracle.status, expected, `${challenge.id}/${fixture.name}`);
        assert.equal(status, expected, `${challenge.id}/${fixture.name}`);
        assert.notEqual(status, 'reject', `${challenge.id}/${fixture.name}`);
      }
      const negative = challenge.exampleFixtures.find((item) => item.predictedVerdict === 0);
      const brokenRoot = join(directory, 'fixtures', challenge.id, 'malformed');
      const broken = structuredClone(negative);
      const envelope = JSON.parse(broken.evidence[0].content);
      const signature = Buffer.from(envelope.signature.slice(2), 'hex');
      signature[0] ^= 1;
      envelope.signature = `0x${signature.toString('hex')}`;
      broken.evidence[0].content = JSON.stringify(envelope);
      await placeFixture(brokenRoot, broken);
      const jobPath = join(brokenRoot, 'job.json');
      await writeFile(jobPath, JSON.stringify({context: broken.context}));
      const oracle = await evaluateCandidate(challenge, brokenRoot, {
        referenceDirectory: reference,
        contextHex: broken.context,
      });
      const actual = runEngine(resolved.engine, [
        'eval', '--plan', planPath, '--deliverables', join(brokenRoot, 'delivery'),
        '--reference', reference, '--evidence', join(brokenRoot, 'evidence'), '--job', jobPath,
      ]);
      assert.equal(oracle.status, 'reject', challenge.id);
      assert.equal(classifyEvaluation(actual), 'reject', challenge.id);
      assert.notEqual(actual.value?.verdict, 0);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

async function placeFixture(root, fixture) {
  await mkdir(join(root, 'delivery'), {recursive: true});
  await mkdir(join(root, 'evidence'), {recursive: true});
  for (const file of fixture.files) await writeFile(join(root, 'delivery', file.name), fileBytes(file));
  for (const file of fixture.evidence ?? []) await writeFile(join(root, 'evidence', file.name), fileBytes(file));
}

test('authoring input source names no personal home path', async () => {
  for (const name of ['corpus.mjs', 'custody-challenges.mjs', 'rubric-challenges.mjs', 'trials.mjs', 'shape.mjs', 'example-approval.mjs']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.equal(source.includes('/Users/'), false, name);
    assert.equal(source.includes('anishnarang'), false, name);
  }
});
