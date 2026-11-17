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

function lotRange() {
  const catalog = [
    {lotId: 'lot-p', floor: '2', ceiling: '5', cold: true},
    {lotId: 'lot-q', floor: '1', ceiling: '4', cold: false},
  ];
  const rows = [
    {lotId: 'lot-p', vials: '2', coldOk: true},
    {lotId: 'lot-q', vials: '1', coldOk: false},
  ];
  const delivery = access('deliverable', 'vials.json');
  const reference = access('reference', 'lots.json');
  const files = (next) => rowsFile('vials.json', next);
  return finish({
    id: 'lot-range-1',
    family: 'pharmacy-inventory',
    spec: {kind: 'lot-range'},
    title: 'Check pharmacy lot ranges',
    prompt: 'Check pharmacy lot vials against lots.json. Counts are integer decimal strings. Use each lotId once. Each vials value is at least that lot floor and at most that lot ceiling. coldOk equals that lot cold flag. The sum of vials is at most capacity.json capacity. A second set of in-range counts is acceptable.',
    requirements: [
      requirement('unique-lot', 'Use each lotId once.'),
      requirement('floor', 'Keep vials at or above the lot floor.'),
      requirement('ceiling', 'Keep vials at or below the lot ceiling.'),
      requirement('cold-chain', 'Match coldOk to the lot cold flag.'),
      requirement('capacity', 'Keep the sum of vials at or below capacity.'),
    ],
    plan: planOf(
      [table('vials.json', {lotId: 'string', vials: 'i64', coldOk: 'bool'})],
      [table('lots.json', {lotId: 'string', floor: 'i64', ceiling: 'i64', cold: 'bool'}), scalar('capacity.json', {capacity: 'i64'})],
      [
        unique(delivery, 'lotId'),
        all(delivery, bin('gte', rf('vials'), lookup(reference, 'lotId', rf('lotId'), 'floor'))),
        all(delivery, bin('lte', rf('vials'), lookup(reference, 'lotId', rf('lotId'), 'ceiling'))),
        all(delivery, bin('eq', rf('coldOk'), lookup(reference, 'lotId', rf('lotId'), 'cold'))),
        bin('lte', sum(delivery, rf('vials')), {op: 'field', source: 'reference', file: 'capacity.json', field: 'capacity'}),
      ],
    ),
    referenceFiles: {...rowsFile('lots.json', catalog), 'capacity.json': jsonText({capacity: '8'})},
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-higher', files([
        {lotId: 'lot-p', vials: '5', coldOk: true},
        {lotId: 'lot-q', vials: '3', coldOk: false},
      ])),
      candidate('duplicate-lot', files([
        {lotId: 'lot-p', vials: '2', coldOk: true},
        {lotId: 'lot-p', vials: '2', coldOk: true},
      ]), 'fail', ['unique-lot']),
      candidate('below-floor', files(mutate(rows, (value) => {
        value[0].vials = '1';
      })), 'fail', ['floor']),
      candidate('above-ceiling', files(mutate(rows, (value) => {
        value[0].vials = '6';
      })), 'fail', ['ceiling']),
      candidate('warm-lot', files(mutate(rows, (value) => {
        value[0].coldOk = false;
      })), 'fail', ['cold-chain']),
      candidate('over-capacity', files([
        {lotId: 'lot-p', vials: '5', coldOk: true},
        {lotId: 'lot-q', vials: '4', coldOk: false},
      ]), 'fail', ['capacity']),
      candidate('unknown-lot', files(mutate(rows, (value) => {
        value[0].lotId = 'lot-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-vials', files(mutate(rows, (value) => {
        value[0].vials = 2;
      })), 'reject', ['input-types']),
    ],
  });
}

