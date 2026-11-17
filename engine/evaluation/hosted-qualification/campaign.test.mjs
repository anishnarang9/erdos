import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runBenchmark, trialKey} from './trials.mjs';
import {committedMicroUsd, withLedgerLock} from './budget.mjs';

const NOW = Date.parse('2026-11-17T07:00:00.000Z');
const iso = offset => new Date(NOW + offset).toISOString();
const request = {id: 'campaign-first', classification: 'ambiguous', prompt: 'Which fee table?', outputs: [{name: 'bill.json', format: 'json'}]};
const second = {...request, id: 'campaign-second', prompt: 'Which tax table?'};
function config(extra = {}) {
  return {dispatch: true, live: false, baseUrl: 'https://fixture.example.test', apiKeys: ['key-a'],
    scope: 'benchmark', capMicroUsd: 1_000_000, attemptPriceMicroUsd: 40_000, corpusId: 'campaign-fixture',
    maxPolls: 2, pollIntervalMs: 0, minPostIntervalMs: 0, now: () => NOW, ...extra};
}
function identity(index = 1) {
  return {id: `key-${index}`, wallet: `0x${String(index).padStart(40, '0')}`, scopes: ['buyer'], createdAt: iso(-60_000)};
}
function task(id = 'task-a', trace = 'trace-a', extra = {}) {
  const usage = {costInUsdTicks: 10_001};
  return {id, operation: 'draft', state: 'succeeded', attempt: 1, createdAt: iso(0), updatedAt: iso(1),
    result: {kind: 'clarification', questions: ['Which fee table?'], qualification: {repairCount: 0, traceId: trace, traceIds: [trace], usage: [usage]}, attempts: [{traceId: trace, usage}]}, ...extra};
}
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-campaign-'));
  try { await fn(join(directory, 'ledger.json')); }
  finally { await rm(directory, {recursive: true, force: true}); }
}
function run(ledgerPath, fetchImpl, extra = {}) {
  return runBenchmark({challenges: [request], config: config(), ledgerPath, trialsPerRequest: 1, fetchImpl, ...extra});
}
const isAuth = url => String(url).endsWith('/v1/auth/keys/current');

test('different credentials for the same wallet stop before any task POST', () => fixture(async ledgerPath => {
  let posts = 0, auth = 0;
  const result = await run(ledgerPath, async (url, init) => {
    if (isAuth(url)) { auth++; return Response.json({...identity(), id: `different-key-${auth}`}); }
    posts++; return Response.json(task(`task-${posts}`, `trace-${posts}`));
  }, {config: config({apiKeys: ['key-a', 'key-b', 'key-c']}), trialsPerRequest: 3});
  assert.equal(posts, 0);
  assert.ok(auth >= 2);
  assert.equal(result.reason, 'duplicate-wallet-principals');
  assert.equal(result.paidTrialsRan, false);
}));

test('a revoked or malformed current principal fails before paid work', () => fixture(async ledgerPath => {
  for (const principal of [null, {...identity(), scopes: []}, {...identity(), wallet: 'bad-wallet'}]) {
    let posts = 0;
    const result = await run(ledgerPath, async (url) => {
      if (isAuth(url)) return principal ? Response.json(principal) : Response.json({error: {code: 'unauthorized', message: 'private-secret'}}, {status: 401});
      posts++; return Response.json(task());
    });
    assert.equal(posts, 0);
    assert.equal(result.paidTrialsRan, false);
    assert.equal(result.qualificationPassed, false);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
  }
}));

test('a campaign persists identity before dispatch and retains genuine freshness on GET resume', () => fixture(async ledgerPath => {
  const calls = [];
  let campaignId;
  const fetchImpl = async (url, init) => {
    if (isAuth(url)) return Response.json(identity());
    calls.push(init.method);
    const stored = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.match(stored.campaign.id, /^[0-9a-f-]{36}$/);
    assert.equal(stored.campaign.startedAt, iso(0));
    assert.equal(stored.campaign.principals[0].wallet, identity().wallet);
    const entry = stored.entries[trialKey('campaign-fixture', request.id, 1)];
    assert.equal(entry.provenance.dispatchStartedAt, iso(0));
    assert.equal(JSON.stringify(stored).includes('Bearer'), false);
    campaignId = stored.campaign.id;
    return Response.json(task());
  };
  const first = await run(ledgerPath, fetchImpl);
  assert.equal(first.freshTrials, 1);
  const resumed = await run(ledgerPath, fetchImpl);
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.equal(resumed.ledger.campaign.id, campaignId);
  assert.equal(resumed.freshTrials, 1);
  assert.equal(resumed.paidTrialsRan, false);
  assert.equal(committedMicroUsd(resumed.ledger), 2);
}));

