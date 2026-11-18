import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const context = '0x01' + 'ab'.repeat(168);

async function load() {
  const corpus = await import('./corpus.mjs');
  const oracle = await import('./oracle.mjs');
  return {corpus, oracle};
}

function pierChallenge() {
  const text = 'Pier Saturday closed.\n';
  const field = (name, type) => ({name, type});
  const rows = (name, fields) => ({name, parser: 'json/v1', collections: [{name: 'rows', fields}]});
  return {
    classification: 'supported',
    spec: {kind: 'drawer-exact', text},
    schema: {
      deliverables: [
        rows('drawers.json', [field('drawerId', 'string'), field('countedCents', 'i64')]),
        {name: 'closeout.txt', parser: 'text/v1'},
      ],
      references: [rows('floats.json', [field('drawerId', 'string'), field('expectedCents', 'i64')])],
      evidence: [],
    },
  };
}

const pierRows = '{"rows":[{"drawerId":"drawer-a","countedCents":"400"},{"drawerId":"drawer-b","countedCents":"250"},{"drawerId":"drawer-c","countedCents":"125"}]}';
const pierFloats = '{"rows":[{"drawerId":"drawer-a","expectedCents":"400"},{"drawerId":"drawer-b","expectedCents":"250"},{"drawerId":"drawer-c","expectedCents":"125"}]}';
const pierCloseout = 'Pier Saturday closed.\n';

async function evaluatePier(oracle, drawers) {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-proto-'));
  const candidate = join(directory, 'candidate');
  const reference = join(directory, 'reference');
  await mkdir(join(candidate, 'delivery'), {recursive: true});
  await mkdir(reference, {recursive: true});
  await writeFile(join(candidate, 'delivery', 'drawers.json'), drawers);
  await writeFile(join(candidate, 'delivery', 'closeout.txt'), pierCloseout);
  await writeFile(join(reference, 'floats.json'), pierFloats);
  try {
    return await oracle.evaluateCandidate(pierChallenge(), candidate, {referenceDirectory: reference, contextHex: context});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('duplicate __proto__ keys reject while a duplicate drawer id fails', async () => {
  const oracle = await import('./oracle.mjs');
  const duplicated = pierRows.replace(/}$/, ',"__proto__":{},"__proto__":{}}');
  const actual = await evaluatePier(oracle, duplicated);
  assert.equal(actual.status, 'reject');
  assert.equal(actual.verdict, null);
  assert.deepEqual(actual.violatedRequirements, ['duplicate-key']);

  const escaped = pierRows.replace(/}$/, ',"__pr\\u006fto__":{},"__proto__":{}}');
  const escapedResult = await evaluatePier(oracle, escaped);
  assert.equal(escapedResult.status, 'reject');
  assert.deepEqual(escapedResult.violatedRequirements, ['duplicate-key']);

  const once = await evaluatePier(oracle, pierRows.replace(/}$/, ',"__proto__":{}}'));
  assert.equal(once.status, 'pass');

  const semantic = pierRows.replace(
    '"drawer-b","countedCents":"250"',
    '"drawer-a","countedCents":"400"',
  );
  const failed = await evaluatePier(oracle, semantic);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.verdict, 0);
  assert.deepEqual(failed.violatedRequirements, ['unique-drawer']);
});

test('non-finite JSON numbers reject and finite unknown fields stay semantic', async () => {
  const oracle = await import('./oracle.mjs');
  const infinite = await evaluatePier(oracle, pierRows.replace(/}$/, ',"padding":1e999}'));
  assert.equal(infinite.status, 'reject');
  assert.equal(infinite.verdict, null);
  assert.deepEqual(infinite.violatedRequirements, ['input-types']);

  const negative = await evaluatePier(oracle, pierRows.replace(/}$/, ',"padding":-1e999}'));
  assert.equal(negative.status, 'reject');
  assert.deepEqual(negative.violatedRequirements, ['input-types']);

  const finite = await evaluatePier(oracle, pierRows.replace(/}$/, ',"padding":1e2}'));
  assert.equal(finite.status, 'pass');
  assert.equal(finite.verdict, 1);

  const semantic = pierRows.replace(
    '"drawer-b","countedCents":"250"',
    '"drawer-a","countedCents":"400"',
  ).replace(/}$/, ',"padding":12}');
  const failed = await evaluatePier(oracle, semantic);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.verdict, 0);
  assert.deepEqual(failed.violatedRequirements, ['unique-drawer']);
});