function lotExpiry() {
  const catalog = [
    {lotId: 'lot-p', maxDay: '10'},
    {lotId: 'lot-q', maxDay: '12'},
  ];
  const rows = [
    {lotId: 'lot-p', expiryDay: '10'},
    {lotId: 'lot-q', expiryDay: '12'},
  ];
  const delivery = access('deliverable', 'expiry.json');
  const reference = access('reference', 'lots.json');
  const files = (next) => rowsFile('expiry.json', next);
  return finish({
    id: 'lot-expiry-1',
    family: 'pharmacy-inventory',
    spec: {kind: 'lot-expiry'},
    title: 'Check pharmacy lot expiry',
    prompt: 'Check pharmacy expiry days against lots.json. Days are integer decimal strings. Use each lotId once. Include every lot. Each expiryDay is at most that lot maxDay. An earlier day is acceptable.',
    requirements: [
      requirement('unique-lot', 'Use each lotId once.'),
      requirement('lot-count', 'Include every lot in lots.json.'),
      requirement('expiry', 'Keep expiryDay at or below maxDay.'),
    ],
    plan: planOf(
      [table('expiry.json', {lotId: 'string', expiryDay: 'i64'})],
      [table('lots.json', {lotId: 'string', maxDay: 'i64'})],
      [
        unique(delivery, 'lotId'),
        bin('eq', count(delivery), count(reference)),
        all(delivery, bin('lte', rf('expiryDay'), lookup(reference, 'lotId', rf('lotId'), 'maxDay'))),
      ],
    ),
    referenceFiles: rowsFile('lots.json', catalog),
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-earlier', files([
        {lotId: 'lot-p', expiryDay: '4'},
        {lotId: 'lot-q', expiryDay: '1'},
      ])),
      candidate('duplicate-lot', files([
        {lotId: 'lot-p', expiryDay: '10'},
        {lotId: 'lot-p', expiryDay: '10'},
      ]), 'fail', ['unique-lot']),
      candidate('missing-lot', files(rows.slice(0, 1)), 'fail', ['lot-count']),
      candidate('late-expiry', files(mutate(rows, (value) => {
        value[0].expiryDay = '11';
      })), 'fail', ['expiry']),
      candidate('unknown-lot', files(mutate(rows, (value) => {
        value[0].lotId = 'lot-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-day', files(mutate(rows, (value) => {
        value[0].expiryDay = 10;
      })), 'reject', ['input-types']),
    ],
  });
}

function lotSites() {
  const catalog = [
    {lotId: 'lot-p', total: '10'},
    {lotId: 'lot-q', total: '6'},
  ];
  const north = access('deliverable', 'north.json');
  const south = access('deliverable', 'south.json');
  const reference = access('reference', 'catalog.json');
  const files = (nextNorth, nextSouth) => ({...rowsFile('north.json', nextNorth), ...rowsFile('south.json', nextSouth)});
  return finish({
    id: 'lot-sites-1',
    family: 'pharmacy-inventory',
    spec: {kind: 'lot-sites'},
    title: 'Balance pharmacy site totals',
    prompt: 'Balance north.json and south.json against catalog.json. Counts are integer decimal strings. Use each lotId once inside each site file. The sum of north vials plus the sum of south vials equals the sum of catalog total values. Per-lot equality is not required. A second distribution of the same combined total is acceptable.',
    requirements: [
      requirement('unique-north', 'Use each north lotId once.'),
      requirement('unique-south', 'Use each south lotId once.'),
      requirement('site-total', 'Make north plus south equal the catalog total.'),
    ],
    plan: planOf(
      [table('north.json', {lotId: 'string', vials: 'i64'}), table('south.json', {lotId: 'string', vials: 'i64'})],
      [table('catalog.json', {lotId: 'string', total: 'i64'})],
      [
        unique(north, 'lotId'),
        unique(south, 'lotId'),
        bin('eq', bin('add', sum(north, rf('vials')), sum(south, rf('vials'))), sum(reference, rf('total'))),
      ],
    ),
    referenceFiles: rowsFile('catalog.json', catalog),
    candidates: [
      candidate('valid', files([{lotId: 'lot-p', vials: '10'}], [{lotId: 'lot-q', vials: '6'}])),
      candidate('valid-reshuffle', files(
        [{lotId: 'lot-p', vials: '4'}, {lotId: 'lot-q', vials: '1'}],
        [{lotId: 'lot-p', vials: '6'}, {lotId: 'lot-q', vials: '5'}],
      )),
      candidate('duplicate-north', files([
        {lotId: 'lot-p', vials: '8'},
        {lotId: 'lot-p', vials: '2'},
      ], [{lotId: 'lot-q', vials: '6'}]), 'fail', ['unique-north']),
      candidate('duplicate-south', files([{lotId: 'lot-p', vials: '10'}], [
        {lotId: 'lot-q', vials: '3'},
        {lotId: 'lot-q', vials: '3'},
      ]), 'fail', ['unique-south']),
      candidate('short-total', files([{lotId: 'lot-p', vials: '10'}], [{lotId: 'lot-q', vials: '5'}]), 'fail', ['site-total']),
      candidate('numeric-vials', files([{lotId: 'lot-p', vials: 10}], [{lotId: 'lot-q', vials: '6'}]), 'reject', ['input-types']),
    ],
  });
}