test('an old semantic cache hit without a replay header stops further work and retains the reservation', () => fixture(async ledgerPath => {
  let posts = 0;
  const result = await run(ledgerPath, async (url) => {
    if (isAuth(url)) return Response.json(identity());
    posts++; return Response.json(task('old-task', 'old-trace', {createdAt: iso(-1_000), updatedAt: iso(-500)}));
  }, {challenges: [request, second]});
  assert.equal(posts, 1);
  assert.equal(result.reason, 'stale-task');
  assert.equal(result.freshTrials, 0);
  assert.equal(committedMicroUsd(result.ledger), 80_000);
}));

test('global task or provider trace reuse halts before another trial', () => fixture(async ledgerPath => {
  for (const kind of ['task', 'trace']) {
    let posts = 0;
    const result = await run(`${ledgerPath}-${kind}`, async url => {
      if (isAuth(url)) return Response.json(identity());
      posts++;
      return Response.json(task(kind === 'task' ? 'shared-task' : `task-${posts}`, kind === 'trace' ? 'shared-trace' : `trace-${posts}`));
    }, {challenges: [request, second, {...second, id: 'third'}]});
    assert.equal(posts, 2);
    assert.equal(result.freshTrials, 0);
    assert.equal(result.reason, kind === 'task' ? 'reused-task' : 'reused-provider-trace');
  }
}));

test('principal changes on resume cannot read or dispatch campaign work', () => fixture(async ledgerPath => {
  await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(task()));
  let work = 0;
  const result = await run(ledgerPath, async url => {
    if (isAuth(url)) return Response.json(identity(2));
    work++; return Response.json(task());
  });
  assert.equal(work, 0);
  assert.equal(result.reason, 'campaign-principals-changed');
  assert.equal(result.paidTrialsRan, false);
}));

test('an unknown original POST resumes with its original key and reservation', () => fixture(async ledgerPath => {
  const keys = [];
  const first = await run(ledgerPath, async (url, init) => {
    if (isAuth(url)) return Response.json(identity());
    keys.push(init.headers['idempotency-key']);
    throw new Error('unknown outcome');
  });
  assert.equal(committedMicroUsd(first.ledger), 80_000);
  const resumed = await run(ledgerPath, async (url, init) => {
    if (isAuth(url)) return Response.json(identity());
    keys.push(init.headers['idempotency-key']);
    return Response.json(task(), {headers: {'idempotent-replayed': 'true'}});
  });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(resumed.freshTrials, 1);
  assert.equal(committedMicroUsd(resumed.ledger), 2);
}));

test('default polling can observe a sixth queued-task read', () => fixture(async ledgerPath => {
  let polls = 0;
  const cfg = config(); delete cfg.maxPolls;
  const result = await run(ledgerPath, async (url, init) => {
    if (isAuth(url)) return Response.json(identity());
    if (init.method === 'GET') polls++;
    return Response.json(task('task-a', 'trace-a', polls < 6 ? {state: 'queued', attempt: 0, result: undefined} : {}));
  }, {config: cfg});
  assert.equal(polls, 6);
  assert.equal(result.freshTrials, 1);
}));

test('polling cannot replace the accepted task identity or release its reservation', () => fixture(async ledgerPath => {
  const result = await run(ledgerPath, async (url, init) => {
    if (isAuth(url)) return Response.json(identity());
    return Response.json(init.method === 'POST' ? task('original-task', 'trace-a', {state: 'queued', attempt: 0, result: undefined}) : task('different-task', 'trace-b'));
  });
  assert.equal(result.reason, 'task-binding-changed');
  assert.equal(result.ledger.entries[trialKey('campaign-fixture', request.id, 1)].taskId, 'original-task');
  assert.equal(committedMicroUsd(result.ledger), 80_000);
}));