test('non-canonical i64 strings reject and ordinary integers stay semantic', async () => {
  const oracle = await import('./oracle.mjs');
  const negativeZero = pierRows.replace('"countedCents":"400"', '"countedCents":"-0"');
  const rejectedZero = await evaluatePier(oracle, negativeZero);
  assert.equal(rejectedZero.status, 'reject');
  assert.deepEqual(rejectedZero.violatedRequirements, ['input-types']);

  const leading = pierRows.replace('"countedCents":"400"', '"countedCents":"01"');
  const rejectedLeading = await evaluatePier(oracle, leading);
  assert.equal(rejectedLeading.status, 'reject');
  assert.deepEqual(rejectedLeading.violatedRequirements, ['input-types']);

  const zero = pierRows.replace('"countedCents":"400"', '"countedCents":"0"');
  const zeroResult = await evaluatePier(oracle, zero);
  assert.equal(zeroResult.status, 'fail');
  assert.equal(zeroResult.verdict, 0);
  assert.deepEqual(zeroResult.violatedRequirements, ['exact-count']);

  const negative = pierRows.replace('"countedCents":"400"', '"countedCents":"-1"');
  const negativeResult = await evaluatePier(oracle, negative);
  assert.equal(negativeResult.status, 'fail');
  assert.deepEqual(negativeResult.violatedRequirements, ['exact-count']);

  const max = pierRows.replace('"countedCents":"400"', '"countedCents":"9223372036854775807"');
  const maxResult = await evaluatePier(oracle, max);
  assert.equal(maxResult.status, 'fail');
  assert.deepEqual(maxResult.violatedRequirements, ['exact-count']);
});

test('JSON depth and lone surrogates reject without leaving the oracle', async () => {
  const oracle = await import('./oracle.mjs');
  let deep = '"x"';
  for (let level = 0; level < 4000; level += 1) deep = `{"a":${deep}}`;
  const nested = pierRows.replace(/}$/, `,"pad":${deep}}`);
  const depth = await evaluatePier(oracle, nested);
  assert.equal(depth.status, 'reject');
  assert.deepEqual(depth.violatedRequirements, ['input-types']);

  const lone = pierRows.replace(/}$/, ',"note":"\\uD800"}');
  const surrogate = await evaluatePier(oracle, lone);
  assert.equal(surrogate.status, 'reject');
  assert.deepEqual(surrogate.violatedRequirements, ['input-types']);

  const pair = pierRows.replace(/}$/, ',"note":"\\uD800\\uDC00"}');
  const accepted = await evaluatePier(oracle, pair);
  assert.equal(accepted.status, 'pass');
});

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

