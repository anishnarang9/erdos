import {pathToFileURL} from 'node:url';
import {CORPUS_ID} from './corpus.mjs';
import {applyTaskView, newLedger, persistLedger, reserveTrial} from './budget.mjs';

export function loadDeployment(env = process.env) {
  const cap = env.UBC26_BENCHMARK_CAP_MICRO_USD;
  const price = env.UBC26_ATTEMPT_PRICE_MICRO_USD;
  return {
    baseUrl: env.UBC26_HOSTED_BASE_URL || null,
    apiKey: env.UBC26_HOSTED_API_KEY || null,
    scope: env.UBC26_BENCHMARK_SCOPE || null,
    capMicroUsd: cap == null || cap === '' ? null : Number(cap),
    attemptPriceMicroUsd: price == null || price === '' ? null : Number(price),
    corpusId: CORPUS_ID,
    dispatch: false,
  };
}

export function trialKey(corpusId, challengeId, trial) {
  return `qual-${corpusId}-${challengeId}-trial-${trial}`;
}

export function draftInput(challenge) {
  return {
    request: challenge.prompt,
    outputs: challenge.outputs ?? [],
    references: Object.entries(challenge.referenceFiles ?? {}).map(([name, bytes]) => ({
      name,
      contentBase64: Buffer.from(bytes).toString('base64'),
    })),
    clarifications: [],
    expirySeconds: 3600,
    maxBudget: '10000',
  };
}

function headers(config, key) {
  return {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
    ...(key ? {'Idempotency-Key': key} : {}),
  };
}

function repairCount(attempt) {
  return Number.isSafeInteger(attempt) ? Math.max(0, attempt - 1) : null;
}

export async function runBenchmark({challenges, config, ledgerPath, fetchImpl, trialsPerRequest = 3}) {
  if (!config?.dispatch || !config.baseUrl || !config.apiKey) {
    return {
      paidTrialsRan: false,
      reason: config?.baseUrl && config?.apiKey ? 'dispatch-disabled' : 'missing-deployment',
      trials: [],
    };
  }
  const ledger = config.ledger ?? newLedger(config);
  const trials = [];
  let paidTrialsRan = false;
  for (const challenge of challenges) {
    for (let trial = 1; trial <= trialsPerRequest; trial += 1) {
      const key = trialKey(config.corpusId, challenge.id, trial);
      const reserved = await reserveTrial(ledgerPath, ledger, key);
      if (!reserved.ok) {
        trials.push({challengeId: challenge.id, trial, key, dispatched: false, reason: reserved.reason});
        return {paidTrialsRan, reason: reserved.reason, trials, ledger};
      }
      const entry = ledger.entries[key];
      const input = draftInput(challenge);
      const method = entry.taskId ? 'GET' : 'POST';
      try {
        if (method === 'GET') {
          const response = await fetchImpl(`${config.baseUrl}/v1/tasks/${entry.taskId}`, {method: 'GET', headers: headers(config)});
          applyTaskView(entry, await response.json());
        } else {
          const response = await fetchImpl(`${config.baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: headers(config, key),
            body: JSON.stringify({operation: 'draft', input}),
          });
          paidTrialsRan = true;
          applyTaskView(entry, await response.json());
        }
        await persistLedger(ledgerPath, ledger);
        trials.push({
          challengeId: challenge.id,
          trial,
          key,
          dispatched: true,
          method,
          state: entry.state,
          taskId: entry.taskId,
          repairCount: repairCount(entry.attempt),
          cost: entry.cost,
          inputKeys: Object.keys(input),
        });
      } catch (error) {
        entry.state = 'reserved';
        paidTrialsRan = true;
        await persistLedger(ledgerPath, ledger);
        trials.push({
          challengeId: challenge.id,
          trial,
          key,
          dispatched: true,
          state: 'uncertain',
          reason: 'network-error',
          message: error.message,
          repairCount: null,
          cost: null,
        });
      }
    }
  }
  return {paidTrialsRan, reason: null, trials, ledger};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const deployment = loadDeployment();
  const result = await runBenchmark({
    challenges: [],
    config: deployment,
    ledgerPath: '',
    fetchImpl: globalThis.fetch,
    trialsPerRequest: 0,
  });
  console.log(JSON.stringify({paidTrialsRan: result.paidTrialsRan, reason: result.reason, trials: result.trials}));
}
