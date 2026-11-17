import {createHash, randomUUID} from 'node:crypto';
import {CORPUS_DIGEST} from './corpus.mjs';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function campaignError(code) { return Object.assign(new Error(code), {code}); }
export function clock(config) {
  const now = config.now ? config.now() : Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw campaignError('invalid-clock');
  return now;
}
export function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
export function principal(value) {
  if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
      typeof value.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.wallet) ||
      !Array.isArray(value.scopes) || !value.scopes.includes('buyer') || timestamp(value.createdAt) === null) {
    throw campaignError('invalid-principal');
  }
  return {id: value.id, wallet: value.wallet.toLowerCase()};
}
export function bindCampaign(ledger, {config, origin, principals, startedAt}) {
  if (!ledger.campaign) {
    if (Object.keys(ledger.entries).length > 0) throw campaignError('campaign-provenance-missing');
    ledger.campaign = {version: 1, id: randomUUID(), startedAt, origin, corpusId: config.corpusId,
      corpusDigest: CORPUS_DIGEST, principals, halted: null, lastDispatchAt: null};
  }
  const stored = ledger.campaign;
  if (stored.version !== 1 || typeof stored.id !== 'string' || !/^[a-f0-9-]{36}$/.test(stored.id) || timestamp(stored.startedAt) === null ||
      stored.origin !== origin || stored.corpusId !== config.corpusId || stored.corpusDigest !== CORPUS_DIGEST) {
    throw campaignError('campaign-binding-changed');
  }
  if (JSON.stringify(stored.principals) !== JSON.stringify(principals)) throw campaignError('campaign-principals-changed');
  if (stored.startedAt > new Date(clock(config)).toISOString()) throw campaignError('campaign-clock-moved-backwards');
  if (stored.halted) throw campaignError(stored.halted);
  return stored;
}
export function bindTrial(entry, {campaign, owner, input, challenge, trial}) {
  const binding = {campaignId: campaign.id, principal: owner, inputHash: fingerprint(input), challengeId: challenge.id, classification: challenge.classification, trial};
  if (!entry.provenance) {
    if (entry.taskId || entry.attempt !== null) throw campaignError('campaign-provenance-missing');
    entry.provenance = {...binding, dispatchStartedAt: null, postAttempts: 0, accepted: false, taskCreatedAt: null};
  }
  for (const [key, value] of Object.entries(binding)) {
    if (JSON.stringify(entry.provenance[key]) !== JSON.stringify(value)) throw campaignError('campaign-input-changed');
  }
  return entry.provenance;
}
export function validateTaskBinding(entry, view, config) {
  const created = timestamp(view.createdAt), updated = timestamp(view.updatedAt);
  const started = timestamp(entry.provenance.dispatchStartedAt);
  if (created === null || updated === null || started === null || updated < created || updated > clock(config) + 5_000) {
    throw campaignError('invalid-task-time');
  }
  if (created < started) throw campaignError('stale-task');
  if (view.operation !== 'draft' || (entry.taskId && view.id !== entry.taskId) ||
      (entry.provenance.taskCreatedAt && entry.provenance.taskCreatedAt !== view.createdAt) ||
      (entry.attempt !== null && view.attempt < entry.attempt)) throw campaignError('task-binding-changed');
  if (entry.terminalFingerprint && entry.terminalFingerprint !== fingerprint(view)) throw campaignError('task-result-changed');
}
export function failCampaign(ledger, entry, reason) {
  entry.failureReason = reason;
  ledger.campaign.halted = reason;
}
export function validateGlobalEvidence(ledger, key, entry, view, traceIds) {
  for (const [otherKey, other] of Object.entries(ledger.entries)) {
    if (otherKey === key) continue;
    let reason = null;
    if (other.taskId === view.id) reason = 'reused-task';
    else if (traceIds.some(id => (other.traceIds ?? []).includes(id))) reason = 'reused-provider-trace';
    if (reason) {
      other.failureReason = reason;
      failCampaign(ledger, entry, reason);
      throw campaignError(reason);
    }
  }
}