test('supported candidates match the independent oracle', async () => {
  const {corpus, oracle} = await load();
  const challenges = corpus.buildCorpus().filter((item) => item.classification === 'supported');
  assert.deepEqual(challenges.map((item) => item.id), [
    'pier-drawers', 'pier-variance', 'tender-split', 'voyage-fee',
    'lot-range-1', 'lot-expiry-1', 'lot-sites-1', 'sensor-1',
    'category-1', 'indirect-1', 'crew-gear-1', 'cover-1',
    'badge-zone-1', 'clearance-1', 'queue-1', 'purpose-1',
    'nights-1', 'instrument-1', 'usable-1', 'programs-1',
    'berth-fit-1', 'berth-fee-1', 'berth-open-1', 'berth-swap-1',
    'route-1', 'route-open-1', 'route-fixed-1', 'route-penalty-1',
    'mass-1', 'yield-1', 'mixture-1', 'dilution-1',
    'seal-1', 'crate-1', 'transfer-1', 'dual-seal-1',
    'firmware-1', 'firmware-pair-1', 'firmware-note-1', 'firmware-opaque-1',
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-corpus-'));
  try {
    for (const challenge of challenges) {
      assert.ok(challenge.candidates.some((item) => item.expected.status === 'pass'), challenge.id);
      assert.ok(challenge.candidates.some((item) => item.expected.status === 'reject'), challenge.id);
      for (const requirement of challenge.requirements) {
        assert.ok(
          challenge.candidates.some((item) => item.expected.violatedRequirements.length === 1
            && item.expected.violatedRequirements[0] === requirement.id),
          `${challenge.id}:${requirement.id}`,
        );
      }
      const written = await corpus.writeChallenge(challenge, directory);
      for (const candidate of written.candidates) {
        await corpus.writeCandidateEvidence(challenge, candidate, join(directory, candidate.path), context);
        const actual = await oracle.evaluateCandidate(challenge, join(directory, candidate.path), {
          referenceDirectory: join(directory, written.referencePath),
          contextHex: context,
        });
        assert.equal(actual.status, candidate.expected.status, `${challenge.id}/${candidate.id}`);
        assert.deepEqual(actual.violatedRequirements, candidate.expected.violatedRequirements, `${challenge.id}/${candidate.id}`);
      }
      const rules = challenge.plan.rules;
      challenge.plan.rules = [{op: 'literal', type: 'bool', value: true}];
      const failed = written.candidates.find((item) => item.expected.status === 'fail');
      const ignored = await oracle.evaluateCandidate(challenge, join(directory, failed.path), {
        referenceDirectory: join(directory, written.referencePath),
        contextHex: context,
      });
      challenge.plan.rules = rules;
      assert.equal(ignored.status, 'fail', challenge.id);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('the frozen corpus has 40 supported, 10 ambiguous, and 10 unsupported requests', async () => {
  const {corpus} = await load();
  const challenges = corpus.buildCorpus();
  const counts = {supported: 0, ambiguous: 0, unsupported: 0};
  const banned = /^(expense|ledger|inventory|schedule|file|signed|ambiguous|unsupported)-/;
  const historical = ['expenses.json', 'stock.json', 'assignments.json', 'note.txt'];
  assert.equal(new Set(challenges.map((item) => item.id)).size, 60);
  for (const challenge of challenges) {
    counts[challenge.classification] += 1;
    assert.equal(banned.test(challenge.id), false, challenge.id);
    assert.equal(challenge.prompt.includes('violatedRequirements'), false, challenge.id);
    const packed = JSON.stringify(challenge.plan ?? challenge.unsupportedDraft ?? {});
    for (const name of historical) assert.equal(packed.includes(name), false, `${challenge.id}:${name}`);
    if (challenge.classification === 'ambiguous') {
      assert.equal(challenge.plan, undefined);
      assert.ok(challenge.clarificationQuestions.length >= 1 && challenge.clarificationQuestions.length <= 5);
      assert.ok(challenge.facets.every((facet) => typeof facet === 'string' && challenge.clarificationQuestions.some((question) => question.includes(facet))));
    }
    if (challenge.classification === 'unsupported') {
      assert.equal(challenge.capabilityRequests.length, 1);
      assert.equal(typeof challenge.boundary, 'string');
      assert.ok(challenge.unsupportedDraft);
    }
  }
  assert.deepEqual(counts, {supported: 40, ambiguous: 10, unsupported: 10});
  assert.equal(new Set(challenges.filter((item) => item.classification === 'supported').map((item) => item.family)).size, 10);
  const {createHash} = await import('node:crypto');
  const digest = createHash('sha256').update(JSON.stringify(corpus.canonicalCorpus(challenges))).digest('hex');
  assert.equal(digest, corpus.CORPUS_DIGEST);
});

test('rubric facet and boundary mutations change the frozen canonical corpus', async () => {
  const {corpus} = await load();
  const original = JSON.stringify(corpus.canonicalCorpus(corpus.buildCorpus()));
  const mutated = corpus.buildCorpus();
  const ambiguous = mutated.find((item) => item.classification === 'ambiguous');
  const unsupported = mutated.find((item) => item.classification === 'unsupported');
  ambiguous.facets = ['altered rubric'];
  unsupported.boundary = 'altered boundary';
  assert.notEqual(JSON.stringify(corpus.canonicalCorpus(mutated)), original);
  const outputs = corpus.buildCorpus();
  const supported = outputs.find((item) => item.classification === 'supported');
  supported.outputs = [{name: 'altered.json', format: 'json'}];
  assert.notEqual(JSON.stringify(corpus.canonicalCorpus(outputs)), original);
});
