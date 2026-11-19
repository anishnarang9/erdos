import {pathToFileURL} from 'node:url';
import {CORPUS_ID, CORPUS_DIGEST, canonicalCorpus} from './corpus.mjs';
import {assessSupportedDraft} from './assess.mjs';
import {scoreHostedDraftGates, scoreTrial} from './score.mjs';
import {applyTaskView, committedMicroUsd, dispatchDecision, newLedger, persistLedger, readLedger, reserveTrial, TICKS_PER_MICRO_USD, withLedgerLock} from './budget.mjs';

import {bindCampaign, bindTrial, campaignError, clock, failCampaign, fingerprint, principal, validateGlobalEvidence, validateTaskBinding} from './campaign.mjs';

// Reviewed provider bound in docs/hosted-model-costs.md. Recheck it before live enablement.
const REVIEWED_LIVE_MODEL = 'grok-4.20-0309-non-reasoning';
const REVIEWED_LIVE_ATTEMPT_MICRO_USD = 2_540_960;

const MAX_BYTES = 4_194_304;
const TERMINAL = new Set(['succeeded', 'failed', 'uncertain']);
const KNOWN_CODES = new Set([
  'validation_failed', 'unauthorized', 'forbidden', 'not_found', 'revision_conflict', 'approval_required',
  'payload_too_large', 'idempotency_key_reused', 'capability_unsupported', 'rate_limited', 'wrong_state',
  'chain_unavailable', 'terms_mismatch', 'model_unavailable', 'model_invalid', 'engine_unavailable',
  'payment_required', 'payment_invalid', 'payment_pending', 'payment_failed', 'payment_conflict',
  'payment_unavailable', 'quote_expired', 'chain_unconfirmed', 'engine_failed', 'model_failed',
  'service_disabled', 'internal', 'not_implemented',
]);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function loadDeployment(env = process.env) {
  const cap = env.UBC26_BENCHMARK_CAP_MICRO_USD;
  const price = env.UBC26_ATTEMPT_PRICE_MICRO_USD;
  const apiKeys = [1, 2, 3]
    .map((index) => env[`UBC26_BENCHMARK_API_KEY_${index}`])
    .filter((item) => typeof item === 'string' && item !== '');
  return {
    baseUrl: env.UBC26_HOSTED_BASE_URL || null,
    apiKeys,
    scope: env.UBC26_BENCHMARK_SCOPE || null,
    capMicroUsd: cap == null || cap === '' ? null : Number(cap),
    attemptPriceMicroUsd: price == null || price === '' ? null : Number(price),
    corpusId: CORPUS_ID,
    model: env.UBC26_BENCHMARK_MODEL || null,
    dispatch: false,
    live: false,
  };
}

export function trialKey(corpusId, challengeId, trial) {
  return `qual-${corpusId}-${challengeId}-trial-${trial}`;
}

export function draftInput(challenge) {
  const input = {
    request: challenge.prompt,
    outputs: (challenge.outputs ?? []).map((item) => ({name: item.name, format: item.format})),
    references: Object.entries(challenge.referenceFiles ?? {}).map(([name, bytes]) => ({
      name,
      contentBase64: Buffer.from(bytes).toString('base64'),
    })),
    clarifications: [],
    expirySeconds: 3600,
    maxBudget: '10000',
  };
  if (Array.isArray(challenge.exampleFixtures)) input.exampleFixtures = structuredClone(challenge.exampleFixtures);
  if (input.exampleFixtures) {
    const ordered = {
      request: input.request,
      outputs: input.outputs,
      references: input.references,
      exampleFixtures: input.exampleFixtures,
      clarifications: input.clarifications,
      expirySeconds: input.expirySeconds,
      maxBudget: input.maxBudget,
    };
    return ordered;
  }
  return input;
}

export function checkOrigin(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return {ok: false, reason: 'invalid-origin'};
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') {
    return {ok: false, reason: 'insecure-origin'};
  }
  return {ok: true, origin: url.origin};
}

function listedKeys(config) {
  if (Array.isArray(config?.apiKeys)) return config.apiKeys;
  if (typeof config?.apiKey === 'string') return [config.apiKey];
  return [];
}

