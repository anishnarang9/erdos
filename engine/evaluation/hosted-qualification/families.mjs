import {
  access, all, bin, candidate, count, finish, int, jsonText, lookup, mutate, planOf, requirement,
  rf, rowsFile, scalar, str, sum, table, textFile, unique,
} from './shape.mjs';

const filesOf = (rows, text) => ({...rowsFile('drawers.json', rows), 'closeout.txt': text});

function pierDrawers() {
  const rows = [
    {drawerId: 'drawer-a', countedCents: '400'},
    {drawerId: 'drawer-b', countedCents: '250'},
    {drawerId: 'drawer-c', countedCents: '125'},
  ];
  const text = 'Pier Saturday closed.\n';
  const delivery = access('deliverable', 'drawers.json');
  const reference = access('reference', 'floats.json');
  return finish({
    id: 'pier-drawers',
    family: 'pier-reconciliation',
    spec: {kind: 'drawer-exact', text},
    title: 'Reconcile Saturday pier drawers',
    prompt: 'Reconcile the Saturday pier drawers against floats.json. Amounts are integer cents as decimal strings. Use each drawerId once. Include every drawer in floats.json. Match each countedCents value to that drawer expectedCents value. Set closeout.txt to exactly "Pier Saturday closed.\\n". A second row order is acceptable. Do not treat one file hash as the only accepted answer.',
    requirements: [
      requirement('unique-drawer', 'Use each drawerId once.'),
      requirement('drawer-count', 'Include every drawer in floats.json.'),
      requirement('exact-count', 'Match each countedCents value to that drawer expectedCents value.'),
      requirement('closeout-text', 'Set closeout.txt to exactly "Pier Saturday closed.\\n".'),
    ],
    plan: planOf(
      [table('drawers.json', {drawerId: 'string', countedCents: 'i64'}), textFile('closeout.txt')],
      [table('floats.json', {drawerId: 'string', expectedCents: 'i64'})],
      [
        unique(delivery, 'drawerId'),
        bin('eq', count(delivery), count(reference)),
        all(delivery, bin('eq', rf('countedCents'), lookup(reference, 'drawerId', rf('drawerId'), 'expectedCents'))),
        bin('eq', {op: 'field', source: 'deliverable', file: 'closeout.txt'}, str(text)),
      ],
    ),
    referenceFiles: rowsFile('floats.json', rows.map((row) => ({drawerId: row.drawerId, expectedCents: row.countedCents}))),
    candidates: [
      candidate('valid', filesOf(rows, text)),
      candidate('valid-reordered', filesOf([...rows].reverse(), text)),
      candidate('duplicate-drawer', filesOf(mutate(rows, (value) => {
        value[1].drawerId = value[0].drawerId;
        value[1].countedCents = value[0].countedCents;
      }), text), 'fail', ['unique-drawer']),
      candidate('missing-drawer', filesOf(rows.slice(0, 2), text), 'fail', ['drawer-count']),
      candidate('wrong-count', filesOf(mutate(rows, (value) => {
        value[0].countedCents = '1';
      }), text), 'fail', ['exact-count']),
      candidate('wrong-closeout', filesOf(rows, 'Pier Saturday closed.'), 'fail', ['closeout-text']),
      candidate('unknown-drawer', filesOf(mutate(rows, (value) => {
        value[0].drawerId = 'drawer-z';
      }), text), 'reject', ['reference-membership']),
      candidate('numeric-amount', filesOf(mutate(rows, (value) => {
        value[0].countedCents = 400;
      }), text), 'reject', ['input-types']),
    ],
  });
}

