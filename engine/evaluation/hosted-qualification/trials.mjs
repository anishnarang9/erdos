import {pathToFileURL} from 'node:url';
import {CORPUS_ID} from './corpus.mjs';
import {assessSupportedDraft} from './assess.mjs';
import {scoreTrial} from './score.mjs';
import {applyTaskView, newLedger, persistLedger, readLedger, reserveTrial, withLedgerLock} from './budget.mjs';

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
    dispatch: false,
    live: false,
  };
}

export function trialKey(corpusId, challengeId, trial) {
  return `qual-${corpusId}-${challengeId}-trial-${trial}`;
}

export function draftInput(challenge) {
  return {
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

export function readRepairCount(view) {
  const value = view?.result?.qualification?.repairCount;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function collectTraceIds(view) {
  const ids = [];
  const qualification = view?.result?.qualification;
  if (typeof qualification?.traceId === 'string' && qualification.traceId) ids.push(qualification.traceId);
  if (Array.isArray(qualification?.traceIds)) {
    for (const id of qualification.traceIds) {
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  if (Array.isArray(view?.result?.attempts)) {
    for (const item of view.result.attempts) {
      if (typeof item?.traceId === 'string' && item.traceId) ids.push(item.traceId);
    }
  }
  return ids;
}

function artifactPair(view) {
  const usage = Array.isArray(view?.result?.qualification?.usage) ? view.result.qualification.usage : [];
  const attempts = Array.isArray(view?.result?.attempts) ? view.result.attempts : [];
  const initialUsage = attempts[0]?.usage ?? usage[0] ?? null;
  const repairUsage = attempts[1]?.usage ?? usage[1] ?? null;
  return {
    initial: {traceId: attempts[0]?.traceId ?? null, usage: initialUsage},
    repair: attempts[1] || usage[1] ? {traceId: attempts[1]?.traceId ?? null, usage: repairUsage} : null,
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
    else if (item.method !== 'POST') reason = 'cached-task';
    else if (item.replayed) reason = 'replayed-task';
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

export function aggregateGates(trials) {
  const dispatched = trials.filter((item) => item.dispatched);
  const fresh = dispatched.filter((item) => item.fresh);
  const closed = {passed: false, freshTrials: fresh.length, fundingApproval: false, meanCostMicroUsd: null, semanticRate: null};
  if (fresh.length === 0 || fresh.length !== dispatched.length) {
    return {...closed, reason: fresh.length === 0 ? 'no-fresh-trials' : 'incomplete-trial'};
  }
  if (fresh.some((item) => item.score?.live !== true)) return {...closed, reason: 'not-live'};
  if (fresh.some((item) => item.repairCount > 1)) return {...closed, reason: 'repair-limit'};
  const supported = fresh.filter((item) => item.classification === 'supported');
  const agreed = supported.filter((item) => item.score?.semanticAgreement === true && item.engineValid === true
    && Number.isSafeInteger(item.repairCount) && item.repairCount <= 1);
  const semanticRate = supported.length === 0 ? 0 : agreed.length / supported.length;
  const falseAccepts = supported.reduce((total, item) => total + (item.score?.falseAccepts ?? 0), 0);
  const malformedAccepts = supported.reduce((total, item) => total + (item.score?.malformedAccepts ?? 0), 0);
  const quotes = fresh.every((item) => item.score?.quoteFidelity === true);
  const ambiguousOk = fresh.filter((item) => item.classification === 'ambiguous').every((item) => item.score?.inventedConditions === 0);
  const unsupportedOk = fresh.filter((item) => item.classification === 'unsupported')
    .every((item) => item.score?.weakerPayableJob === false && item.score?.unsupportedExplanation === true);
  const costs = fresh.map((item) => item.actualCostMicroUsd);
  const costsKnown = costs.every((item) => Number.isSafeInteger(item));
  const meanCostMicroUsd = costsKnown && costs.length > 0 ? costs.reduce((total, item) => total + item, 0) / costs.length : null;
  const passed = supported.length > 0 && semanticRate >= 0.95 && falseAccepts === 0 && malformedAccepts === 0
    && quotes && ambiguousOk && unsupportedOk && meanCostMicroUsd != null && meanCostMicroUsd < 100_000;
  return {
    passed,
    reason: passed ? null : 'gate-failed',
    freshTrials: fresh.length,
    fundingApproval: false,
    semanticRate,
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
  if (trialsPerRequest === 0) return closedResult('no-trials', config.ledger ?? null);
  const origin = checkOrigin(config.baseUrl).origin;
  const keys = principalKeys(config, trialsPerRequest).keys;
  const ledger = config.ledger ?? newLedger(config);
  const trials = [];
  let paidTrialsRan = false;

  const finish = (stopReason) => {
    const aggregate = aggregateGates(trials);
    return {
      paidTrialsRan,
      freshTrials: aggregate.freshTrials,
      qualificationPassed: aggregate.passed,
      reason: stopReason ?? aggregate.reason,
      trials,
      ledger,
      aggregate,
    };
  };

  for (const challenge of challenges) {
    const group = [];
    let stopReason = null;
    for (let trial = 1; trial <= trialsPerRequest; trial += 1) {
      const key = trialKey(config.corpusId, challenge.id, trial);
      const apiKey = keys[trial - 1];
      const input = draftInput(challenge);
      const outcome = await withLedgerLock(ledgerPath, async () => {
        await readLedger(ledgerPath, ledger);
        const reserved = await reserveTrial(ledgerPath, ledger, key);
        if (!reserved.ok) return {blocked: reserved.reason};
        const entry = ledger.entries[key];
        if (entry.taskId) return {entry, method: 'GET'};
        try {
          const response = await transport(fetchImpl, `${origin}/v1/tasks`, {
            method: 'POST',
            headers: authHeaders(apiKey, key),
            body: JSON.stringify({operation: 'draft', input}),
          }, config);
          paidTrialsRan = true;
          const view = parseTaskView(response.value);
          if (response.replayed) entry.replayed = true;
          applyTaskView(entry, view);
          await persistLedger(ledgerPath, ledger);
          return {entry, method: 'POST', view, status: response.status, replayed: response.replayed};
        } catch (error) {
          entry.state = 'reserved';
          paidTrialsRan = true;
          await persistLedger(ledgerPath, ledger);
          return {entry, method: 'POST', error};
        }
      });
      if (outcome.blocked) {
        group.push({
          challengeId: challenge.id,
          classification: challenge.classification,
          trial,
          key,
          dispatched: false,
          reason: outcome.blocked,
          fresh: false,
          freshReason: outcome.blocked,
        });
        stopReason = outcome.blocked;
        break;
      }
      if (outcome.error) {
        group.push({
          challengeId: challenge.id,
          classification: challenge.classification,
          trial,
          key,
          dispatched: true,
          method: outcome.method,
          state: 'uncertain',
          reason: outcome.error.code || 'network-error',
          message: publicError(outcome.error),
          repairCount: null,
          cost: null,
          fresh: false,
          freshReason: 'not-terminal',
          inputKeys: Object.keys(input),
        });
        continue;
      }
      let view = outcome.view ?? null;
      const method = outcome.method;
      if (method === 'GET' || (view && !TERMINAL.has(view.state))) {
        const maxPolls = config.maxPolls ?? 5;
        for (let poll = 0; poll < maxPolls && (!view || !TERMINAL.has(view.state)); poll += 1) {
          if (config.pollIntervalMs) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
          try {
            const response = await transport(fetchImpl, `${origin}/v1/tasks/${encodeURIComponent(outcome.entry.taskId)}`, {
              method: 'GET',
              headers: authHeaders(apiKey),
            }, config);
            view = parseTaskView(response.value);
            await withLedgerLock(ledgerPath, async () => {
              applyTaskView(outcome.entry, view);
              await persistLedger(ledgerPath, ledger);
            });
          } catch (error) {
            group.push({
              challengeId: challenge.id,
              classification: challenge.classification,
              trial,
              key,
              dispatched: true,
              method,
              state: 'uncertain',
              taskId: outcome.entry.taskId,
              reason: error.code || 'network-error',
              message: publicError(error),
              repairCount: null,
              fresh: false,
              freshReason: 'not-terminal',
              inputKeys: Object.keys(input),
            });
            view = null;
            break;
          }
        }
      }
      if (!view) continue;
      const repairCount = readRepairCount(view);
      const traceIds = collectTraceIds(view);
      const metadataDependency = repairCount == null
        ? 'qualification-metadata-missing'
        : traceIds.length === 0 ? 'provider-trace-missing' : null;
      let assessment = {engineValid: null, candidateResults: []};
      if (view.state === 'succeeded' && view.result?.kind === 'draft' && challenge.classification === 'supported') {
        assessment = config.assessImpl
          ? await config.assessImpl(challenge, view.result)
          : await assessSupportedDraft(challenge, view.result.plan);
      }
      const score = scoreTrial({
        challenge,
        response: view.result,
        candidateResults: assessment.candidateResults ?? [],
        repairCount,
        cost: outcome.entry.cost,
        latencyMs: Number.isSafeInteger(view.result?.qualification?.latencyMs) ? view.result.qualification.latencyMs : null,
        live: config.live === true,
      });
      group.push({
        challengeId: challenge.id,
        classification: challenge.classification,
        trial,
        key,
        dispatched: true,
        method,
        state: outcome.entry.state,
        taskState: view.state,
        taskId: outcome.entry.taskId,
        attempt: outcome.entry.attempt,
        statusCode: outcome.status ?? null,
        replayed: outcome.entry.replayed === true,
        terminal: TERMINAL.has(view.state),
        repairCount,
        traceIds,
        artifacts: artifactPair(view),
        cost: outcome.entry.cost,
        actualCostMicroUsd: outcome.entry.costSource === 'actual-ticks' ? outcome.entry.costMicroUsd : null,
        costInUsdTicks: outcome.entry.costInUsdTicks,
        tariffMicroUsd: outcome.entry.tariffMicroUsd,
        metadataDependency,
        engineValid: assessment.engineValid,
        score,
        fresh: false,
        inputKeys: Object.keys(input),
      });
    }
    markFresh(group.filter((item) => item.dispatched && item.terminal));
    trials.push(...group);
    if (stopReason) return finish(stopReason);
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
