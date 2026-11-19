import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {classifyEvaluation, encodeDirectory, runEngine, sha256, syntheticJob} from '../run-challenges.mjs';
import {resolveEngine} from './host-run.mjs';
import {access, all, bin, count, int, lookup, mutate, planOf, rf, sum, table, unique} from './shape.mjs';

function dispatchReferences(groupSize) {
  const depots = [0, 1, 2, 30].map((surcharge, index) => ({
    id: `depot-${index}`,
    capacity: String(groupSize + (index === 3 ? 1 : 0)),
    surcharge: String(surcharge),
  }));
  const orders = [350, 320, 440, 290].flatMap((price, group) =>
    Array.from({length: groupSize}, (_, index) => ({
      id: `order-${group}-${index}`,
      primary: depots[group].id,
      alternate: depots[(group + 1) % depots.length].id,
      price: String(price),
    })));
  return {orders, depots};
}

const deliveries = access('deliverable', 'assignments.json');
const orderTable = access('reference', 'orders.json');
const depotTable = access('reference', 'depots.json');
const orderField = (field) => lookup(orderTable, 'id', rf('order'), field);
const dispatchPlan = (budget) => planOf(
  [table('assignments.json', {order: 'string', depot: 'string'})],
  [
    table('orders.json', {id: 'string', primary: 'string', alternate: 'string', price: 'i64'}),
    table('depots.json', {id: 'string', capacity: 'i64', surcharge: 'i64'}),
  ],
  [
    unique(deliveries, 'order'),
    bin('eq', count(deliveries), count(orderTable)),
    all(deliveries, bin('or',
      bin('eq', rf('depot'), orderField('primary')),
      bin('eq', rf('depot'), orderField('alternate')))),
    all(depotTable, bin('lte',
      count(deliveries, bin('eq', rf('depot'), rf('id', 1))), rf('capacity'))),
    bin('lte', sum(deliveries, bin('add',
      orderField('price'), lookup(depotTable, 'id', rf('depot'), 'surcharge'))), int(budget)),
  ],
);

function dispatchOracle(rows, {orders, depots}, budget) {
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const depotsById = new Map(depots.map((depot) => [depot.id, depot]));
  const seen = new Set();
  const load = new Map();
  const violations = new Set();
  let cost = 0;
  for (const row of rows) {
    const order = ordersById.get(row.order);
    const depot = depotsById.get(row.depot);
    if (!order || !depot) return ['reject', []];
    if (seen.has(row.order)) violations.add('duplicate');
    seen.add(row.order);
    if (row.depot !== order.primary && row.depot !== order.alternate) violations.add('eligibility');
    load.set(depot.id, (load.get(depot.id) ?? 0) + 1);
    cost += Number(order.price) + Number(depot.surcharge);
  }
  if (rows.length !== orders.length) violations.add('coverage');
  if (depots.some(({id, capacity}) => (load.get(id) ?? 0) > Number(capacity))) violations.add('capacity');
  if (cost > budget) violations.add('budget');
  return [violations.size ? 'fail' : 'pass', [...violations]];
}

async function checkDispatch(t, groupSize, budget) {
  const resolved = resolveEngine();
  assert.equal(resolved.ok, true, resolved.message);
  const references = dispatchReferences(groupSize);
  const {orders, depots} = references;
  const dir = await mkdtemp(join(tmpdir(), 'ubc26-dispatch-'));
  try {
    const planPath = join(dir, 'plan.json');
    const reference = join(dir, 'reference');
    const delivery = join(dir, 'delivery');
    const jobPath = join(dir, 'job.json');
    await mkdir(reference);
    await mkdir(delivery);
    await writeFile(planPath, JSON.stringify(dispatchPlan(budget)));
    await writeFile(join(reference, 'orders.json'), JSON.stringify({rows: orders}));
    await writeFile(join(reference, 'depots.json'), JSON.stringify({rows: depots}));
    const validated = runEngine(resolved.engine, ['validate', '--plan', planPath]);
    assert.equal(validated.exitCode, 0, JSON.stringify(validated));
    const referenceHash = sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'), await encodeDirectory(reference)]));
    const job = syntheticJob({rulesHash: validated.value.rulesHash, referenceHash});
    await writeFile(jobPath, JSON.stringify(job));

    const primary = orders.map(({id, primary}) => ({order: id, depot: primary}));
    const alternate = orders.map(({id, alternate}) => ({order: id, depot: alternate}));
    const thirdGroupStart = 2 * groupSize;
    const cases = [
      ['primary allocation', primary, 'pass'],
      ['alternate allocation', alternate, 'pass'],
      ['missing order', primary.slice(1), 'fail', ['coverage']],
      ['duplicate order', mutate(primary, (rows) => { rows[0].order = rows[1].order; }), 'fail', ['duplicate']],
      ['ineligible depots', mutate(primary, (rows) => {
        [rows[0].depot, rows[thirdGroupStart].depot] = [rows[thirdGroupStart].depot, rows[0].depot];
      }), 'fail', ['eligibility']],
      ['overloaded depot', mutate(primary, (rows) => { rows[0].depot = orders[0].alternate; }), 'fail', ['capacity']],
      ['over budget', mutate(primary, (rows) => {
        rows[thirdGroupStart].depot = orders[thirdGroupStart].alternate;
      }), 'fail', ['budget']],
      ['unknown order', mutate(primary, (rows) => { rows[0].order = 'unknown'; }), 'reject'],
      ['wrong order type', mutate(primary, (rows) => { rows[0].order = 42; }), 'reject'],
    ];
    for (const [name, rows, status, violations = []] of cases) {
      await t.test(name, async () => {
        assert.deepEqual(dispatchOracle(rows, references, budget), [status, violations]);
        await writeFile(join(delivery, 'assignments.json'), JSON.stringify({rows}));
        const evaluated = runEngine(resolved.engine, [
          'eval', '--plan', planPath, '--reference', reference, '--deliverables', delivery, '--job', jobPath,
        ]);
        assert.equal(classifyEvaluation(evaluated), status, JSON.stringify(evaluated));
      });
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

for (const [groupSize, budget] of [[24, 34400], [64, 91720]]) {
  test(`checks ${groupSize * 4} dispatch orders against an independent oracle`, (t) =>
    checkDispatch(t, groupSize, budget));
}
