import {
  access, all, bin, candidate, count, finish, jsonText, lookup, mutate, planOf,
  requirement, rf, rowsFile, scalar, sum, table, unique,
} from './shape.mjs';

function receiptChallenge({id, family, title, stock, capacity}) {
  const rows = stock.map(({itemId}) => ({itemId, received: '1'}));
  const delivery = access('deliverable', 'receipt.json');
  const reference = access('reference', 'purchase-order.json');
  const files = (next) => rowsFile('receipt.json', next);
  const expanded = stock.map(({itemId, limit}) => ({itemId, received: limit}));
  return finish({
    id,
    family,
    spec: {kind: 'purchase-order-receipt'},
    title,
    prompt: `Check receipt.json against purchase-order.json. Counts are integer decimal strings. Use each itemId once. Include every ordered item. Each received count must be at least zero and at most that item's limit. The sum of received counts must be at most capacity.json capacity. A partial receipt is acceptable.`,
    requirements: [
      requirement('unique-item', 'Use each itemId once.'),
      requirement('item-count', 'Include every ordered item.'),
      requirement('nonnegative-received', 'Keep each received count at or above zero.'),
      requirement('item-limit', 'Keep each received count at or below its order limit.'),
      requirement('receipt-capacity', 'Keep the sum of received counts at or below capacity.'),
    ],
    plan: planOf(
      [table('receipt.json', {itemId: 'string', received: 'i64'})],
      [table('purchase-order.json', {itemId: 'string', limit: 'i64'}), scalar('capacity.json', {capacity: 'i64'})],
      [
        unique(delivery, 'itemId'),
        bin('eq', count(delivery), count(reference)),
        all(delivery, bin('gte', rf('received'), {op: 'literal', type: 'i64', value: '0'})),
        all(delivery, bin('lte', rf('received'), lookup(reference, 'itemId', rf('itemId'), 'limit'))),
        bin('lte', sum(delivery, rf('received')), {op: 'field', source: 'reference', file: 'capacity.json', field: 'capacity'}),
      ],
    ),
    referenceFiles: {
      ...rowsFile('purchase-order.json', stock),
      'capacity.json': jsonText({capacity}),
    },
    candidates: [
      candidate('valid-partial', files(rows)),
      candidate('valid-empty', files(rows.map((row) => ({...row, received: '0'})))),
      candidate('duplicate-item', files(mutate(rows, (next) => { next[1].itemId = next[0].itemId; })), 'fail', ['unique-item']),
      candidate('missing-item', files(rows.slice(0, -1)), 'fail', ['item-count']),
      candidate('negative-count', files(mutate(rows, (next) => { next[0].received = '-1'; })), 'fail', ['nonnegative-received']),
      candidate('over-order-limit', files(mutate(rows, (next) => { next[0].received = String(BigInt(stock[0].limit) + 1n); })), 'fail', ['item-limit']),
      candidate('over-capacity', files(expanded), 'fail', ['receipt-capacity']),
      candidate('unknown-item', files(mutate(rows, (next) => { next[0].itemId = 'unlisted-item'; })), 'reject', ['reference-membership']),
      candidate('numeric-count', files(mutate(rows, (next) => { next[0].received = 1; })), 'reject', ['input-types']),
    ],
  });
}

export function procurementChallenges() {
  return [
    receiptChallenge({
      id: 'lab-supplies-receipt-1',
      family: 'lab-procurement',
      title: 'Check laboratory supply receipt',
      stock: [
        {itemId: 'nitrile-gloves', limit: '3'},
        {itemId: 'pipette-tips', limit: '4'},
        {itemId: 'sample-tubes', limit: '5'},
      ],
      capacity: '9',
    }),
    receiptChallenge({
      id: 'clinic-supplies-receipt-1',
      family: 'clinic-procurement',
      title: 'Check clinic supply receipt',
      stock: [
        {itemId: 'sterile-gauze', limit: '4'},
        {itemId: 'saline-packs', limit: '5'},
        {itemId: 'test-kits', limit: '6'},
      ],
      capacity: '11',
    }),
  ];
}
