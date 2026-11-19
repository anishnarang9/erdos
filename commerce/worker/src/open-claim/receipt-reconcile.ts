import { setTimeout as pause } from "node:timers/promises";
import type { Hex } from "viem";

/** A confirmed release can establish payment even when local gas accounting needs repair.
 * Claim accounting stays fail-closed because a release send may still follow it.
 */
export async function observedReceiptWithJournal<T>(hash: Hex,
  receipt: (hash: Hex) => Promise<T | null>, reconcile: (hash: Hex) => Promise<unknown>,
  isSavedRelease: (hash: Hex) => boolean,
  wait?: { delaysMs: readonly number[]; pause?: (ms: number) => Promise<void> }): Promise<{ receipt: T | null; releaseJournalUncertain: boolean }> {
  let observed = await receipt(hash);
  for (const delayMs of wait?.delaysMs ?? []) {
    if (observed !== null) break;
    await (wait?.pause ?? pause)(delayMs);
    observed = await receipt(hash);
  }
  if (observed === null) return { receipt: null, releaseJournalUncertain: false };
  try { await reconcile(hash); }
  catch (error) {
    if (!isSavedRelease(hash)) throw error;
    return { receipt: observed, releaseJournalUncertain: true };
  }
  return { receipt: observed, releaseJournalUncertain: false };
}