export function principalKeys(config, trialsPerRequest) {
  const listed = listedKeys(config);
  const keys = listed.filter((item) => typeof item === 'string' && item.length > 0 && !/[\r\n]/.test(item));
  if (keys.length !== listed.length || keys.length < trialsPerRequest) return {ok: false, reason: 'missing-principals'};
  if (new Set(keys).size !== keys.length) return {ok: false, reason: 'duplicate-principals'};
  return {ok: true, keys};
}

function terminalData(view) { return view?.result ?? view?.error?.details; }

export function readRepairCount(view) {
  const value = terminalData(view)?.qualification?.repairCount;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function collectTraceIds(view) {
  const result = terminalData(view);
  const qualification = result?.qualification;
  const repairCount = readRepairCount(view);
  if (repairCount !== 0 && repairCount !== 1) return [];
  const needed = repairCount + 1;
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 512;
  let ids = null;
  if (Object.hasOwn(qualification, 'traceIds')) {
    if (!Array.isArray(qualification.traceIds)) return [];
    ids = qualification.traceIds;
  }
  if (Object.hasOwn(result, 'attempts')) {
    if (!Array.isArray(result.attempts)) return [];
    const attempts = result.attempts.map(item => item?.traceId);
    if (ids && JSON.stringify(ids) !== JSON.stringify(attempts)) return [];
    ids = attempts;
  }
  if (qualification.traceId != null) {
    if (!validId(qualification.traceId)) return [];
    if (ids && qualification.traceId !== ids.at(-1)) return [];
    if (!ids) ids = [qualification.traceId];
  }
  if (Object.hasOwn(qualification, 'usage') &&
      (!Array.isArray(qualification.usage) || qualification.usage.length !== needed)) return [];
  // Aliases describe the same calls. A repair still requires a second distinct call identity.
  if (!ids || ids.length !== needed || !ids.every(validId) || new Set(ids).size !== needed) return [];
  return [...ids];
}

function qualificationMetadata(view) {
  const qualification = terminalData(view)?.qualification;
  const model = typeof qualification?.model === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(qualification.model) ? qualification.model : null;
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
  return {model, promptVersion: digest(qualification?.promptVersion), catalogVersion: digest(qualification?.catalogVersion),
    latencyMs: Number.isSafeInteger(qualification?.latencyMs) && qualification.latencyMs >= 0 ? qualification.latencyMs : null};
}

function artifactPair(view) {
  const result = terminalData(view);
  const usage = Array.isArray(result?.qualification?.usage) ? result.qualification.usage : [];
  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  const initialUsage = attempts[0]?.usage ?? usage[0] ?? null;
  const repairUsage = attempts[1]?.usage ?? usage[1] ?? null;
  return {
    initial: {model: attempts[0]?.model ?? null, traceId: attempts[0]?.traceId ?? null, usage: initialUsage},
    repair: attempts[1] || usage[1] ? {model: attempts[1]?.model ?? null, traceId: attempts[1]?.traceId ?? null, usage: repairUsage} : null,
  };
}

export function markFresh(group) {
  const taskIds = group.map((item) => item.taskId).filter(Boolean);
  const traces = group.flatMap((item) => item.traceIds ?? []);
  const duplicateTrace = new Set(traces.filter((id, index) => traces.indexOf(id) !== index));
  for (const item of group) {
    const copies = item.taskId ? taskIds.filter((id) => id === item.taskId).length : 0;
    const needed = item.repairCount === 1 ? 2 : item.repairCount === 0 ? 1 : null;
    const uniqueTraces = new Set(item.traceIds ?? []);
    let reason = null;
    if (!item.terminal) reason = 'not-terminal';
    else if (item.taskState !== 'succeeded') reason = 'task-failed';
    else if (item.provenanceAccepted !== true && item.method !== 'POST') reason = 'cached-task';
    else if (item.provenanceAccepted !== true && item.replayed) reason = 'replayed-task';
    else if (!item.taskId || copies !== 1) reason = 'replayed-task';
    else if (item.repairCount > 1) reason = 'repair-limit';
    else if (needed == null) reason = 'qualification-metadata-missing';
    else if ((item.traceIds ?? []).length < needed || uniqueTraces.size !== (item.traceIds ?? []).length) reason = 'missing-provider-trace';
    else if ((item.traceIds ?? []).some((id) => duplicateTrace.has(id))) reason = 'missing-provider-trace';
    item.fresh = reason == null && item.taskState === 'succeeded';
    item.freshReason = item.fresh ? null : reason;
  }
  return group;
}

const COST_CAP_MICRO_USD = 100_000;

function freshCostGate(fresh) {
  const hasTicks = fresh.some((item) => Object.hasOwn(item, 'costInUsdTicks'));
  if (!hasTicks) {
    const costs = fresh.map((item) => item.actualCostMicroUsd);
    if (!costs.every((item) => Number.isSafeInteger(item) && item >= 0)) return {meanCostMicroUsd: null, underCap: false};
    const meanCostMicroUsd = costs.reduce((total, item) => total + item, 0) / costs.length;
    return {meanCostMicroUsd, underCap: meanCostMicroUsd < COST_CAP_MICRO_USD};
  }
  let total = 0n;
  for (const item of fresh) {
    const ticks = item.costInUsdTicks;
    if (!Number.isSafeInteger(ticks) || ticks < 0) return {meanCostMicroUsd: null, underCap: false};
    total += BigInt(ticks);
  }
  const count = BigInt(fresh.length);
  const underCap = total < BigInt(COST_CAP_MICRO_USD) * BigInt(TICKS_PER_MICRO_USD) * count;
  return {meanCostMicroUsd: Number(total) / Number(count) / TICKS_PER_MICRO_USD, underCap};
}

export function aggregateGates(trials) {
  const dispatched = trials.filter((item) => item.dispatched);
  const fresh = dispatched.filter((item) => item.fresh);
  const closed = {passed: false, freshTrials: fresh.length, fundingApproval: false, meanCostMicroUsd: null, semanticRate: null, buyerReviewRate: null};
  if (fresh.length === 0 || fresh.length !== dispatched.length) {
    return {...closed, reason: fresh.length === 0 ? 'no-fresh-trials' : 'incomplete-trial'};
  }
  if (fresh.some((item) => item.score?.live !== true)) return {...closed, reason: 'not-live'};
  if (fresh.some((item) => item.repairCount > 1)) return {...closed, reason: 'repair-limit'};
  const supported = fresh.filter((item) => item.classification === 'supported');
  const agreed = supported.filter((item) => item.score?.semanticAgreement === true && item.engineValid === true
    && Number.isSafeInteger(item.repairCount) && item.repairCount <= 1);
  const semanticRate = supported.length === 0 ? 0 : agreed.length / supported.length;
  const buyerReviewRate = supported.length === 0 ? 0
    : agreed.filter(item => item.draftGates?.readyForBuyerReview === true).length / supported.length;
  const falseAccepts = supported.reduce((total, item) => total + (item.score?.falseAccepts ?? 0), 0);
  const malformedAccepts = supported.reduce((total, item) => total + (item.score?.malformedAccepts ?? 0), 0);
  const quotes = fresh.every((item) => item.score?.quoteFidelity === true);
  const ambiguousOk = fresh.filter((item) => item.classification === 'ambiguous')
    .every(item => item.score?.inventedConditions === 0 && item.score?.facetCount > 0
      && item.score.clarificationFacets === item.score.facetCount);
  const unsupportedOk = fresh.filter((item) => item.classification === 'unsupported')
    .every((item) => item.score?.weakerPayableJob === false && item.score?.unsupportedExplanation === true);
  const costGate = freshCostGate(fresh);
  const meanCostMicroUsd = costGate.meanCostMicroUsd;
  const passed = supported.length > 0 && buyerReviewRate >= 0.95 && falseAccepts === 0 && malformedAccepts === 0
    && quotes && ambiguousOk && unsupportedOk && costGate.underCap;
  return {
    passed,
    reason: passed ? null : 'gate-failed',
    freshTrials: fresh.length,
    fundingApproval: false,
    semanticRate,
    buyerReviewRate,
    falseAccepts,
    malformedAccepts,
    meanCostMicroUsd,
  };
}

function deploymentReason(config, trialsPerRequest) {
  if (!config?.baseUrl || listedKeys(config).length === 0) return 'missing-deployment';
  if (!config.dispatch) return 'dispatch-disabled';
  const origin = checkOrigin(config.baseUrl);
  if (!origin.ok) return origin.reason;
  const keys = principalKeys(config, trialsPerRequest);
  if (!keys.ok) return keys.reason;
  return null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found ? String(found[1]) : null;
}

function authHeaders(apiKey, replayKey) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...(replayKey ? {'idempotency-key': replayKey} : {}),
  };
}

