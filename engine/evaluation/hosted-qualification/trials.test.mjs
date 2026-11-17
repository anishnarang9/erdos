import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {actualMicroUsdFromTicks, applyTaskView, committedMicroUsd, newLedger, persistLedger} from './budget.mjs';
import {scoreTrial} from './score.mjs';
import {aggregateGates, draftInput, loadDeployment, runBenchmark, trialKey} from './trials.mjs';

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
    apiKeys: ['test-key'],
    scope: 'benchmark',
    capMicroUsd: 300_000,
    attemptPriceMicroUsd: 40_000,
    corpusId: 'hosted-qualification-2026-11-16',
    maxPolls: 2,
    pollIntervalMs: 0,
    assessImpl: async () => ({engineValid: null, candidateResults: []}),
    ...extra,
  };
}

function task(extra = {}) {
  return {
    id: 'task-1',
    operation: 'draft',
    state: 'succeeded',
    attempt: 1,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:01.000Z',
    ...extra,
  };
}

function settledDraft(id, traceIds, repairCount = 0) {
  const usage = traceIds.map((_, index) => ({costInUsdTicks: 100_000 * (index + 1)}));
  return task({
    id,
    attempt: 5,
    result: {
      kind: 'draft',
      plan: {version: 1},
      sourceQuotes: [{quote: 'Report one product.'}],
      qualification: {repairCount, latencyMs: 12, usage},
      billing: {state: 'settled', microUsd: 1},
      attempts: traceIds.map((traceId, index) => ({traceId, usage: usage[index]})),
    },
  });
}

test('deployment without dispatch does not call the network', async () => {
  let called = false;
  const absent = await runBenchmark({
    challenges: [challenge],
    config: loadDeployment({}),
    ledgerPath: '/tmp/unused-ledger.json',
    fetchImpl: async () => {
      called = true;
      throw Error('network');
    },
  });
  assert.equal(called, false);
  assert.equal(absent.paidTrialsRan, false);
  assert.equal(absent.qualificationPassed, false);
  assert.equal(absent.freshTrials, 0);
  assert.equal(absent.reason, 'missing-deployment');

  const configured = loadDeployment({
    UBC26_HOSTED_BASE_URL: 'https://hosted.example',
    UBC26_HOSTED_API_KEY: 'single-service-key',
    UBC26_BENCHMARK_API_KEY_1: 'owner-a',
    UBC26_BENCHMARK_API_KEY_2: 'owner-b',
    UBC26_BENCHMARK_API_KEY_3: 'owner-c',
    UBC26_BENCHMARK_SCOPE: 'benchmark',
    UBC26_BENCHMARK_CAP_MICRO_USD: '300000',
    UBC26_ATTEMPT_PRICE_MICRO_USD: '40000',
  });
  assert.equal(configured.dispatch, false);
  assert.equal(configured.live, false);
  assert.deepEqual(configured.apiKeys, ['owner-a', 'owner-b', 'owner-c']);
  const held = await runBenchmark({
    challenges: [challenge],
    config: configured,
    ledgerPath: '/tmp/unused-ledger.json',
    fetchImpl: async () => {
      called = true;
      throw Error('network');
    },
  });
  assert.equal(called, false);
  assert.equal(held.reason, 'dispatch-disabled');
  assert.equal(held.qualificationPassed, false);
});

