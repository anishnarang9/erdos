import {
  access, all, bin, candidate, count, finish, int, jsonText, lookup, planOf, requirement, rf,
  rowsFile, scalar, sum, table, unique,
} from './shape.mjs';

const deliverableField = (file, field) => ({op: 'field', source: 'deliverable', file, field});
const referenceField = (file, field) => ({op: 'field', source: 'reference', file, field});
const maxI64 = '9223372036854775807';

function massProduct() {
  const product = (concentration, volume, mass) => ({
    'product.json': jsonText({concentration, volume, mass}),
  });
  return finish({
    id: 'mass-1',
    family: 'dilution-quantity',
    spec: {kind: 'mass-product'},
    title: 'Product mass identity',
    prompt: 'Report one product in product.json. concentration, volume, and mass are integer decimal strings. mass equals concentration times volume. A second valid triple is acceptable.',
    requirements: [requirement('mass-identity', 'Keep mass equal to concentration times volume.')],
    plan: planOf(
      [scalar('product.json', {concentration: 'i64', volume: 'i64', mass: 'i64'})],
      [],
      [bin('eq', deliverableField('product.json', 'mass'), bin('mul', deliverableField('product.json', 'concentration'), deliverableField('product.json', 'volume')))],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid-max', product(maxI64, '1', maxI64)),
      candidate('valid-six', product('6', '7', '42')),
      candidate('wrong-mass', product('5', '5', '24'), 'fail', ['mass-identity']),
      candidate('overflow-volume', product(maxI64, '2', '0'), 'reject', ['arithmetic-overflow']),
      candidate('negative-zero', product('1', '-0', '0'), 'reject', ['input-types']),
      candidate('leading-zero', product('2', '01', '2'), 'reject', ['input-types']),
      candidate('above-i64', product('1', '9223372036854775808', '1'), 'reject', ['input-types']),
    ],
  });
}

function yieldRatio() {
  const batches = [
    {batchId: 'batch-a', input: '100', percent: '200'},
    {batchId: 'batch-b', input: '100', percent: '40'},
  ];
  const yields = access('deliverable', 'yields.json');
  const reference = access('reference', 'batches.json');
  const input = lookup(reference, 'batchId', rf('batchId'), 'input');
  const percent = lookup(reference, 'batchId', rf('batchId'), 'percent');
  const files = (rows) => rowsFile('yields.json', rows);
  return finish({
    id: 'yield-1',
    family: 'dilution-quantity',
    spec: {kind: 'yield-ratio'},
    title: 'Batch yield bounds',
    prompt: 'Report an output for every batch. output is an integer decimal string. Use each batchId once and include every batch. output is at most that batch input. output times 100 is at most input times percent. Another pair inside both bounds is acceptable.',
    requirements: [
      requirement('unique-batch', 'Use each batchId once.'),
      requirement('batch-count', 'Include every batch.'),
      requirement('mass-bound', 'Keep output at or below input.'),
      requirement('yield-ratio', 'Keep output times 100 at or below input times percent.'),
    ],
    plan: planOf(
      [table('yields.json', {batchId: 'string', output: 'i64'})],
      [table('batches.json', {batchId: 'string', input: 'i64', percent: 'i64'})],
      [
        unique(yields, 'batchId'),
        bin('eq', count(yields), count(reference)),
        all(yields, bin('eq', rf('batchId'), lookup(reference, 'batchId', rf('batchId'), 'batchId'))),
        all(yields, bin('lte', rf('output'), input)),
        all(yields, bin('lte', bin('mul', rf('output'), int(100)), bin('mul', input, percent))),
      ],
    ),
    referenceFiles: rowsFile('batches.json', batches),
    candidates: [
      candidate('valid-full', files([{batchId: 'batch-a', output: '100'}, {batchId: 'batch-b', output: '40'}])),
      candidate('valid-lower', files([{batchId: 'batch-a', output: '80'}, {batchId: 'batch-b', output: '20'}])),
      candidate('over-mass', files([{batchId: 'batch-a', output: '150'}, {batchId: 'batch-b', output: '40'}]), 'fail', ['mass-bound']),
      candidate('over-yield', files([{batchId: 'batch-a', output: '100'}, {batchId: 'batch-b', output: '50'}]), 'fail', ['yield-ratio']),
      candidate('duplicate-batch', files([{batchId: 'batch-a', output: '100'}, {batchId: 'batch-a', output: '80'}]), 'fail', ['unique-batch']),
      candidate('missing-batch', files([{batchId: 'batch-a', output: '100'}]), 'fail', ['batch-count']),
      candidate('unknown-batch', files([{batchId: 'batch-a', output: '100'}, {batchId: 'batch-z', output: '40'}]), 'reject', ['reference-membership']),
      candidate('numeric-output', files([{batchId: 'batch-a', output: 100}, {batchId: 'batch-b', output: '40'}]), 'reject', ['input-types']),
    ],
  });
}

