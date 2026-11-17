import {chmod, open, rename} from 'node:fs/promises';

export function reservationFor(attemptPriceMicroUsd) {
  if (!Number.isSafeInteger(attemptPriceMicroUsd) || attemptPriceMicroUsd <= 0) return null;
  const reservation = attemptPriceMicroUsd * 2;
  return Number.isSafeInteger(reservation) ? reservation : null;
}

export function committedMicroUsd(ledger) {
  return Object.values(ledger.entries).reduce((total, entry) => {
    if (entry.state === 'reconciled' && Number.isSafeInteger(entry.costMicroUsd)) return total + entry.costMicroUsd;
    return total + entry.reservedMicroUsd;
  }, 0);
}

export function newLedger({scope, capMicroUsd, attemptPriceMicroUsd}) {
  return {scope, capMicroUsd, attemptPriceMicroUsd, entries: {}};
}

export function dispatchDecision(ledger) {
  if (ledger.scope !== 'benchmark') return {ok: false, reason: 'scope'};
  const reservation = reservationFor(ledger.attemptPriceMicroUsd);
  if (reservation == null) return {ok: false, reason: 'unknown-price'};
  if (!Number.isSafeInteger(ledger.capMicroUsd) || ledger.capMicroUsd < 0) return {ok: false, reason: 'cap'};
  if (committedMicroUsd(ledger) + reservation > ledger.capMicroUsd) return {ok: false, reason: 'cap-exhausted'};
  return {ok: true, reservationMicroUsd: reservation};
}

export async function persistLedger(path, ledger) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function reserveTrial(path, ledger, key) {
  if (ledger.entries[key]) return {ok: true, existing: true, reservationMicroUsd: ledger.entries[key].reservedMicroUsd};
  const decision = dispatchDecision(ledger);
  if (!decision.ok) return decision;
  ledger.entries[key] = {
    state: 'reserved',
    reservedMicroUsd: decision.reservationMicroUsd,
    taskId: null,
    attempt: null,
    costMicroUsd: null,
    cost: null,
  };
  await persistLedger(path, ledger);
  return {ok: true, existing: false, reservationMicroUsd: decision.reservationMicroUsd};
}

export function applyTaskView(entry, view) {
  entry.taskId = view?.id ?? entry.taskId;
  entry.attempt = Number.isSafeInteger(view?.attempt) ? view.attempt : entry.attempt;
  if (view?.state === 'succeeded' || view?.state === 'failed') {
    if (Number.isSafeInteger(view.costMicroUsd)) {
      entry.state = 'reconciled';
      entry.costMicroUsd = view.costMicroUsd;
      entry.cost = view.costMicroUsd;
      return;
    }
    entry.state = 'spent';
    entry.costMicroUsd = entry.reservedMicroUsd;
    entry.cost = 'unreported';
    return;
  }
  entry.state = 'reserved';
}
