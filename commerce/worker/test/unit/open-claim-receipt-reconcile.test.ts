import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { observedReceiptWithJournal } from "../../src/open-claim/receipt-reconcile.ts";

const hash = `0x${"ab".repeat(32)}` as Hex;
const confirmed = { status: "success" as const };

describe("open-claim receipt and local journal reconciliation", () => {
  it("returns a confirmed release receipt when its saved release journal cannot reconcile", async () => {
    const receipt = vi.fn(async () => confirmed);
    const reconcile = vi.fn(async () => { throw new Error("transient journal RPC failure"); });
    const result = await observedReceiptWithJournal(hash, receipt, reconcile, h => h === hash);
    expect(result).toEqual({ receipt: confirmed, releaseJournalUncertain: true });
    expect(receipt).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("keeps claim reconciliation fail-closed before a release", async () => {
    const error = new Error("claim journal uncertain");
    await expect(observedReceiptWithJournal(hash, async () => confirmed,
      async () => { throw error; }, () => false)).rejects.toBe(error);
  });

  it("does not reconcile an absent receipt", async () => {
    const reconcile = vi.fn(async () => undefined);
    expect(await observedReceiptWithJournal(hash, async () => null, reconcile, () => true))
      .toEqual({ receipt: null, releaseJournalUncertain: false });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("returns a confirmed receipt with a clean journal when reconciliation succeeds", async () => {
    expect(await observedReceiptWithJournal(hash, async () => confirmed, async () => undefined, () => true))
      .toEqual({ receipt: confirmed, releaseJournalUncertain: false });
  });
});