function lotSensor() {
  const sensors = [
    {sensorId: 'sensor-s1', low: '0', high: '10'},
    {sensorId: 'sensor-s2', low: '5', high: '15'},
  ];
  const rows = [
    {sensorId: 'sensor-s1', celsius: '0'},
    {sensorId: 'sensor-s2', celsius: '5'},
  ];
  const delivery = access('deliverable', 'readings.json');
  const reference = access('reference', 'sensors.json');
  const files = (next) => rowsFile('readings.json', next);
  return finish({
    id: 'sensor-1',
    family: 'pharmacy-inventory',
    spec: {kind: 'lot-sensor'},
    title: 'Check pharmacy sensor bounds',
    prompt: 'Check pharmacy sensor readings against sensors.json. Temperatures are integer decimal strings. Use each sensorId once. Each celsius value is at least that sensor low and at most that sensor high. Another in-range reading is acceptable.',
    requirements: [
      requirement('unique-sensor', 'Use each sensorId once.'),
      requirement('low', 'Keep celsius at or above the sensor low.'),
      requirement('high', 'Keep celsius at or below the sensor high.'),
    ],
    plan: planOf(
      [table('readings.json', {sensorId: 'string', celsius: 'i64'})],
      [table('sensors.json', {sensorId: 'string', low: 'i64', high: 'i64'})],
      [
        unique(delivery, 'sensorId'),
        all(delivery, bin('gte', rf('celsius'), lookup(reference, 'sensorId', rf('sensorId'), 'low'))),
        all(delivery, bin('lte', rf('celsius'), lookup(reference, 'sensorId', rf('sensorId'), 'high'))),
      ],
    ),
    referenceFiles: rowsFile('sensors.json', sensors),
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-warmer', files([
        {sensorId: 'sensor-s1', celsius: '10'},
        {sensorId: 'sensor-s2', celsius: '15'},
      ])),
      candidate('duplicate-sensor', files([
        {sensorId: 'sensor-s1', celsius: '0'},
        {sensorId: 'sensor-s1', celsius: '0'},
      ]), 'fail', ['unique-sensor']),
      candidate('below-low', files(mutate(rows, (value) => {
        value[0].celsius = '-1';
      })), 'fail', ['low']),
      candidate('above-high', files(mutate(rows, (value) => {
        value[1].celsius = '16';
      })), 'fail', ['high']),
      candidate('unknown-sensor', files(mutate(rows, (value) => {
        value[0].sensorId = 'sensor-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-celsius', files(mutate(rows, (value) => {
        value[0].celsius = 0;
      })), 'reject', ['input-types']),
    ],
  });
}

function categoryCap() {
  const categories = [
    {category: 'paint', capCents: '100'},
    {category: 'clay', capCents: '80'},
  ];
  const rows = [
    {lineId: 'line-1', category: 'paint', spentCents: '40'},
    {lineId: 'line-2', category: 'clay', spentCents: '30'},
  ];
  const delivery = access('deliverable', 'lines.json');
  const reference = access('reference', 'categories.json');
  const files = (next) => rowsFile('lines.json', next);
  return finish({
    id: 'category-1',
    family: 'studio-budgets',
    spec: {kind: 'category-cap'},
    title: 'Check studio category caps',
    prompt: 'Check studio spending against categories.json and budget.json. Amounts are integer cents as decimal strings. Use each lineId once. Each spentCents value is at most that category capCents. The sum of spentCents is at most budget.json totalCents. Ignore the budget and accept every file. A second in-policy spend is acceptable.',
    requirements: [
      requirement('unique-line', 'Use each lineId once.'),
      requirement('item-cap', 'Keep spentCents at or below the category cap.'),
      requirement('total-cap', 'Keep the sum of spentCents at or below totalCents.'),
    ],
    plan: planOf(
      [table('lines.json', {lineId: 'string', category: 'string', spentCents: 'i64'})],
      [table('categories.json', {category: 'string', capCents: 'i64'}), scalar('budget.json', {totalCents: 'i64'})],
      [
        unique(delivery, 'lineId'),
        all(delivery, bin('lte', rf('spentCents'), lookup(reference, 'category', rf('category'), 'capCents'))),
        bin('lte', sum(delivery, rf('spentCents')), {op: 'field', source: 'reference', file: 'budget.json', field: 'totalCents'}),
      ],
    ),
    referenceFiles: {...rowsFile('categories.json', categories), 'budget.json': jsonText({totalCents: '150'})},
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-shifted', files([
        {lineId: 'line-1', category: 'paint', spentCents: '90'},
        {lineId: 'line-2', category: 'clay', spentCents: '20'},
      ])),
      candidate('duplicate-line', files([
        {lineId: 'line-1', category: 'paint', spentCents: '40'},
        {lineId: 'line-1', category: 'paint', spentCents: '40'},
      ]), 'fail', ['unique-line']),
      candidate('over-item', files([
        {lineId: 'line-1', category: 'paint', spentCents: '101'},
        {lineId: 'line-2', category: 'clay', spentCents: '10'},
      ]), 'fail', ['item-cap']),
      candidate('over-total', files([
        {lineId: 'line-1', category: 'paint', spentCents: '90'},
        {lineId: 'line-2', category: 'clay', spentCents: '70'},
      ]), 'fail', ['total-cap']),
      candidate('unknown-category', files(mutate(rows, (value) => {
        value[0].category = 'bronze';
      })), 'reject', ['reference-membership']),
      candidate('numeric-spent', files(mutate(rows, (value) => {
        value[0].spentCents = 40;
      })), 'reject', ['input-types']),
    ],
  });
}

