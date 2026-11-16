// Steps 3–4: compile, quotes from solver agents, and funding the escrow (demo signer or the buyer's wallet).
import { AnimatePresence, motion } from "motion/react";
import { formatUsdc } from "../lib/chain";
import { actions } from "../lib/live";
import { stageOf, useDemo } from "../lib/store";
import { Hash } from "./Hash";

const STEP_COPY: Record<string, string> = {
  createJob: "Create job on Arc",
  setBudget: "Set budget",
  approve: "Approve USDC (exactly the budget)",
  fund: "Fund escrow · terms frozen",
  link: "API verified the on-chain terms",
};

export function FundCard() {
  const stage = useDemo(stageOf);
  const job = useDemo((s) => s.job);
  const quotes = useDemo((s) => s.quotes);
  const fundOp = useDemo((s) => s.fundOp);
  const signer = useDemo((s) => s.signer);
  if (!job) return null;

  return (
    <motion.section className="card" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Fund the job</h2>
        {job.manifest ? <span className="badge verified">✓ compiled</span> : <span className="badge locked">◌ compiling guest</span>}
      </div>
      {job.manifest && <div style={{ marginTop: 8 }}><Hash label="imageId" value={job.manifest.imageId} /></div>}

      {stage === "quoting" && (
        <div style={{ marginTop: 16 }}>
          <div className="panel-title">Quotes from solver agents</div>
          {quotes.length === 0 && <p className="dim" role="status">Waiting for a solver to quote…</p>}
          <AnimatePresence>
            {quotes.map((q) => (
              <motion.div key={q.quoteId} layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                <span className="badge money">{formatUsdc(q.price)}</span>
                <Hash label="solver" value={q.provider} />
                <span className="spacer" />
                <button disabled={!q.selectable} onClick={() => void actions.selectQuote(q.quoteId)}>Select</button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {(stage === "selected" || fundOp) && (
        <div style={{ marginTop: 16 }}>
          <div className="panel-title">Escrow funding · {signer === "demo" ? "demo signer · testnet" : "your wallet"}</div>
          <ol style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 6 }}>
            {["createJob", "setBudget", "approve", "fund", "link"].map((label, i) => {
              const s = fundOp?.steps.find((x) => x.label === label);
              const state = s?.status ?? "todo";
              return (
                <motion.li key={label} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.06 }}
                  style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`badge ${state === "confirmed" || state === "skipped" ? "verified" : state === "pending" ? "locked" : "neutral"}`} style={{ minWidth: 92, justifyContent: "center" }}>
                    {state === "confirmed" ? "✓ done" : state === "skipped" ? "– skip" : state === "pending" ? "◌ sending" : "· queued"}
                  </span>
                  <span>{STEP_COPY[label]}</span>
                  {s?.txHash && label !== "link" && <Hash value={s.txHash} tx />}
                </motion.li>
              );
            })}
          </ol>
          {fundOp?.status === "failed" && <p className="badge rejected" style={{ marginTop: 8 }}>✕ {fundOp.error}</p>}
          {stage === "selected" && !fundOp && (
            <button style={{ marginTop: 12 }} onClick={() => void actions.fund()}>Fund escrow</button>
          )}
          {fundOp?.status === "failed" && <button style={{ marginTop: 12 }} onClick={() => void actions.fund()}>Resume funding</button>}
        </div>
      )}
    </motion.section>
  );
}
