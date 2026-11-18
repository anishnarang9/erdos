// Step 1: the buyer's plain-English request, its declared outputs and reference file, sent to Grok + the engine.
import { motion } from "motion/react";
import { useState } from "react";
import { actions } from "../lib/live";
import { SAMPLE_LEDGER, SAMPLE_OUTPUTS, SAMPLE_REQUEST, toBase64 } from "../lib/sample";
import { useDemo } from "../lib/store";

export function RequestCard() {
  const drafting = useDemo((s) => s.drafting);
  const draft = useDemo((s) => s.draft);
  const [request, setRequest] = useState(SAMPLE_REQUEST);
  const [ledger, setLedger] = useState(SAMPLE_LEDGER);
  const [minutes, setMinutes] = useState(45);
  const [maxBudget, setMaxBudget] = useState("0.05");

  const submit = () =>
    actions.draft({
      request,
      outputs: SAMPLE_OUTPUTS,
      references: [{ name: "ledger.json", contentBase64: toBase64(ledger) }],
      expirySeconds: minutes * 60,
      maxBudget: String(Math.round(Number(maxBudget) * 1_000_000)),
    });

  return (
    <motion.section className="card" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} aria-labelledby="req-title">
      <h2 id="req-title">Describe the job</h2>
      <p className="dim" style={{ marginTop: 4 }}>In plain English. Grok drafts the rules; the engine checks them.</p>
      <label htmlFor="req">Request</label>
      <textarea id="req" value={request} onChange={(e) => setRequest(e.target.value)} rows={5} disabled={drafting} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <div>
          <label htmlFor="exp">Deadline (minutes)</label>
          <input id="exp" type="number" min={15} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor="budget">Max budget (USDC)</label>
          <input id="budget" inputMode="decimal" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
        </div>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary className="dim" style={{ cursor: "pointer" }}>
          Reference file <span className="mono">ledger.json</span> · deliverables <span className="mono">result.json</span>, <span className="mono">report.txt</span>
        </summary>
        <textarea aria-label="ledger.json" className="mono" value={ledger} onChange={(e) => setLedger(e.target.value)} rows={8} style={{ marginTop: 8, fontSize: 13 }} />
      </details>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <button onClick={submit} disabled={drafting || request.trim() === ""}>
          {drafting ? "Drafting…" : draft ? "Redraft" : "Draft rules"}
        </button>
        {drafting && (
          <span className="badge locked" role="status">
            ◌ Grok drafting · engine validating
          </span>
        )}
      </div>
    </motion.section>
  );
}