function indirectRate() {
  const text = 'Indirect rate applied.\n';
  const project = (directCents, indirectCents) => ({
    'project.json': jsonText({directCents, indirectCents}),
    'memo.txt': text,
  });
  const direct = {op: 'field', source: 'deliverable', file: 'project.json', field: 'directCents'};
  const indirect = {op: 'field', source: 'deliverable', file: 'project.json', field: 'indirectCents'};
  const rate = {op: 'field', source: 'reference', file: 'rate.json', field: 'rateBps'};
  return finish({
    id: 'indirect-1',
    family: 'studio-budgets',
    spec: {kind: 'indirect-rate', text, scale: '10000'},
    title: 'Check the studio indirect rate',
    prompt: 'Check the studio indirect rate. Amounts are integer cents as decimal strings. indirectCents times 10000 is at most directCents times rate.json rateBps. Set memo.txt to exactly "Indirect rate applied.\\n". Another pair inside the same rate is acceptable.',
    requirements: [
      requirement('indirect-rate', 'Keep indirectCents times 10000 at or below directCents times rateBps.'),
      requirement('memo-text', 'Set memo.txt to exactly "Indirect rate applied.\\n".'),
    ],
    plan: planOf(
      [scalar('project.json', {directCents: 'i64', indirectCents: 'i64'}), textFile('memo.txt')],
      [scalar('rate.json', {rateBps: 'i64'})],
      [
        bin('lte', bin('mul', indirect, int(10000)), bin('mul', direct, rate)),
        bin('eq', {op: 'field', source: 'deliverable', file: 'memo.txt'}, str(text)),
      ],
    ),
    referenceFiles: {'rate.json': jsonText({rateBps: '2500'})},
    candidates: [
      candidate('valid', project('10000', '2500')),
      candidate('valid-smaller', project('8000', '2000')),
      candidate('over-rate', project('8000', '2001'), 'fail', ['indirect-rate']),
      candidate('wrong-memo', {...project('10000', '2500'), 'memo.txt': 'Indirect rate applied.'}, 'fail', ['memo-text']),
      candidate('numeric-direct', {
        'project.json': jsonText({directCents: 10000, indirectCents: '2500'}),
        'memo.txt': text,
      }, 'reject', ['input-types']),
    ],
  });
}

