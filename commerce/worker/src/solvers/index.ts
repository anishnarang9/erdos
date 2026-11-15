// Solver plug-ins: each turns a job's references into deliverable files. The worker proves whatever they return;
// the checker, not the solver, decides the verdict.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BundleFile } from "@ubc26/sdk";

export interface SolveInput {
  plan: unknown;
  references: BundleFile[];
}

export interface Solver {
  name: string;
  solve(input: SolveInput): Promise<BundleFile[]>;
}

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

/**
 * Reconciliation (engine/fixtures/reconciliation): copy every ledger row into result.json and write a short
 * report.txt. `tamper` adds one cent to the first row, which a correct checker must reject.
 */
export function reconciliationSolver(opts: { tamper?: boolean } = {}): Solver {
  return {
    name: opts.tamper ? "reconciliation-tampered" : "reconciliation",
    async solve({ references }) {
      const ledgerFile = references.find((f) => f.name === "ledger.json");
      if (!ledgerFile) throw new Error("reconciliation solver needs reference ledger.json");
      const ledger = JSON.parse(Buffer.from(ledgerFile.content).toString("utf8")) as { rows: { id: string; amountCents: string }[] };
      const rows = ledger.rows.map((r) => ({ id: r.id, amountCents: r.amountCents }));
      if (opts.tamper && rows[0]) rows[0].amountCents = (BigInt(rows[0].amountCents) + 1n).toString();
      return [
        { name: "result.json", content: utf8(JSON.stringify({ rows }, null, 2) + "\n") },
        { name: "report.txt", content: utf8(`Reconciled ${rows.length} invoices.\n`) },
      ];
    },
  };
}

/** Uses the files of a local directory as the deliverables (for hand-made or Grok-written outputs). */
export function filesSolver(dir: string): Solver {
  return {
    name: `files:${dir}`,
    async solve() {
      return readdirSync(dir)
        .sort()
        .map((name) => ({ name, content: new Uint8Array(readFileSync(join(dir, name))) }));
    },
  };
}
