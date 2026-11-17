import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {committedMicroUsd, newLedger, persistLedger} from './budget.mjs';
import {scoreTrial} from './score.mjs';
import {draftInput, loadDeployment, runBenchmark, trialKey} from './trials.mjs';

const challenge = {
  id: 'mass-1',
  classification: 'supported',
  prompt: 'Report one product.',
  outputs: [{name: 'product.json', format: 'json'}],
  referenceFiles: {'channel.json': '{"build":"stable"}'},
  requirements: [{id: 'mass-identity', text: 'Keep the identity.'}],
};

function config(extra = {}) {
  return {
    dispatch: true,
    baseUrl: 'https://hosted.example',
    apiKey: 'test-key',
    scope: 'benchmark',
    capMicroUsd: 300_000,
    attemptPriceMicroUsd: 40_000,
    corpusId: 'hosted-qualification-2026-11-16',
    ...extra,
  };
}

test('deployment without a dispatch flag does not call the network', async () => {
  let called = false;
  const result = await runBenchmark({
    challenges: [challenge],
    config: loadDeployment({}),
    ledgerPath: '/tmp/unused-ledger.json',
    fetchImpl: async () => {
      called = true;
      throw Error('network');
    },
  });
  assert.equal(called, false);
  assert.equal(result.paidTrialsRan, false);
  assert.equal(result.reason, 'missing-deployment');
});