test('unknown price, public scope, exhausted cap, and one owner do not dispatch', async () => {
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
      assert.equal(result.qualificationPassed, false);
      assert.equal(result.trials[0].dispatched, false);
    }
    let called = false;
    const sharedOwner = await runBenchmark({
      challenges: [challenge],
      config: config({apiKeys: ['same-owner']}),
      ledgerPath,
      fetchImpl: async () => {
        called = true;
        throw Error('network');
      },
      trialsPerRequest: 3,
    });
    assert.equal(called, false);
    assert.equal(sharedOwner.reason, 'missing-principals');
    assert.equal(sharedOwner.paidTrialsRan, false);
    assert.equal(sharedOwner.qualificationPassed, false);
    const insecure = await runBenchmark({
      challenges: [challenge],
      config: config({baseUrl: 'http://example.test'}),
      ledgerPath,
      fetchImpl: async () => {
        called = true;
        throw Error('network');
      },
      trialsPerRequest: 1,
    });
    assert.equal(called, false);
    assert.equal(insecure.reason, 'insecure-origin');
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
        calls.push({url, method: options.method, redirect: options.redirect, signal: options.signal, body: options.body ? JSON.parse(options.body) : null, headers: options.headers});
        return {status: 200, json: async () => settledDraft('task-1', ['trace-initial', 'trace-repair'], 1)};
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].redirect, 'error');
    assert.ok(calls[0].signal);
    assert.equal(calls[0].headers['idempotency-key'], 'qual-hosted-qualification-2026-11-16-mass-1-trial-1');
    assert.deepEqual(Object.keys(calls[0].body), ['operation', 'input']);
    assert.deepEqual(Object.keys(calls[0].body.input), ['request', 'outputs', 'references', 'clarifications', 'expirySeconds', 'maxBudget']);
    assert.equal(calls[0].body.input.request, challenge.prompt);
    assert.deepEqual(calls[0].body.input.clarifications, []);
    assert.equal(Object.hasOwn(calls[0].body.input, 'repair'), false);
    assert.equal(JSON.stringify(calls[0].body).includes('mass-identity'), false);
    assert.equal(result.paidTrialsRan, true);
    assert.equal(result.qualificationPassed, false);
    assert.equal(result.trials[0].score.live, false);
    assert.equal(result.trials[0].attempt, 5);
    assert.equal(result.trials[0].repairCount, 1);
    assert.equal(result.trials[0].method, 'POST');
    assert.equal(result.trials[0].artifacts.initial.traceId, 'trace-initial');
    assert.equal(result.trials[0].artifacts.repair.traceId, 'trace-repair');
    assert.equal(result.trials[0].tariffMicroUsd, 1);
    assert.equal(result.trials[0].costInUsdTicks, 300_000);
    assert.equal(result.ledger.entries[result.trials[0].key].state, 'reconciled');
    assert.equal(result.ledger.entries[result.trials[0].key].costSource, 'actual-ticks');
    assert.equal(result.ledger.entries[result.trials[0].key].costMicroUsd, 30);
    assert.equal(committedMicroUsd(result.ledger), 30);
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
        return {status: 200, json: async () => settledDraft('task-1', ['trace-initial', 'trace-repair'], 1)};
      },
    });
    assert.deepEqual(resumeCalls, ['GET']);
    assert.equal(resumed.paidTrialsRan, false);
    assert.equal(resumed.freshTrials, 0);
    assert.equal(resumed.trials[0].freshReason, 'cached-task');
    assert.equal(resumed.qualificationPassed, false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('actual ticks reconcile and a tariff estimate stays at the ceiling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-ticks-'));
  const exactPath = join(directory, 'exact.json');
  const tariffPath = join(directory, 'tariff.json');
  try {
    const ledger = newLedger(config());
    const exact = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger},
      ledgerPath: exactPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({
        status: 200,
        json: async () => task({
          result: {
            kind: 'draft',
            qualification: {repairCount: 0, usage: [{cost_in_usd_ticks: 250_000_000}]},
            billing: {state: 'settled', microUsd: 1},
            attempts: [{traceId: 'trace-1', usage: {cost_in_usd_ticks: 250_000_000}}],
          },
        }),
      }),
    });
    assert.equal(exact.ledger.entries[exact.trials[0].key].costSource, 'actual-ticks');
    assert.equal(exact.ledger.entries[exact.trials[0].key].costInUsdTicks, 250_000_000);
    assert.equal(exact.ledger.entries[exact.trials[0].key].costMicroUsd, 25_000);
    assert.equal(exact.trials[0].tariffMicroUsd, 1);
    assert.equal(committedMicroUsd(exact.ledger), 25_000);
    assert.equal(exact.qualificationPassed, false);

    const estimate = newLedger(config());
    const tariff = await runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: {...config(), ledger: estimate},
      ledgerPath: tariffPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({
        status: 200,
        json: async () => task({
          id: 'task-tariff',
          result: {kind: 'draft', billing: {state: 'settled', microUsd: 25_000}},
        }),
      }),
    });
    assert.equal(tariff.ledger.entries[tariff.trials[0].key].cost, 'unreported');
    assert.equal(tariff.trials[0].tariffMicroUsd, 25_000);
    assert.equal(tariff.trials[0].costInUsdTicks, null);
    assert.equal(committedMicroUsd(tariff.ledger), 80_000);
    assert.equal(tariff.trials[0].metadataDependency, 'qualification-metadata-missing');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('fractional actual ticks round up for the reservation and keep raw ticks for the mean', async () => {
  assert.equal(actualMicroUsdFromTicks(250_000_000), 25_000);
  assert.equal(actualMicroUsdFromTicks(250_000_001), 25_001);
  assert.equal(actualMicroUsdFromTicks(10_001), 2);
  assert.equal(actualMicroUsdFromTicks(0), 0);
  assert.equal(actualMicroUsdFromTicks(-1), null);
  assert.equal(actualMicroUsdFromTicks(1.5), null);

  const spent = {
    state: 'reserved',
    reservedMicroUsd: 80_000,
    costMicroUsd: null,
    cost: null,
    costInUsdTicks: null,
    tariffMicroUsd: null,
    costSource: null,
    replayed: false,
  };
  applyTaskView(spent, {
    state: 'succeeded',
    id: 'task-fraction',
    result: {qualification: {usage: [{cost_in_usd_ticks: 10_001}, {cost_in_usd_ticks: 1}]}},
  });
  assert.equal(spent.costInUsdTicks, 10_002);
  assert.equal(spent.costMicroUsd, 2);
  assert.equal(spent.costSource, 'actual-ticks');
  assert.equal(spent.state, 'reconciled');

  const invalid = {...spent, state: 'reserved', costMicroUsd: null, cost: null, costInUsdTicks: null, costSource: null};
  applyTaskView(invalid, {state: 'succeeded', result: {qualification: {usage: [{cost_in_usd_ticks: 1.5}]}}});
  assert.equal(invalid.costInUsdTicks, null);
  assert.equal(invalid.costSource, null);
  assert.equal(invalid.state, 'spent');
  assert.equal(invalid.costMicroUsd, 80_000);

  const directory = await mkdtemp(join(tmpdir(), 'ubc26-fractional-ticks-'));
  const ledgerPath = join(directory, 'ledger.json');
  try {
    const ledger = newLedger(config());
    const result = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({
        status: 200,
        json: async () => task({
          result: {
            kind: 'draft',
            qualification: {repairCount: 0, usage: [{cost_in_usd_ticks: 250_000_001}]},
            billing: {state: 'settled', microUsd: 1},
            attempts: [{traceId: 'trace-fraction', usage: {cost_in_usd_ticks: 250_000_001}}],
          },
        }),
      }),
    });
    const entry = result.ledger.entries[result.trials[0].key];
    assert.equal(entry.costSource, 'actual-ticks');
    assert.equal(entry.costInUsdTicks, 250_000_001);
    assert.equal(entry.costMicroUsd, 25_001);
    assert.equal(result.trials[0].costInUsdTicks, 250_000_001);
    assert.equal(committedMicroUsd(result.ledger), 25_001);
    assert.notEqual(committedMicroUsd(result.ledger), 80_000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }

  const score = {
    live: true,
    semanticAgreement: true,
    falseAccepts: 0,
    malformedAccepts: 0,
    quoteFidelity: true,
    inventedConditions: 0,
    weakerPayableJob: false,
  };
  const fresh = {
    dispatched: true,
    fresh: true,
    classification: 'supported',
    repairCount: 0,
    engineValid: true,
    score,
  };
  const under = aggregateGates([{...fresh, actualCostMicroUsd: 100_000, costInUsdTicks: 999_999_999}]);
  assert.equal(under.passed, true);
  assert.ok(under.meanCostMicroUsd > 99_999);
  assert.ok(under.meanCostMicroUsd < 100_000);
  const cap = aggregateGates([{...fresh, actualCostMicroUsd: 100_000, costInUsdTicks: 1_000_000_000}]);
  assert.equal(cap.passed, false);
  assert.equal(cap.meanCostMicroUsd, 100_000);
  const missing = aggregateGates([{...fresh, actualCostMicroUsd: 1, costInUsdTicks: null}]);
  assert.equal(missing.meanCostMicroUsd, null);
  assert.equal(missing.passed, false);
});

