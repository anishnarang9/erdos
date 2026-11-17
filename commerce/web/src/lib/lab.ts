// SIMULATION ONLY (product-plan.md §G): a local sample fixture and an illustrative checker. It has no API client,
// no chain client and no signer, so nothing here can create a proof or move money. Labels say so on screen.
// The three checks mirror the demo job's approved rules (exact ids, exact amounts and total, nonempty report).

export interface Row { id: string; amountCents: number }
export interface Delivery { key: string; label: string; rows: Row[]; report: string }

export const LEDGER: Row[] = [
  { id: "invoice-a", amountCents: 1000 },
  { id: "invoice-b", amountCents: 2000 },
];

export const DELIVERIES: Delivery[] = [
  { key: "correct", label: "Correct amounts", rows: LEDGER.map((r) => ({ ...r })), report: "Reconciled 2 invoices. Total 3,000¢." },
  { key: "one-cent", label: "One cent changed", rows: [{ id: "invoice-a", amountCents: 1000 }, { id: "invoice-b", amountCents: 2001 }], report: "Reconciled 2 invoices. Total 3,001¢." },
  { key: "missing", label: "Missing invoice", rows: [{ id: "invoice-a", amountCents: 1000 }], report: "Reconciled 1 invoice." },
  { key: "empty-report", label: "Empty report", rows: LEDGER.map((r) => ({ ...r })), report: "" },
];

export type CheckResult = "pass" | "fail";
export interface Check { key: string; label: string; result: CheckResult; detail: string }

const total = (rows: Row[]) => rows.reduce((s, r) => s + r.amountCents, 0);

export function runChecks(d: Delivery, ledger: Row[] = LEDGER): Check[] {
  const want = ledger.map((r) => r.id).sort();
  const got = d.rows.map((r) => r.id).sort();
  const unique = new Set(got).size === got.length;
  const idsOk = unique && want.length === got.length && want.every((id, i) => id === got[i]);
  const byId = new Map(d.rows.map((r) => [r.id, r.amountCents]));
  const wrong = ledger.filter((r) => byId.get(r.id) !== r.amountCents).map((r) => r.id);
  const amountsOk = idsOk && wrong.length === 0 && total(d.rows) === total(ledger);
  const reportOk = new TextEncoder().encode(d.report).length > 0;
  return [
    { key: "ids", label: "Exact record IDs", result: idsOk ? "pass" : "fail", detail: idsOk ? `${got.length} of ${want.length} ids, no duplicates` : `expected ${want.join(", ")}; got ${got.join(", ") || "none"}` },
    {
      key: "amounts",
      label: "Exact amounts and total",
      result: amountsOk ? "pass" : "fail",
      detail: amountsOk ? `total ${total(d.rows).toLocaleString("en-US")}¢` : wrong.length ? `${wrong.join(", ")} differs from the ledger` : `total ${total(d.rows)}¢ ≠ ${total(ledger)}¢`,
    },
    { key: "report", label: "Report present, size > 0", result: reportOk ? "pass" : "fail", detail: reportOk ? "report.txt is nonempty" : "report.txt is empty" },
  ];
}

export const allPass = (checks: Check[]) => checks.every((c) => c.result === "pass");