test('a changed origin is rejected locally before credentials leave the bound host', () => fixture(async ledgerPath => {
  await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(task()));
  let calls = 0;
  const result = await run(ledgerPath, async url => { calls++; return isAuth(url) ? Response.json(identity()) : Response.json(task()); },
    {config: config({baseUrl: 'https://other.example.test'})});
  assert.equal(calls, 0);
  assert.equal(result.reason, 'campaign-binding-changed');
}));

test('malformed stored reservations reject before any network request', () => fixture(async ledgerPath => {
  await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(task()));
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  Object.values(ledger.entries)[0].reservedMicroUsd = -1;
  await writeFile(ledgerPath, JSON.stringify(ledger));
  let calls = 0;
  const result = await run(ledgerPath, async url => { calls++; return isAuth(url) ? Response.json(identity()) : Response.json(task('second', 'second')); }, {challenges: [second]});
  assert.equal(calls, 0);
  assert.equal(result.reason, 'invalid-ledger');
}));

test('changed input cannot reuse a campaign trial or trigger another charge', () => fixture(async ledgerPath => {
  await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(task()));
  let work = 0;
  const result = await run(ledgerPath, async url => { if (isAuth(url)) return Response.json(identity()); work++; return Response.json(task()); },
    {challenges: [{...request, prompt: 'A changed request'}]});
  assert.equal(work, 0);
  assert.equal(result.reason, 'campaign-input-changed');
}));

test('a changed terminal result cannot replace the original bill', () => fixture(async ledgerPath => {
  await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(task()));
  const changed = task(); changed.result.qualification.usage[0].costInUsdTicks = 0;
  const result = await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(changed));
  assert.equal(result.reason, 'task-result-changed');
  assert.equal(result.freshTrials, 0);
  assert.equal(committedMicroUsd(result.ledger), 2);
}));

test('an unknown dispatch blocks unrelated work until its original request is recovered', () => fixture(async ledgerPath => {
  const first = await run(ledgerPath, async url => { if (isAuth(url)) return Response.json(identity()); throw Error('unknown'); });
  let posts = 0;
  const blocked = await run(ledgerPath, async url => { if (isAuth(url)) return Response.json(identity()); posts++; return Response.json(task()); }, {challenges: [second]});
  assert.equal(posts, 0);
  assert.equal(blocked.reason, 'unresolved-trial');
  assert.equal(committedMicroUsd(blocked.ledger), committedMicroUsd(first.ledger));
}));

test('failed-task details retain actual provider cost and call metadata', () => fixture(async ledgerPath => {
  const failed = task();
  failed.state = 'failed'; failed.error = {code: 'model_failed', message: 'The model failed', details: failed.result}; delete failed.result;
  const result = await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(failed));
  assert.equal(committedMicroUsd(result.ledger), 2);
  assert.equal(result.trials[0].metadataDependency, null);
  assert.deepEqual(result.trials[0].traceIds, ['trace-a']);
  assert.equal(result.freshTrials, 0);
}));


test('an incomplete lock file cannot be removed to enter a second writer', () => fixture(async ledgerPath => {
  await writeFile(`${ledgerPath}.lock`, '');
  let entered = false;
  await assert.rejects(withLedgerLock(ledgerPath, async () => { entered = true; }), {code: 'ledger-lock-timeout'});
  assert.equal(entered, false);
  assert.equal(await readFile(`${ledgerPath}.lock`, 'utf8'), '');
}));

test('a passing partial score cannot claim the full frozen qualification', () => fixture(async ledgerPath => {
  const supported = {...request, classification: 'supported'};
  const view = task(); view.result = {...view.result, kind: 'draft', plan: {version: 1}, sourceQuotes: [{quote: 'Which fee table?'}]};
  const result = await run(ledgerPath, async url => isAuth(url) ? Response.json(identity()) : Response.json(view), {
    challenges: [supported], config: config({live: true, assessImpl: async () => ({engineValid: true, candidateResults: [{id: 'pass', engine: 'pass', oracle: 'pass'}]})}),
  });
  assert.equal(result.aggregate.passed, true);
  assert.equal(result.qualificationPassed, false);
  assert.equal(result.reason, 'incomplete-corpus');
}));