test('unknown price, public scope, and an exhausted cap do not dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-budget-'));
  const ledgerPath = join(directory, 'ledger.json');
  try {
    for (const ledger of [
      newLedger({scope: 'benchmark', capMicroUsd: 300_000, attemptPriceMicroUsd: null}),
      newLedger({scope: 'public', capMicroUsd: 300_000, attemptPriceMicroUsd: 40_000}),
      newLedger({scope: 'benchmark', capMicroUsd: 50_000, attemptPriceMicroUsd: 40_000}),
    ]) {
      let called = false;
      const result = await runBenchmark({
        challenges: [challenge],
        config: {...config(), ledger},
        ledgerPath,
        fetchImpl: async () => {
          called = true;
          throw Error('network');
        },
        trialsPerRequest: 1,
      });
      assert.equal(called, false);
      assert.equal(result.paidTrialsRan, false);
      assert.equal(result.trials[0].dispatched, false);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('one post reserves a two-attempt charge and does not send a client repair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-trial-'));
  const ledgerPath = join(directory, 'ledger.json');
  const calls = [];
  try {
    const ledger = newLedger(config());
    const result = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        const stored = JSON.parse(await readFile(ledgerPath, 'utf8'));
        assert.equal(stored.entries[trialKey(config().corpusId, 'mass-1', 1)].state, 'reserved');
        calls.push({url, method: options.method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers});
        return {json: async () => ({id: 'task-1', state: 'succeeded', attempt: 2, costMicroUsd: 25_000})};
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['Idempotency-Key'], 'qual-hosted-qualification-2026-11-16-mass-1-trial-1');
    assert.deepEqual(Object.keys(calls[0].body), ['operation', 'input']);
    assert.deepEqual(Object.keys(calls[0].body.input), ['request', 'outputs', 'references', 'clarifications', 'expirySeconds', 'maxBudget']);
    assert.equal(JSON.stringify(calls[0].body).includes('mass-identity'), false);
    assert.equal(result.paidTrialsRan, true);
    assert.equal(result.trials[0].repairCount, 1);
    assert.equal(result.trials[0].method, 'POST');
    assert.equal(result.ledger.entries[result.trials[0].key].state, 'reconciled');
    assert.equal(result.ledger.entries[result.trials[0].key].costMicroUsd, 25_000);
    assert.equal(committedMicroUsd(result.ledger), 25_000);
    const mode = (await stat(ledgerPath)).mode & 0o777;
    assert.equal(mode, 0o600);
    const resumeCalls = [];
    const resumed = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger: result.ledger},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        resumeCalls.push(options.method);
        return {json: async () => ({id: 'task-1', state: 'succeeded', attempt: 2, costMicroUsd: 25_000})};
      },
    });
    assert.deepEqual(resumeCalls, ['GET']);
    assert.equal(resumed.paidTrialsRan, false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('uncertain and unreported terminal costs keep the reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-uncertain-'));
  const ledgerPath = join(directory, 'ledger.json');
  try {
    const failed = newLedger(config());
    const uncertain = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger: failed},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async () => {
        throw Error('socket closed');
      },
    });
    assert.equal(uncertain.trials[0].state, 'uncertain');
    assert.equal(uncertain.ledger.entries[uncertain.trials[0].key].state, 'reserved');
    assert.equal(committedMicroUsd(uncertain.ledger), 80_000);

    const quiet = newLedger({...config(), capMicroUsd: 80_000});
    const unreported = await runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: {...config(), ledger: quiet, capMicroUsd: 80_000},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({json: async () => ({id: 'task-2', state: 'succeeded', attempt: 1})}),
    });
    assert.equal(unreported.ledger.entries[unreported.trials[0].key].cost, 'unreported');
    assert.equal(committedMicroUsd(unreported.ledger), 80_000);
    const blocked = await runBenchmark({
      challenges: [{...challenge, id: 'mixture-1'}],
      config: {...config(), ledger: quiet, capMicroUsd: 80_000},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async () => {
        throw Error('should not dispatch');
      },
    });
    assert.equal(blocked.trials.at(-1).reason, 'cap-exhausted');
    assert.equal(blocked.paidTrialsRan, false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('synthetic scores stay offline', () => {
  const supported = scoreTrial({
    challenge,
    response: {kind: 'draft', sourceQuotes: [{quote: 'Report one product.'}], live: false},
    candidateResults: [
      {id: 'valid', engine: 'pass', oracle: 'pass'},
      {id: 'wrong', engine: 'fail', oracle: 'fail'},
    ],
    repairCount: 1,
    cost: 25_000,
    latencyMs: 10,
    live: false,
  });
  assert.equal(supported.live, false);
  assert.equal(supported.semanticAgreement, true);
  assert.equal(supported.quoteFidelity, true);
  assert.equal(supported.repairCount, 1);

  const falseAccept = scoreTrial({
    challenge,
    response: {kind: 'draft', sourceQuotes: [{quote: 'hidden answer'}]},
    candidateResults: [{id: 'wrong', engine: 'pass', oracle: 'fail'}],
    live: false,
  });
  assert.equal(falseAccept.semanticAgreement, false);
  assert.equal(falseAccept.falseAccepts, 1);
  assert.equal(falseAccept.missingRequirements, 1);
  assert.equal(falseAccept.quoteFidelity, false);

  const ambiguous = scoreTrial({
    challenge: {classification: 'ambiguous', prompt: 'Charge a fair fee.', facets: ['fee table', 'currency unit']},
    response: {kind: 'clarification', questions: ['Which fee table applies?'], live: false},
    live: false,
  });
  assert.equal(ambiguous.clarificationFacets, 1);
  assert.equal(ambiguous.inventedConditions, 0);
  const invented = scoreTrial({
    challenge: {classification: 'ambiguous', prompt: 'Charge a fair fee.', facets: ['fee table']},
    response: {kind: 'draft', live: false},
    live: false,
  });
  assert.equal(invented.inventedConditions, 1);

  const named = scoreTrial({
    challenge: {classification: 'unsupported', prompt: 'Divide.', capabilityRequests: [{kind: 'operation', name: 'div'}]},
    response: {kind: 'unsupported', reason: 'The catalog has no div operation.', live: false},
    live: false,
  });
  assert.equal(named.unsupportedExplanation, true);
  assert.equal(named.weakerPayableJob, false);
  const weaker = scoreTrial({
    challenge: {classification: 'unsupported', prompt: 'Divide.', capabilityRequests: [{kind: 'operation', name: 'div'}]},
    response: {kind: 'draft', live: false},
    live: false,
  });
  assert.equal(weaker.weakerPayableJob, true);
});

test('draft bodies omit hidden checker fields', () => {
  const body = draftInput(challenge);
  assert.equal(Object.hasOwn(body, 'plan'), false);
  assert.equal(Object.hasOwn(body, 'spec'), false);
  assert.equal(body.clarifications.length, 0);
  assert.equal(body.expirySeconds, 3600);
  assert.equal(body.maxBudget, '10000');
  assert.equal(body.references[0].contentBase64, Buffer.from('{"build":"stable"}').toString('base64'));
  assert.equal(persistLedger.length, 2);
});