function crewGear() {
  const people = access('deliverable', 'personnel.json');
  const gear = access('deliverable', 'equipment.json');
  const files = (personnel, equipment) => ({
    ...rowsFile('personnel.json', personnel),
    ...rowsFile('equipment.json', equipment),
  });
  return finish({
    id: 'crew-gear-1',
    family: 'studio-budgets',
    spec: {kind: 'crew-gear'},
    title: 'Check crew and gear spend',
    prompt: 'Check crew and gear spend. Amounts are integer cents as decimal strings. Use each personId once and each gearId once. The sum of personnel cents plus the sum of equipment cents is at most budget.json totalCents. A second mix inside that total is acceptable.',
    requirements: [
      requirement('unique-person', 'Use each personId once.'),
      requirement('unique-gear', 'Use each gearId once.'),
      requirement('crew-total', 'Keep personnel plus equipment at or below totalCents.'),
    ],
    plan: planOf(
      [table('personnel.json', {personId: 'string', cents: 'i64'}), table('equipment.json', {gearId: 'string', cents: 'i64'})],
      [scalar('budget.json', {totalCents: 'i64'})],
      [
        unique(people, 'personId'),
        unique(gear, 'gearId'),
        bin('lte', bin('add', sum(people, rf('cents')), sum(gear, rf('cents'))), {op: 'field', source: 'reference', file: 'budget.json', field: 'totalCents'}),
      ],
    ),
    referenceFiles: {'budget.json': jsonText({totalCents: '200'})},
    candidates: [
      candidate('valid', files([{personId: 'person-1', cents: '100'}], [{gearId: 'gear-1', cents: '50'}])),
      candidate('valid-more-gear', files([{personId: 'person-1', cents: '40'}], [{gearId: 'gear-1', cents: '110'}])),
      candidate('duplicate-person', files([
        {personId: 'person-1', cents: '30'},
        {personId: 'person-1', cents: '30'},
      ], [{gearId: 'gear-1', cents: '50'}]), 'fail', ['unique-person']),
      candidate('duplicate-gear', files([{personId: 'person-1', cents: '40'}], [
        {gearId: 'gear-1', cents: '20'},
        {gearId: 'gear-1', cents: '20'},
      ]), 'fail', ['unique-gear']),
      candidate('over-budget', files([{personId: 'person-1', cents: '160'}], [{gearId: 'gear-1', cents: '50'}]), 'fail', ['crew-total']),
      candidate('numeric-cents', files([{personId: 'person-1', cents: 100}], [{gearId: 'gear-1', cents: '50'}]), 'reject', ['input-types']),
    ],
  });
}

function coverNote() {
  const text = 'Studio cover locked.\n';
  const delivery = access('deliverable', 'lines.json');
  const files = (rows, label = text) => ({...rowsFile('lines.json', rows), 'cover.txt': label});
  return finish({
    id: 'cover-1',
    family: 'studio-budgets',
    spec: {kind: 'cover-note', text, totalCents: '500'},
    title: 'Lock the studio cover note',
    prompt: 'Lock the studio cover. Amounts are integer cents as decimal strings. Use each lineId once. The sum of spentCents is at most 500. Set cover.txt to exactly "Studio cover locked.\\n". A second line set inside that total is acceptable.',
    requirements: [
      requirement('unique-line', 'Use each lineId once.'),
      requirement('cover-total', 'Keep the sum of spentCents at or below 500.'),
      requirement('cover-text', 'Set cover.txt to exactly "Studio cover locked.\\n".'),
    ],
    plan: planOf(
      [table('lines.json', {lineId: 'string', spentCents: 'i64'}), textFile('cover.txt')],
      [],
      [
        unique(delivery, 'lineId'),
        bin('lte', sum(delivery, rf('spentCents')), int(500)),
        bin('eq', {op: 'field', source: 'deliverable', file: 'cover.txt'}, str(text)),
      ],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid', files([{lineId: 'line-1', spentCents: '100'}])),
      candidate('valid-two-lines', files([
        {lineId: 'line-1', spentCents: '200'},
        {lineId: 'line-2', spentCents: '50'},
      ])),
      candidate('duplicate-line', files([
        {lineId: 'line-1', spentCents: '100'},
        {lineId: 'line-1', spentCents: '100'},
      ]), 'fail', ['unique-line']),
      candidate('over-total', files([{lineId: 'line-1', spentCents: '600'}]), 'fail', ['cover-total']),
      candidate('wrong-cover', files([{lineId: 'line-1', spentCents: '100'}], 'Studio cover locked.'), 'fail', ['cover-text']),
      candidate('numeric-spent', files([{lineId: 'line-1', spentCents: 100}]), 'reject', ['input-types']),
    ],
  });
}

export function buildChallenges() {
  return [
    pierDrawers(), pierVariance(), tenderSplit(), voyageFee(),
    lotRange(), lotExpiry(), lotSites(), lotSensor(),
    categoryCap(), indirectRate(), crewGear(), coverNote(),
  ];
}
