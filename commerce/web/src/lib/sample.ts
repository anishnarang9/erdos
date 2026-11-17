// The demo's sample inputs: Anish's reconciliation ledger (engine/fixtures/reconciliation/reference/ledger.json)
// and the request that produced the recorded grok-4.7 draft (commerce/api/test/integration/grok-cases.ts).
export const SAMPLE_LEDGER = `{
  "rows": [
    {
      "id": "invoice-a",
      "amountCents": "1000"
    },
    {
      "id": "invoice-b",
      "amountCents": "2000"
    }
  ]
}
`;

export const SAMPLE_REQUEST =
  "Reconcile our invoice ledger. Deliver result.json with a `rows` array of { id, amountCents } that contains " +
  "exactly the invoices in ledger.json: same ids, no duplicates, and each amount equal to the ledger amount, " +
  "so the totals match. Also deliver report.txt, a short plain-text note.";

export const SAMPLE_OUTPUTS = [
  { name: "result.json", format: "json" as const },
  { name: "report.txt", format: "text" as const },
];

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