function pierVariance() {
  const rows = [
    {drawerId: 'drawer-a', countedCents: '400', sealedCents: '0'},
    {drawerId: 'drawer-b', countedCents: '250', sealedCents: '0'},
    {drawerId: 'drawer-c', countedCents: '125', sealedCents: '0'},
  ];
  const alternate = [
    {drawerId: 'drawer-a', countedCents: '250', sealedCents: '150'},
    {drawerId: 'drawer-b', countedCents: '100', sealedCents: '150'},
    {drawerId: 'drawer-c', countedCents: '25', sealedCents: '100'},
  ];
  const delivery = access('deliverable', 'drawers.json');
  const reference = access('reference', 'floats.json');
  const files = (next) => rowsFile('drawers.json', next);
  return finish({
    id: 'pier-variance',
    family: 'pier-reconciliation',
    spec: {kind: 'drawer-variance'},
    title: 'Reconcile sealed pier drawer variance',
    prompt: 'Reconcile sealed pier drawers against floats.json. Amounts are integer cents as decimal strings. Use each drawerId once. Include every drawer in floats.json. For each drawer, sealedCents plus countedCents minus expectedCents equals 0. A second split of the same expected total is acceptable. Do not treat one file hash as the only accepted answer.',
    requirements: [
      requirement('unique-drawer', 'Use each drawerId once.'),
      requirement('drawer-count', 'Include every drawer in floats.json.'),
      requirement('variance', 'Make sealedCents plus countedCents minus expectedCents equal 0.'),
    ],
    plan: planOf(
      [table('drawers.json', {drawerId: 'string', countedCents: 'i64', sealedCents: 'i64'})],
      [table('floats.json', {drawerId: 'string', expectedCents: 'i64'})],
      [
        unique(delivery, 'drawerId'),
        bin('eq', count(delivery), count(reference)),
        all(delivery, bin('eq', bin('sub', bin('add', rf('sealedCents'), rf('countedCents')), lookup(reference, 'drawerId', rf('drawerId'), 'expectedCents')), int(0))),
      ],
    ),
    referenceFiles: rowsFile('floats.json', rows.map((row) => ({drawerId: row.drawerId, expectedCents: row.countedCents}))),
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-split', files(alternate)),
      candidate('duplicate-drawer', files(mutate(rows, (value) => {
        value[1] = {...value[0]};
      })), 'fail', ['unique-drawer']),
      candidate('missing-drawer', files(rows.slice(0, 2)), 'fail', ['drawer-count']),
      candidate('off-variance', files(mutate(rows, (value) => {
        value[0].countedCents = '401';
      })), 'fail', ['variance']),
      candidate('unknown-drawer', files(mutate(rows, (value) => {
        value[0].drawerId = 'drawer-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-sealed', files(mutate(rows, (value) => {
        value[0].sealedCents = 0;
      })), 'reject', ['input-types']),
    ],
  });
}

function tenderSplit() {
  const cash = [{slipId: 'cash-1', amountCents: '300'}];
  const checks = [{slipId: 'check-1', amountCents: '200'}];
  const cashDelivery = access('deliverable', 'cash.json');
  const checkDelivery = access('deliverable', 'checks.json');
  const files = (nextCash, nextChecks) => ({
    ...rowsFile('cash.json', nextCash),
    ...rowsFile('checks.json', nextChecks),
  });
  return finish({
    id: 'tender-split',
    family: 'pier-reconciliation',
    spec: {kind: 'tender-split'},
    title: 'Split the Saturday pier tender',
    prompt: 'Split the Saturday pier tender across cash.json and checks.json. Amounts are integer cents as decimal strings. Use each slipId once inside its own file. The sum of cash amountCents plus the sum of check amountCents equals settlement.json totalCents. Different splits that reach that total are acceptable.',
    requirements: [
      requirement('unique-cash', 'Use each cash slipId once.'),
      requirement('unique-check', 'Use each check slipId once.'),
      requirement('tender-total', 'Make cash plus checks equal settlement.json totalCents.'),
    ],
    plan: planOf(
      [
        table('cash.json', {slipId: 'string', amountCents: 'i64'}),
        table('checks.json', {slipId: 'string', amountCents: 'i64'}),
      ],
      [scalar('settlement.json', {totalCents: 'i64'})],
      [
        unique(cashDelivery, 'slipId'),
        unique(checkDelivery, 'slipId'),
        bin('eq', bin('add', sum(cashDelivery, rf('amountCents')), sum(checkDelivery, rf('amountCents'))), {op: 'field', source: 'reference', file: 'settlement.json', field: 'totalCents'}),
      ],
    ),
    referenceFiles: {'settlement.json': jsonText({totalCents: '500'})},
    candidates: [
      candidate('valid', files(cash, checks)),
      candidate('valid-other-split', files(
        [{slipId: 'cash-1', amountCents: '100'}, {slipId: 'cash-2', amountCents: '50'}],
        [{slipId: 'check-9', amountCents: '350'}],
      )),
      candidate('duplicate-cash', files([
        {slipId: 'cash-1', amountCents: '100'},
        {slipId: 'cash-1', amountCents: '200'},
      ], checks), 'fail', ['unique-cash']),
      candidate('duplicate-check', files(cash, [
        {slipId: 'check-1', amountCents: '50'},
        {slipId: 'check-1', amountCents: '150'},
      ]), 'fail', ['unique-check']),
      candidate('short-total', files([{slipId: 'cash-1', amountCents: '300'}], [{slipId: 'check-1', amountCents: '100'}]), 'fail', ['tender-total']),
      candidate('numeric-amount', files(mutate(cash, (value) => {
        value[0].amountCents = 300;
      }), checks), 'reject', ['input-types']),
    ],
  });
}

function voyageFee() {
  const text = 'Voyage fee posted.\n';
  const fee = (tenderCents, settledCents, feeCents) => ({
    'fee.json': jsonText({tenderCents, settledCents, feeCents}),
    'receipt.txt': text,
  });
  const tender = {op: 'field', source: 'deliverable', file: 'fee.json', field: 'tenderCents'};
  const settled = {op: 'field', source: 'deliverable', file: 'fee.json', field: 'settledCents'};
  const posted = {op: 'field', source: 'deliverable', file: 'fee.json', field: 'feeCents'};
  return finish({
    id: 'voyage-fee',
    family: 'pier-reconciliation',
    spec: {kind: 'voyage-fee', text},
    title: 'Post the voyage fee',
    prompt: 'Post the voyage fee. Amounts are integer cents as decimal strings. feeCents equals tenderCents minus settledCents, and feeCents is greater than or equal to 0. Set receipt.txt to exactly "Voyage fee posted.\\n". Another tender and settled pair with that same identity is acceptable.',
    requirements: [
      requirement('fee-identity', 'Set feeCents to tenderCents minus settledCents.'),
      requirement('nonnegative-fee', 'Keep feeCents greater than or equal to 0.'),
      requirement('receipt-text', 'Set receipt.txt to exactly "Voyage fee posted.\\n".'),
    ],
    plan: planOf(
      [scalar('fee.json', {tenderCents: 'i64', settledCents: 'i64', feeCents: 'i64'}), textFile('receipt.txt')],
      [],
      [
        bin('eq', bin('sub', tender, settled), posted),
        bin('gte', posted, int(0)),
        bin('eq', {op: 'field', source: 'deliverable', file: 'receipt.txt'}, str(text)),
      ],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid', fee('800', '650', '150')),
      candidate('valid-lower-settlement', fee('800', '500', '300')),
      candidate('wrong-fee', fee('800', '650', '149'), 'fail', ['fee-identity']),
      candidate('negative-fee', fee('100', '150', '-50'), 'fail', ['nonnegative-fee']),
      candidate('wrong-receipt', {...fee('800', '650', '150'), 'receipt.txt': 'Voyage fee posted.'}, 'fail', ['receipt-text']),
      candidate('numeric-tender', {
        'fee.json': jsonText({tenderCents: 800, settledCents: '650', feeCents: '150'}),
        'receipt.txt': text,
      }, 'reject', ['input-types']),
    ],
  });
}

export function buildChallenges() {
  return [pierDrawers(), pierVariance(), tenderSplit(), voyageFee()];
}
