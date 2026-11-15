// The two recorded Grok requests (scripts/record-grok.ts) replayed by grok-replay.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ledger = readFileSync(fileURLToPath(new URL("./fixtures/reconciliation/reference/ledger.json", import.meta.url)));

export const CASES: Record<string, { expect: "draft" | "capability_unsupported"; answer?: string; body: Record<string, unknown> }> = {
  // Success: a reconciliation job the engine supports (collections, sum, count, lookup, unique).
  reconciliation: {
    expect: "draft",
    answer: "Amounts are integer cents as decimal strings. Every ledger id must appear exactly once. No extra rows.",
    body: {
      request:
        "Reconcile our invoice ledger. Deliver result.json with a `rows` array of { id, amountCents } that contains " +
        "exactly the invoices in ledger.json: same ids, no duplicates, and each amount equal to the ledger amount, " +
        "so the totals match. Also deliver report.txt, a short plain-text note.",
      outputs: [
        { name: "result.json", format: "json" },
        { name: "report.txt", format: "text" },
      ],
      references: [{ name: "ledger.json", contentBase64: ledger.toString("base64") }],
      expirySeconds: 3600,
      maxBudget: "5000000",
    },
  },
  // Unsupported: needs a regular-expression match, which the engine catalog does not have.
  regexEmails: {
    expect: "capability_unsupported",
    answer: "Use the regular expression ^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$ on every email field.",
    body: {
      request:
        "Clean our contact list. Deliver contacts.json with a `rows` array of { name, email }. Every email must match " +
        "the regular expression ^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$ and the list must have at least 10 rows.",
      outputs: [{ name: "contacts.json", format: "json" }],
      expirySeconds: 3600,
      maxBudget: "2000000",
    },
  },
};
