import {chmod, open, readFile, rename, unlink} from 'node:fs/promises';

export const TICKS_PER_USD = 10_000_000_000;
export const TICKS_PER_MICRO_USD = TICKS_PER_USD / 1_000_000;

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

export async function readLedger(path, fallback) {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    if (!stored || typeof stored !== 'object' || !stored.entries) return fallback;
    fallback.scope = stored.scope;
    fallback.capMicroUsd = stored.capMicroUsd;
    fallback.attemptPriceMicroUsd = stored.attemptPriceMicroUsd;
    fallback.entries = stored.entries;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return fallback;
}

const chains = new Map();

async function acquireFileLock(lockPath) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({pid: process.pid})}\n`);
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(lockPath, 'utf8')).pid;
      } catch {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (owner !== process.pid) {
        try {
          process.kill(owner, 0);
        } catch {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw Object.assign(new Error('ledger-lock-timeout'), {code: 'ledger-lock-timeout'});
}

export async function withLedgerLock(path, fn) {
  const previous = chains.get(path) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  chains.set(path, gate);
  try {
    await previous;
    const handle = await acquireFileLock(`${path}.lock`);
    try {
      return await fn();
    } finally {
      await handle.close();
      await unlink(`${path}.lock`).catch(() => {});
    }
  } finally {
    release();
  }
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
    costInUsdTicks: null,
    tariffMicroUsd: null,
    costSource: null,
    replayed: false,
  };
  await persistLedger(path, ledger);
  return {ok: true, existing: false, reservationMicroUsd: decision.reservationMicroUsd};
}

export function readAttemptTicks(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const ticks = Object.hasOwn(usage, 'cost_in_usd_ticks') ? usage.cost_in_usd_ticks : usage.costInUsdTicks;
  if (!Number.isSafeInteger(ticks) || ticks < 0) return null;
  return ticks;
}

export function sumAttemptTicks(usage) {
  if (!Array.isArray(usage) || usage.length === 0) return null;
  let total = 0;
  for (const item of usage) {
    const ticks = readAttemptTicks(item);
    if (ticks == null) return null;
    total += ticks;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function actualMicroUsdFromTicks(ticks) {
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks % TICKS_PER_MICRO_USD !== 0) return null;
  const microUsd = ticks / TICKS_PER_MICRO_USD;
  return Number.isSafeInteger(microUsd) ? microUsd : null;
}

export function applyTaskView(entry, view) {
  if (typeof view?.id === 'string' && view.id) entry.taskId = view.id;
  if (Number.isSafeInteger(view?.attempt) && view.attempt >= 0) entry.attempt = view.attempt;
  const tariff = view?.result?.billing?.microUsd;
  if (Number.isSafeInteger(tariff) && tariff >= 0) entry.tariffMicroUsd = tariff;
  const ticks = sumAttemptTicks(view?.result?.qualification?.usage);
  if (ticks != null) entry.costInUsdTicks = ticks;
  const terminal = view?.state === 'succeeded' || view?.state === 'failed' || view?.state === 'uncertain';
  if (!terminal) {
    entry.state = 'reserved';
    return;
  }
  const actual = actualMicroUsdFromTicks(entry.costInUsdTicks);
  if (view.state === 'uncertain' || actual == null) {
    entry.cost = 'unreported';
    entry.costSource = null;
    if (view.state === 'uncertain') {
      entry.state = 'reserved';
      return;
    }
    entry.state = 'spent';
    entry.costMicroUsd = entry.reservedMicroUsd;
    return;
  }
  entry.state = 'reconciled';
  entry.costMicroUsd = actual;
  entry.cost = actual;
  entry.costSource = 'actual-ticks';
}