function mixtureSplit() {
  const parts = access('deliverable', 'parts.json');
  const files = (rows) => rowsFile('parts.json', rows);
  return finish({
    id: 'mixture-1',
    family: 'dilution-quantity',
    spec: {kind: 'mixture-split'},
    title: 'Mixture share split',
    prompt: 'Split a mixture into parts.json rows. share is an integer decimal string. Use each partId once. Each share is at most policy.json cap. The shares sum to policy.json total. Another valid split is acceptable.',
    requirements: [
      requirement('unique-part', 'Use each partId once.'),
      requirement('part-cap', 'Keep each share at or below cap.'),
      requirement('part-sum', 'Make the shares sum to total.'),
    ],
    plan: planOf(
      [table('parts.json', {partId: 'string', share: 'i64'})],
      [scalar('policy.json', {cap: 'i64', total: 'i64'})],
      [
        unique(parts, 'partId'),
        all(parts, bin('lte', rf('share'), referenceField('policy.json', 'cap'))),
        bin('eq', sum(parts, rf('share')), referenceField('policy.json', 'total')),
      ],
    ),
    referenceFiles: {'policy.json': jsonText({cap: '70', total: '100'})},
    candidates: [
      candidate('valid-sixty', files([{partId: 'pigment', share: '60'}, {partId: 'binder', share: '40'}])),
      candidate('valid-thirty', files([{partId: 'pigment', share: '30'}, {partId: 'binder', share: '70'}])),
      candidate('over-cap', files([{partId: 'pigment', share: '80'}, {partId: 'binder', share: '20'}]), 'fail', ['part-cap']),
      candidate('short-sum', files([{partId: 'pigment', share: '70'}, {partId: 'binder', share: '20'}]), 'fail', ['part-sum']),
      candidate('duplicate-part', files([{partId: 'pigment', share: '60'}, {partId: 'pigment', share: '40'}]), 'fail', ['unique-part']),
      candidate('numeric-share', files([{partId: 'pigment', share: 60}, {partId: 'binder', share: '40'}]), 'reject', ['input-types']),
    ],
  });
}

function dilutionLimit() {
  const samples = [
    {sampleId: 'sample-1', stock: '100', limit: '30', final: '10'},
    {sampleId: 'sample-2', stock: '50', limit: '10', final: '10'},
  ];
  const takes = access('deliverable', 'takes.json');
  const reference = access('reference', 'samples.json');
  const stock = lookup(reference, 'sampleId', rf('sampleId'), 'stock');
  const limit = lookup(reference, 'sampleId', rf('sampleId'), 'limit');
  const finalAmount = lookup(reference, 'sampleId', rf('sampleId'), 'final');
  const files = (rows) => rowsFile('takes.json', rows);
  return finish({
    id: 'dilution-1',
    family: 'dilution-quantity',
    spec: {kind: 'dilution-limit'},
    title: 'Dilution take limit',
    prompt: 'Choose a take for every sample. take is an integer decimal string. Use each sampleId once and include every sample. stock times take is at most limit times final. Another valid pair of takes is acceptable.',
    requirements: [
      requirement('unique-sample', 'Use each sampleId once.'),
      requirement('sample-count', 'Include every sample.'),
      requirement('dilution-limit', 'Keep stock times take at or below limit times final.'),
    ],
    plan: planOf(
      [table('takes.json', {sampleId: 'string', take: 'i64'})],
      [table('samples.json', {sampleId: 'string', stock: 'i64', limit: 'i64', final: 'i64'})],
      [
        unique(takes, 'sampleId'),
        bin('eq', count(takes), count(reference)),
        all(takes, bin('eq', rf('sampleId'), lookup(reference, 'sampleId', rf('sampleId'), 'sampleId'))),
        all(takes, bin('lte', bin('mul', stock, rf('take')), bin('mul', limit, finalAmount))),
      ],
    ),
    referenceFiles: rowsFile('samples.json', samples),
    candidates: [
      candidate('valid-low', files([{sampleId: 'sample-1', take: '2'}, {sampleId: 'sample-2', take: '1'}])),
      candidate('valid-edge', files([{sampleId: 'sample-1', take: '3'}, {sampleId: 'sample-2', take: '2'}])),
      candidate('over-limit', files([{sampleId: 'sample-1', take: '4'}, {sampleId: 'sample-2', take: '1'}]), 'fail', ['dilution-limit']),
      candidate('duplicate-sample', files([{sampleId: 'sample-1', take: '2'}, {sampleId: 'sample-1', take: '3'}]), 'fail', ['unique-sample']),
      candidate('missing-sample', files([{sampleId: 'sample-1', take: '2'}]), 'fail', ['sample-count']),
      candidate('unknown-sample', files([{sampleId: 'sample-1', take: '2'}, {sampleId: 'sample-z', take: '1'}]), 'reject', ['reference-membership']),
      candidate('numeric-take', files([{sampleId: 'sample-1', take: 2}, {sampleId: 'sample-2', take: '1'}]), 'reject', ['input-types']),
    ],
  });
}

export function quantityChallenges() {
  return [massProduct(), yieldRatio(), mixtureSplit(), dilutionLimit()];
}