test('uncertain and unreported terminal costs keep the reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-uncertain-'));
  const networkPath = join(directory, 'network.json');
  const capPath = join(directory, 'cap.json');
  try {
    const failed = newLedger(config());
    const uncertain = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger: failed},
      ledgerPath: networkPath,
      trialsPerRequest: 1,
      fetchImpl: async () => {
        throw Error('socket closed at /Users/anishnarang/secret');
      },
    });
    assert.equal(uncertain.trials[0].state, 'uncertain');
    assert.equal(uncertain.trials[0].reason, 'network-error');
    assert.equal(uncertain.trials[0].message, null);
    assert.equal(JSON.stringify(uncertain).includes('/Users/'), false);
    assert.equal(JSON.stringify(uncertain).includes('secret'), false);
    assert.equal(uncertain.ledger.entries[uncertain.trials[0].key].state, 'reserved');
    assert.equal(committedMicroUsd(uncertain.ledger), 80_000);

    const quiet = newLedger({...config(), capMicroUsd: 80_000});
    const unreported = await runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: {...config(), ledger: quiet, capMicroUsd: 80_000},
      ledgerPath: capPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({status: 200, json: async () => task({id: 'task-2', attempt: 1})}),
    });
    assert.equal(unreported.ledger.entries[unreported.trials[0].key].cost, 'unreported');
    assert.equal(committedMicroUsd(unreported.ledger), 80_000);
    const blocked = await runBenchmark({
      challenges: [{...challenge, id: 'mixture-1'}],
      config: {...config(), ledger: quiet, capMicroUsd: 80_000},
      ledgerPath: capPath,
      trialsPerRequest: 1,
      fetchImpl: async () => {
        throw Error('should not dispatch');
      },
    });
    assert.equal(blocked.trials.at(-1).reason, 'cap-exhausted');
    assert.equal(blocked.paidTrialsRan, false);
    assert.equal(blocked.qualificationPassed, false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a 202 enqueue is polled and remote errors stay redacted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-poll-'));
  const ledgerPath = join(directory, 'ledger.json');
  const calls = [];
  try {
    const polled = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger: newLedger(config())},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        calls.push(options.method);
        if (options.method === 'POST') {
          return {status: 202, json: async () => task({state: 'queued', attempt: 0, result: undefined})};
        }
        return {status: 200, json: async () => settledDraft('task-polled', ['trace-polled'], 0)};
      },
    });
    assert.deepEqual(calls, ['POST', 'GET']);
    assert.equal(polled.trials[0].statusCode, 202);
    assert.equal(polled.trials[0].taskState, 'succeeded');
    assert.equal(polled.trials[0].fresh, true);
    assert.equal(polled.qualificationPassed, false);
    assert.equal(polled.paidTrialsRan, true);

    let readBody = false;
    const denied = await runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: {...config(), ledger: newLedger(config())},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({
        status: 500,
        headers: {'content-length': '120'},
        json: async () => {
          readBody = true;
          return {error: {code: 'internal', message: 'secret /Users/anishnarang/key sk-test'}};
        },
      }),
    });
    assert.equal(readBody, true);
    assert.equal(denied.trials[0].message, 'Hosted API request failed (500, internal)');
    assert.equal(JSON.stringify(denied).includes('sk-test'), false);
    assert.equal(JSON.stringify(denied).includes('/Users/'), false);

    const huge = await runBenchmark({
      challenges: [{...challenge, id: 'mixture-1'}],
      config: {...config(), ledger: newLedger(config())},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async () => ({
        status: 200,
        headers: {'content-length': '99999999'},
        json: async () => {
          throw Error('body should not be read');
        },
      }),
    });
    assert.equal(huge.trials[0].reason, 'response-too-large');
    assert.equal(huge.trials[0].message, null);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('three owners stay distinct and a replay is not a fresh model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-owners-'));
  const ledgerPath = join(directory, 'ledger.json');
  try {
    const calls = [];
    const fresh = await runBenchmark({
      challenges: [challenge],
      config: config({apiKeys: ['owner-a', 'owner-b', 'owner-c']}),
      ledgerPath,
      trialsPerRequest: 3,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({authorization: options.headers.authorization, key: options.headers['idempotency-key'], request: body.input.request, clarifications: body.input.clarifications});
        const index = calls.length;
        return {status: 200, json: async () => settledDraft(`task-${index}`, [`trace-${index}`], 0)};
      },
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((item) => item.authorization), ['Bearer owner-a', 'Bearer owner-b', 'Bearer owner-c']);
    assert.equal(new Set(calls.map((item) => item.key)).size, 3);
    assert.deepEqual(calls.map((item) => item.request), [challenge.prompt, challenge.prompt, challenge.prompt]);
    assert.deepEqual(calls.map((item) => item.clarifications), [[], [], []]);
    assert.deepEqual(fresh.trials.map((item) => item.taskId), ['task-1', 'task-2', 'task-3']);
    assert.equal(fresh.freshTrials, 3);
    assert.equal(fresh.qualificationPassed, false);
    assert.equal(fresh.trials.every((item) => item.score.live === false), true);

    const replayCalls = [];
    const replayed = await runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: config({apiKeys: ['owner-a', 'owner-b', 'owner-c'], ledger: newLedger(config())}),
      ledgerPath,
      trialsPerRequest: 3,
      fetchImpl: async (url, options) => {
        replayCalls.push(options.headers['idempotency-key']);
        return {
          status: 200,
          headers: {'idempotent-replayed': 'true'},
          json: async () => settledDraft('task-same', ['trace-same'], 0),
        };
      },
    });
    assert.equal(replayCalls.length, 3);
    assert.equal(replayed.freshTrials, 0);
    assert.equal(replayed.qualificationPassed, false);
    assert.equal(replayed.trials.every((item) => item.fresh === false), true);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('resume before task creation posts once and a lock prevents a second post', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-lock-'));
  const ledgerPath = join(directory, 'ledger.json');
  try {
    const ledger = newLedger(config());
    const key = trialKey(config().corpusId, 'mass-1', 1);
    ledger.entries[key] = {
      state: 'reserved',
      reservedMicroUsd: 80_000,
      taskId: null,
      attempt: null,
      costMicroUsd: null,
      cost: null,
      costInUsdTicks: null,
      tariffMicroUsd: null,
      costSource: null,
      replayed: false,
    };
    await persistLedger(ledgerPath, ledger);
    const calls = [];
    const resumed = await runBenchmark({
      challenges: [challenge],
      config: {...config(), ledger},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        calls.push(options.method);
        const stored = JSON.parse(await readFile(ledgerPath, 'utf8'));
        assert.equal(Object.keys(stored.entries).length, 1);
        return {status: 200, json: async () => settledDraft('task-resume', ['trace-resume'], 0)};
      },
    });
    assert.deepEqual(calls, ['POST']);
    assert.equal(resumed.paidTrialsRan, true);
    assert.equal(Object.keys(resumed.ledger.entries).length, 1);

    const parallel = [];
    const shared = newLedger(config());
    const first = runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: {...config(), ledger: shared},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        parallel.push(options.method);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {status: 200, json: async () => settledDraft('task-lock', ['trace-lock'], 0)};
      },
    });
    const second = runBenchmark({
      challenges: [{...challenge, id: 'yield-1'}],
      config: {...config(), ledger: shared},
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        parallel.push(options.method);
        return {status: 200, json: async () => settledDraft('task-lock', ['trace-lock'], 0)};
      },
    });
    await Promise.all([first, second]);
    assert.deepEqual(parallel, ['POST', 'GET']);
    assert.equal(Object.keys(shared.entries).filter((item) => item.includes('yield-1')).length, 1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('synthetic scores and aggregate gates stay closed without a live trial', () => {
  const supported = scoreTrial({
    challenge,
    response: {kind: 'draft', sourceQuotes: [{quote: 'Report one product.'}], live: false},
    candidateResults: [
      {id: 'valid', engine: 'pass', oracle: 'pass'},
      {id: 'wrong', engine: 'fail', oracle: 'fail'},
      {id: 'malformed', engine: 'reject', oracle: 'reject'},
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
  assert.equal(supported.validInputFalseRejects, 0);
  assert.equal(supported.malformedAccepts, 0);

  const malformed = scoreTrial({
    challenge,
    response: {kind: 'draft', sourceQuotes: [{quote: 'Report one product.'}]},
    candidateResults: [{id: 'bad', engine: 'pass', oracle: 'reject'}],
    live: false,
  });
  assert.equal(malformed.malformedAccepts, 1);
  assert.equal(malformed.falseAccepts, 1);
  assert.equal(malformed.missingRequirements, 0);
  const falseReject = scoreTrial({
    challenge,
    response: {kind: 'draft', sourceQuotes: [{quote: 'Report one product.'}]},
    candidateResults: [{id: 'valid', engine: 'fail', oracle: 'pass'}],
    live: false,
  });
  assert.equal(falseReject.validInputFalseRejects, 1);
  assert.equal(falseReject.inventedConditions, 1);
  assert.equal(falseReject.semanticAgreement, false);

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

  const closed = aggregateGates([{dispatched: true, fresh: false, score: {live: false}}]);
  assert.equal(closed.passed, false);
  assert.equal(closed.reason, 'no-fresh-trials');
  assert.equal(closed.fundingApproval, false);
  const offline = aggregateGates([{
    dispatched: true,
    fresh: true,
    classification: 'supported',
    repairCount: 0,
    engineValid: true,
    actualCostMicroUsd: 1,
    score: {live: false, semanticAgreement: true, falseAccepts: 0, malformedAccepts: 0, quoteFidelity: true, inventedConditions: 0},
  }]);
  assert.equal(offline.passed, false);
  assert.equal(offline.reason, 'not-live');
  const open = aggregateGates([{
    dispatched: true,
    fresh: true,
    classification: 'supported',
    repairCount: 0,
    engineValid: true,
    actualCostMicroUsd: 1,
    score: {live: true, semanticAgreement: true, falseAccepts: 0, malformedAccepts: 0, quoteFidelity: true, inventedConditions: 0, weakerPayableJob: false},
  }]);
  assert.equal(open.passed, true);
  const costly = aggregateGates([{
    ...open && {},
    dispatched: true,
    fresh: true,
    classification: 'supported',
    repairCount: 0,
    engineValid: true,
    actualCostMicroUsd: 100_000,
    score: {live: true, semanticAgreement: true, falseAccepts: 0, malformedAccepts: 0, quoteFidelity: true},
  }]);
  assert.equal(costly.passed, false);
});

test('clarification and unsupported terminals without qualification stay unfresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-terminal-'));
  const ledgerPath = join(directory, 'ledger.json');
  try {
    const result = await runBenchmark({
      challenges: [
        {id: 'hq-ambiguous-1', classification: 'ambiguous', prompt: 'Charge this harbor call a fair fee and accept the manifest.', facets: ['fee table'], outputs: [{name: 'manifest.json', format: 'json'}]},
        {id: 'hq-unsupported-2', classification: 'unsupported', prompt: 'Compute a decimal reimbursement ratio with division inside the checker.', capabilityRequests: [{kind: 'operation', name: 'div'}], outputs: [{name: 'ratio.json', format: 'json'}]},
      ],
      config: config(),
      ledgerPath,
      trialsPerRequest: 1,
      fetchImpl: async (url, options) => {
        const request = JSON.parse(options.body).input.request;
        const clarification = request.includes('manifest');
        return {
          status: 200,
          json: async () => task({
            id: clarification ? 'task-clarification' : 'task-unsupported',
            result: clarification
              ? {kind: 'clarification', questions: ['Which fee table applies?'], billing: {state: 'settled', microUsd: 1, source: 'tariff'}}
              : {kind: 'unsupported', reason: 'The catalog has no div operation.', billing: {state: 'settled', microUsd: 1, source: 'tariff'}},
          }),
        };
      },
    });
    assert.equal(result.paidTrialsRan, true);
    assert.equal(result.freshTrials, 0);
    assert.equal(result.qualificationPassed, false);
    assert.deepEqual(result.trials.map((item) => item.taskId), ['task-clarification', 'task-unsupported']);
    assert.deepEqual(result.trials.map((item) => item.traceIds), [[], []]);
    for (const trial of result.trials) {
      assert.equal(trial.terminal, true);
      assert.equal(trial.repairCount, null);
      assert.equal(trial.metadataDependency, 'qualification-metadata-missing');
      assert.equal(trial.fresh, false);
      assert.equal(trial.freshReason, 'qualification-metadata-missing');
      assert.equal(trial.costInUsdTicks, null);
      assert.equal(trial.tariffMicroUsd, 1);
    }
    assert.equal(committedMicroUsd(result.ledger), 160_000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
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
  assert.equal(loadDeployment().dispatch, false);
});
