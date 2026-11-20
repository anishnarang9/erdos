import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {classifyEvaluation, encodeDirectory, runEngine, sha256, syntheticJob} from '../run-challenges.mjs';
import {resolveEngine} from './host-run.mjs';
import {access, all, bin, bool, count, int, lookup, mutate, planOf, rf, scalar, sum, table, unique} from './shape.mjs';

const add = (left, right) => bin('add', left, right);
const sub = (left, right) => bin('sub', left, right);
const mul = (left, right) => bin('mul', left, right);
const eq = (left, right) => bin('eq', left, right);
const lte = (left, right) => bin('lte', left, right);
const lt = (left, right) => bin('lt', left, right);
const and = (left, right) => bin('and', left, right);
const choose = (condition, then, otherwise) => ({op: 'if', condition, then, else: otherwise});
const field = (source, file, name) => ({op: 'field', source, file, field: name});
const json = (value) => JSON.stringify(value);

function readRows(files, name, strings, integers) {
  const rows = JSON.parse(files[name]).rows;
  if (!Array.isArray(rows)) throw new Error('Expected rows');
  return rows.map((row) => {
    for (const key of strings) {
      if (typeof row[key] !== 'string') throw new Error('Expected a text field');
    }
    return {...row, ...Object.fromEntries(integers.map((key) => [key, integer(row[key])]))};
  });
}

function integer(value) {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw new Error('Expected an integer string');
  const parsed = BigInt(value);
  if (BigInt.asIntN(64, parsed) !== parsed) throw new Error('Integer outside the i64 range');
  return parsed;
}

function checkStatus(oracle, files) {
  try { return oracle(files) ? 'pass' : 'fail'; }
  catch { return 'reject'; }
}