async function decodeJson(response, maximum) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw coded('response-too-large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      throw coded('invalid-json');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw coded('invalid-json');
    }
  }
  if (typeof response?.json !== 'function') throw coded('invalid-json');
  let value;
  try {
    value = await response.json();
  } catch {
    throw coded('invalid-json');
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maximum) throw coded('response-too-large');
  return value;
}

async function errorCode(response, maximum) {
  try {
    const body = await decodeJson(response, maximum);
    const code = body?.error?.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) return code;
  } catch (error) {
    if (error.code === 'response-too-large') throw error;
  }
  return 'request_failed';
}

export function parseTaskView(value) {
  const states = ['queued', 'running', 'succeeded', 'failed', 'uncertain'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw coded('invalid-task');
  if (typeof value.id !== 'string' || value.id === '') throw coded('invalid-task');
  if (value.operation !== 'draft' && value.operation !== 'compile') throw coded('invalid-task');
  if (!states.includes(value.state) || !Number.isSafeInteger(value.attempt) || value.attempt < 0) throw coded('invalid-task');
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw coded('invalid-task');
  return value;
}

async function transport(fetchImpl, url, options, config) {
  const maximum = config.maxResponseBytes ?? MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? 30_000;
  let response;
  try {
    response = await fetchImpl(url, {...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    const name = error?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw coded('transport-timeout');
    throw coded('network-error');
  }
  const declared = headerValue(response?.headers, 'content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel?.();
    throw coded('response-too-large');
  }
  const status = Number.isInteger(response?.status) ? response.status : 200;
  if (status < 200 || status >= 300) {
    const code = await errorCode(response, maximum);
    throw Object.assign(new Error(`Hosted API request failed (${status}, ${code})`), {code, status});
  }
  const value = await decodeJson(response, maximum);
  return {status, replayed: headerValue(response?.headers, 'idempotent-replayed') === 'true', value};
}

function publicError(error) {
  if (typeof error?.message === 'string' && error.message.startsWith('Hosted API request failed (')) return error.message;
  return null;
}

function closedResult(reason, ledger = null) {
  return {paidTrialsRan: false, freshTrials: 0, qualificationPassed: false, reason, trials: [], ledger, aggregate: aggregateGates([])};
}

export async function runBenchmark({challenges, config, ledgerPath, fetchImpl, trialsPerRequest = 3}) {
  const reason = deploymentReason(config, trialsPerRequest);
  if (reason) return closedResult(reason, config?.ledger ?? null);
  if (!Number.isSafeInteger(trialsPerRequest) || trialsPerRequest < 1 || challenges.length === 0) return closedResult('no-trials', config.ledger ?? null);
  if (config.live === true) {
    if (config.model !== REVIEWED_LIVE_MODEL) return closedResult('unreviewed-live-model', config.ledger ?? null);
    if (!Number.isSafeInteger(config.attemptPriceMicroUsd) || config.attemptPriceMicroUsd < REVIEWED_LIVE_ATTEMPT_MICRO_USD) {
      return closedResult('live-price-below-reviewed-bound', config.ledger ?? null);
    }
  }
  const origin = checkOrigin(config.baseUrl).origin;
  const keys = principalKeys(config, trialsPerRequest).keys.slice(0, trialsPerRequest);
  const ledger = config.ledger ?? newLedger(config);
  const trials = [];
  let paidTrialsRan = false;
  const maxPolls = config.maxPolls ?? 180;
  const pollIntervalMs = config.pollIntervalMs ?? 2_000;
  const minPostIntervalMs = config.minPostIntervalMs ?? 3_000;
  const pollDeadlineMs = config.pollDeadlineMs ?? 360_000;
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 1_000 ||
      ![pollIntervalMs, minPostIntervalMs].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 60_000) ||
      !Number.isSafeInteger(pollDeadlineMs) || pollDeadlineMs < 1 || pollDeadlineMs > 3_600_000) return closedResult('invalid-poll-config', ledger);

  const finish = stopReason => {
    markFresh(trials.filter(item => item.dispatched && item.terminal));
    for (const item of trials) {
      const failed = ledger.entries[item.key]?.failureReason;
      if (failed) { item.fresh = false; item.freshReason = failed; }
    }
    const aggregate = aggregateGates(trials);
    const complete = trialsPerRequest === 3 && config.corpusId === CORPUS_ID && fingerprint(canonicalCorpus(challenges)) === CORPUS_DIGEST;
    return {paidTrialsRan, freshTrials: aggregate.freshTrials, qualificationPassed: !stopReason && complete && aggregate.passed,
      reason: stopReason ?? (aggregate.passed && !complete ? 'incomplete-corpus' : aggregate.reason), trials, ledger, aggregate};
  };
  let campaign;
  let principals;
  const firstKey = trialKey(config.corpusId, challenges[0].id, 1);
  try {
    const blocked = await withLedgerLock(ledgerPath, async () => {
      await readLedger(ledgerPath, ledger);
      committedMicroUsd(ledger);
      if (ledger.campaign && (ledger.campaign.origin !== origin || ledger.campaign.corpusId !== config.corpusId || ledger.campaign.corpusDigest !== CORPUS_DIGEST)) return 'campaign-binding-changed';
      if (!ledger.campaign && Object.keys(ledger.entries).length > 0) return 'campaign-provenance-missing';
      if (ledger.campaign?.halted) return ledger.campaign.halted;
      if (ledger.campaign && ledger.campaign.version !== 2) return 'campaign-version-unsupported';
      if (ledger.campaign && (ledger.campaign.live !== (config.live === true) || ledger.campaign.model !== (config.live === true ? config.model : null))) return 'campaign-mode-changed';
      // Reject invalid prices/scope/caps before sending even a credential inspection request.
      const decision = dispatchDecision(ledger);
      if (!decision.ok && (decision.reason !== 'cap-exhausted' || !ledger.entries[firstKey])) return decision.reason;
      if (ledger.scope !== config.scope || ledger.capMicroUsd !== config.capMicroUsd || ledger.attemptPriceMicroUsd !== config.attemptPriceMicroUsd) return 'campaign-budget-changed';
      return null;
    });
    if (blocked) {
      trials.push({challengeId: challenges[0].id, trial: 1, key: firstKey, dispatched: false, fresh: false, reason: blocked, freshReason: blocked});
      return finish(blocked);
    }
    const startedAt = new Date(clock(config)).toISOString();
    principals = [];
    for (const key of keys) {
      const response = await transport(fetchImpl, `${origin}/v1/auth/keys/current`, {method: 'GET', headers: authHeaders(key)}, config);
      const owner = principal(response.value);
      if (principals.some(item => item.wallet === owner.wallet)) throw campaignError('duplicate-wallet-principals');
      principals.push(owner);
    }
    campaign = await withLedgerLock(ledgerPath, async () => {
      await readLedger(ledgerPath, ledger);
      const bound = bindCampaign(ledger, {config, origin, principals, startedAt});
      await persistLedger(ledgerPath, ledger);
      return bound;
    });
  } catch (error) { return finish(error.code ?? 'campaign-preflight-failed'); }

  const locked = callback => withLedgerLock(ledgerPath, async () => {
    await readLedger(ledgerPath, ledger);
    if (ledger.campaign?.id !== campaign.id) throw campaignError('campaign-binding-changed');
    if (ledger.campaign.halted) throw campaignError(ledger.campaign.halted);
    return callback();
  });
  for (const challenge of challenges) {
    for (let trial = 1; trial <= trialsPerRequest; trial += 1) {
      const key = trialKey(config.corpusId, challenge.id, trial);
      const apiKey = keys[trial - 1];
      const input = draftInput(challenge);
      const base = {challengeId: challenge.id, classification: challenge.classification, trial, key, inputKeys: Object.keys(input)};
      let outcome;
      const acceptView = async (view, {response = null, recovering = false} = {}) => {
        const entry = ledger.entries[key];
        validateTaskBinding(entry, view, config);
        if (response?.replayed && !recovering) throw campaignError('replayed-task');
        const traces = collectTraceIds(view);
        validateGlobalEvidence(ledger, key, entry, view, traces);
        entry.provenance.accepted = true;
        entry.provenance.taskCreatedAt = view.createdAt;
        if (response?.replayed) entry.replayed = true;
        applyTaskView(entry, view);
        if (TERMINAL.has(view.state)) {
          entry.traceIds = traces;
          entry.terminalFingerprint = fingerprint(view);
        }
        await persistLedger(ledgerPath, ledger);
        return entry;
      };
      try {
        outcome = await locked(async () => {
          const unresolved = Object.entries(ledger.entries).find(([otherKey, entry]) => otherKey !== key && entry.provenance?.dispatchStartedAt && !entry.terminalFingerprint);
          if (unresolved) return {blocked: 'unresolved-trial'};
          const reserved = await reserveTrial(ledgerPath, ledger, key);
          if (!reserved.ok) return {blocked: reserved.reason};
          const entry = ledger.entries[key];
          const provenance = bindTrial(entry, {campaign: ledger.campaign, owner: principals[trial - 1], input, challenge, trial});
          if (entry.taskId) return {method: 'GET', entry};
          const recovering = provenance.postAttempts > 0;
          if (ledger.campaign.lastDispatchAt !== null) {
            const remaining = Date.parse(ledger.campaign.lastDispatchAt) + minPostIntervalMs - clock(config);
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          }
          const dispatchAt = new Date(clock(config)).toISOString();
          provenance.dispatchStartedAt ??= dispatchAt;
          provenance.postAttempts += 1;
          ledger.campaign.lastDispatchAt = dispatchAt;
          await persistLedger(ledgerPath, ledger);
          paidTrialsRan = true;
          try {
            const response = await transport(fetchImpl, `${origin}/v1/tasks`, {method: 'POST', headers: authHeaders(apiKey, key), body: JSON.stringify({operation: 'draft', input})}, config);
            const view = parseTaskView(response.value);
            await acceptView(view, {response, recovering});
            return {method: 'POST', entry, view, status: response.status};
          } catch (error) {
            // Unknown outcomes retain the reservation and the original request key.
            if (['stale-task', 'invalid-task-time', 'task-binding-changed', 'task-result-changed', 'replayed-task', 'reused-task', 'reused-provider-trace', 'invalid-task'].includes(error.code)) failCampaign(ledger, entry, error.code);
            await persistLedger(ledgerPath, ledger);
            return {method: 'POST', entry, error};
          }
        });
      } catch (error) { outcome = {blocked: error.code ?? 'campaign-state-failed'}; }
      if (outcome.blocked) {
        trials.push({...base, dispatched: false, fresh: false, reason: outcome.blocked, freshReason: outcome.blocked});
        return finish(outcome.blocked);
      }
      if (outcome.error) {
        trials.push({...base, dispatched: true, method: outcome.method, state: 'uncertain', reason: outcome.error.code ?? 'network-error', message: publicError(outcome.error), repairCount: null, fresh: false, freshReason: outcome.error.code ?? 'not-terminal'});
        return finish(outcome.error.code ?? 'network-error');
      }
      let view = outcome.view ?? null;
      if (outcome.method === 'GET' || !TERMINAL.has(view.state)) {
        const deadline = performance.now() + pollDeadlineMs;
        for (let poll = 0; poll < maxPolls && (!view || !TERMINAL.has(view.state)) && performance.now() < deadline; poll++) {
          if (pollIntervalMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - performance.now()))));
          if (performance.now() >= deadline) break;
          try {
            const response = await transport(fetchImpl, `${origin}/v1/tasks/${encodeURIComponent(ledger.entries[key].taskId)}`, {method: 'GET', headers: authHeaders(apiKey)},
              {...config, timeoutMs: Math.max(1, Math.min(config.timeoutMs ?? 30_000, Math.floor(deadline - performance.now())))});
            view = parseTaskView(response.value);
            await locked(() => acceptView(view));
          } catch (error) {
            await withLedgerLock(ledgerPath, async () => {
              await readLedger(ledgerPath, ledger);
              if (['stale-task', 'invalid-task-time', 'task-binding-changed', 'task-result-changed', 'reused-task', 'reused-provider-trace', 'invalid-task'].includes(error.code)) failCampaign(ledger, ledger.entries[key], error.code);
              await persistLedger(ledgerPath, ledger);
            });
            trials.push({...base, dispatched: true, method: outcome.method, taskId: ledger.entries[key].taskId, state: 'uncertain', reason: error.code ?? 'network-error', message: publicError(error), fresh: false, freshReason: error.code ?? 'not-terminal'});
            return finish(error.code ?? 'network-error');
          }
        }
      }
      const entry = ledger.entries[key];
      if (!view || !TERMINAL.has(view.state)) {
        trials.push({...base, dispatched: true, method: outcome.method, taskId: entry.taskId, taskState: view?.state, fresh: false, freshReason: 'not-terminal'});
        return finish('polling-incomplete');
      }
      const repairCount = readRepairCount(view);
      const traceIds = collectTraceIds(view);
      const data = terminalData(view);
      const wrongLiveModel = config.live === true && (data?.qualification?.model !== config.model ||
        !Array.isArray(data?.attempts) || data.attempts.some(attempt => attempt?.model !== config.model));
      const qualification = qualificationMetadata(view);
      const missingLiveVersion = config.live === true && (!qualification.promptVersion || !qualification.catalogVersion);
      const metadataDependency = wrongLiveModel ? 'live-model-mismatch' : missingLiveVersion ? 'qualification-metadata-missing' : repairCount == null ? 'qualification-metadata-missing' : repairCount > 1 ? 'repair-limit' : traceIds.length === 0 ? 'provider-trace-missing' : null;
      let assessment = {engineValid: null, candidateResults: []};
      try {
        if (view.state === 'succeeded' && view.result?.kind === 'draft' && challenge.classification === 'supported') {
          assessment = config.assessImpl ? await config.assessImpl(challenge, view.result)
            : await assessSupportedDraft(challenge, view.result.revision?.plan);
        }
      } catch { return finish('assessment-failed'); }
      const score = scoreTrial({challenge, response: view.result, candidateResults: assessment.candidateResults ?? [], repairCount, cost: entry.cost,
        latencyMs: Number.isSafeInteger(view.result?.qualification?.latencyMs) ? view.result.qualification.latencyMs : null, live: config.live === true});
      const draftGates = scoreHostedDraftGates({challenge, response: view.result,
        engineValid: assessment.engineValid, candidateResults: assessment.candidateResults ?? []});
      trials.push({...base, dispatched: true, method: outcome.method, state: entry.state, taskState: view.state, taskId: entry.taskId, attempt: entry.attempt,
        statusCode: outcome.status ?? null, replayed: entry.replayed === true, provenanceAccepted: entry.provenance.accepted,
        terminal: true, repairCount, traceIds, qualification, artifacts: artifactPair(view), cost: entry.cost,
        actualCostMicroUsd: entry.costSource === 'actual-ticks' ? entry.costMicroUsd : null, costInUsdTicks: entry.costInUsdTicks,
        tariffMicroUsd: entry.tariffMicroUsd, metadataDependency, engineValid: assessment.engineValid, score, draftGates, fresh: false});
      if (metadataDependency) {
        await locked(async () => { failCampaign(ledger, ledger.entries[key], metadataDependency); await persistLedger(ledgerPath, ledger); });
        return finish(metadataDependency);
      }
    }
  }
  return finish(null);
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
  console.log(JSON.stringify({
    paidTrialsRan: result.paidTrialsRan,
    freshTrials: result.freshTrials,
    qualificationPassed: result.qualificationPassed,
    reason: result.reason,
    trials: result.trials,
  }));
}