async function verifyWorkload(t, {plan, references, oracle, cases}) {
  const resolved = resolveEngine();
  assert.equal(resolved.ok, true, resolved.message);
  const root = await mkdtemp(join(tmpdir(), 'ubc26-cross-domain-'));
  const planPath = join(root, 'plan.json');
  const reference = join(root, 'reference');
  const jobPath = join(root, 'job.json');
  try {
    await mkdir(reference);
    await writeFile(planPath, json(plan));
    for (const [name, content] of Object.entries(references)) await writeFile(join(reference, name), content);
    const validated = runEngine(resolved.engine, ['validate', '--plan', planPath]);
    assert.equal(validated.exitCode, 0, json(validated));
    const referenceHash = sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'), await encodeDirectory(reference)]));
    await writeFile(jobPath, json(syntheticJob({rulesHash: validated.value.rulesHash, referenceHash})));
    for (const [id, files, expected] of cases) {
      await t.test(id, async () => {
        const delivery = join(root, id);
        await mkdir(delivery);
        for (const [name, content] of Object.entries(files)) await writeFile(join(delivery, name), content);
        assert.equal(checkStatus(oracle, files), expected, 'independent oracle');
        const evaluated = runEngine(resolved.engine, [
          'eval', '--plan', planPath, '--reference', reference, '--deliverables', delivery, '--job', jobPath,
        ]);
        assert.equal(classifyEvaluation(evaluated), expected, json(evaluated));
      });
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

test('reconciles an invoice batch across currencies with per-line rounding', async (t) => {
  const invoices = [
    {id: 'a', currency: 'eur', amount: '102', creditCap: '2'},
    {id: 'b', currency: 'eur', amount: '199', creditCap: '2'},
    {id: 'c', currency: 'usd', amount: '93', creditCap: '0'},
  ];
  const rates = [{currency: 'eur', rate: '1250'}, {currency: 'usd', rate: '1000'}];
  const payments = access('deliverable', 'payments.json');
  const invoicesRef = access('reference', 'invoices.json');
  const ratesRef = access('reference', 'rates.json');
  const invoice = (name) => lookup(invoicesRef, 'id', rf('id'), name);
  const numerator = mul(sub(invoice('amount'), rf('credit')),
    lookup(ratesRef, 'currency', invoice('currency'), 'rate'));
  const reported = mul(rf('cents'), int(1000));
  // The unique integer whose scaled value brackets the half-up numerator is the payment.
  const rounded = add(numerator, int(500));
  const plan = planOf(
    [table('payments.json', {id: 'string', credit: 'i64', cents: 'i64'}), scalar('summary.json', {cents: 'i64'})],
    [table('invoices.json', {id: 'string', currency: 'string', amount: 'i64', creditCap: 'i64'}),
      table('rates.json', {currency: 'string', rate: 'i64'})],
    [
      unique(payments, 'id'),
      eq(count(payments), count(invoicesRef)),
      all(payments, and(lte(int(0), rf('credit')), lte(rf('credit'), invoice('creditCap')))),
      all(payments, and(lte(reported, rounded), lt(rounded, add(reported, int(1000))))),
      lte(sum(payments, rf('credit')), int(3)),
      eq(sum(payments, rf('cents')), field('deliverable', 'summary.json', 'cents')),
    ],
  );
  function oracle(files) {
    const rows = readRows(files, 'payments.json', ['id'], ['credit', 'cents']);
    const reportedTotal = integer(JSON.parse(files['summary.json']).cents);
    let total = 0n;
    let usedCredit = 0n;
    let valid = new Set(rows.map(({id}) => id)).size === invoices.length && rows.length === invoices.length;
    for (const row of rows) {
      const bill = invoices.find(({id}) => id === row.id);
      if (!bill) throw new Error('Unknown invoice');
      const rate = rates.find(({currency}) => currency === bill.currency);
      const expected = ((BigInt(bill.amount) - row.credit) * BigInt(rate.rate) + 500n) / 1000n;
      valid = row.credit >= 0n && row.credit <= BigInt(bill.creditCap) && row.cents === expected && valid;
      usedCredit += row.credit;
      total += row.cents;
    }
    return valid && usedCredit <= 3n && total === reportedTotal;
  }
  const packet = (rows, cents) => ({'payments.json': json({rows}), 'summary.json': json({cents})});
  const full = [
    {id: 'a', credit: '0', cents: '128'}, {id: 'b', credit: '0', cents: '249'},
    {id: 'c', credit: '0', cents: '93'},
  ];
  const discounted = [
    {id: 'b', credit: '1', cents: '248'}, {id: 'c', credit: '0', cents: '93'},
    {id: 'a', credit: '2', cents: '125'},
  ];
  await verifyWorkload(t, {
    plan, references: {'invoices.json': json({rows: invoices}), 'rates.json': json({rows: rates})}, oracle,
    cases: [
      ['full-payment', packet(full, '470'), 'pass'],
      ['with-credits', packet(discounted, '466'), 'pass'],
      ['round-half-down', packet(mutate(full, (r) => { r[0].cents = '127'; }), '469'), 'fail'],
      ['credit-pool-limit', packet(mutate(discounted, (r) => { r[0].credit = '2'; r[0].cents = '246'; }), '464'), 'fail'],
      ['total-mismatch', packet(full, '469'), 'fail'],
      ['duplicated-invoice', packet([full[0], full[0], full[2]], '349'), 'fail'],
      ['unknown-invoice', packet(mutate(full, (r) => { r[0].id = 'unknown'; }), '470'), 'reject'],
      ['json-number', packet(mutate(full, (r) => { r[0].cents = 128; }), '470'), 'reject'],
    ],
  });
});

test('checks a battery schedule across time, capacity and cost constraints', async (t) => {
  const periods = [
    {slot: '1', demand: '5', solar: '8', rate: '1'},
    {slot: '2', demand: '6', solar: '2', rate: '3'},
    {slot: '3', demand: '6', solar: '3', rate: '2'},
  ];
  const schedule = access('deliverable', 'schedule.json');
  const periodsRef = access('reference', 'periods.json');
  const terms = (name) => lookup(periodsRef, 'slot', rf('slot'), name);
  const grid = rf('grid');
  const charge = rf('charge');
  const discharge = rf('discharge');
  const soc = rf('soc');
  const preceding = choose(eq(rf('slot'), int(1)), int(2),
    lookup(schedule, 'slot', sub(rf('slot'), int(1)), 'soc'));
  const validSlots = and(unique(schedule, 'slot'), eq(count(schedule), count(periodsRef)));
  const plan = planOf(
    [table('schedule.json', {slot: 'i64', grid: 'i64', charge: 'i64', discharge: 'i64', soc: 'i64'})],
    [table('periods.json', {slot: 'i64', demand: 'i64', solar: 'i64', rate: 'i64'})],
    [
      all(schedule, eq(add(add(grid, discharge), terms('solar')), add(terms('demand'), charge))),
      all(schedule, and(lte(int(0), grid), and(lte(int(0), charge), lte(int(0), discharge)))),
      all(schedule, bin('or', eq(charge, int(0)), eq(discharge, int(0)))),
      all(schedule, and(lte(int(1), soc), lte(soc, int(5)))),
      choose(validSlots, all(schedule, eq(soc, sub(add(preceding, charge), discharge))), bool(false)),
      all(schedule, choose(eq(rf('slot'), count(periodsRef)), lte(int(2), soc), bool(true))),
      lte(sum(schedule, mul(grid, terms('rate'))), int(12)),
    ],
  );
  function oracle(files) {
    const rows = readRows(files, 'schedule.json', [], ['slot', 'grid', 'charge', 'discharge', 'soc']);
    const ordered = rows.map((row) => {
      const period = periods.find(({slot}) => BigInt(slot) === row.slot);
      if (!period) throw new Error('Unknown interval');
      return {...row, period};
    }).sort((a, b) => Number(a.slot - b.slot));
    if (ordered.length !== periods.length) return false;
    let storage = 2n;
    let cost = 0n;
    for (const [index, {slot, grid, charge, discharge, soc, period}] of ordered.entries()) {
      if (slot !== BigInt(index + 1) || grid < 0n || charge < 0n || discharge < 0n || (charge > 0n && discharge > 0n)) return false;
      if (grid + discharge + BigInt(period.solar) !== BigInt(period.demand) + charge) return false;
      storage += charge - discharge;
      if (storage !== soc || storage < 1n || storage > 5n) return false;
      cost += grid * BigInt(period.rate);
    }
    return storage >= 2n && cost <= 12n;
  }
  const standard = [
    {slot: '1', grid: '0', charge: '3', discharge: '0', soc: '5'},
    {slot: '2', grid: '1', charge: '0', discharge: '3', soc: '2'},
    {slot: '3', grid: '3', charge: '0', discharge: '0', soc: '2'},
  ];
  const alternate = [
    standard[0], {slot: '2', grid: '2', charge: '0', discharge: '2', soc: '3'},
    {slot: '3', grid: '2', charge: '0', discharge: '1', soc: '2'},
  ];
  const packet = (rows) => ({'schedule.json': json({rows})});
  await verifyWorkload(t, {
    plan, references: {'periods.json': json({rows: periods})}, oracle,
    cases: [
      ['discharge-at-peak', packet(standard), 'pass'],
      ['split-discharge-reordered', packet([...alternate].reverse()), 'pass'],
      ['energy-imbalance', packet(mutate(standard, (r) => { r[1].grid = '0'; })), 'fail'],
      ['broken-state-transition', packet(mutate(standard, (r) => { r[2].soc = '3'; })), 'fail'],
      ['simultaneous-charge-discharge', packet(mutate(standard, (r) => { r[1].charge = '1'; r[1].discharge = '4'; })), 'fail'],
      ['above-cost-cap', packet([
        standard[0], {...standard[1], grid: '4', discharge: '0', soc: '5'},
        {...standard[2], grid: '1', discharge: '2', soc: '3'},
      ]), 'fail'],
      ['missing-slot', packet(standard.slice(1)), 'fail'],
      ['unknown-slot', packet(mutate(standard, (r) => { r[2].slot = '4'; })), 'reject'],
      ['fractional-energy', packet(mutate(standard, (r) => { r[1].discharge = '2.5'; })), 'reject'],
    ],
  });
});
