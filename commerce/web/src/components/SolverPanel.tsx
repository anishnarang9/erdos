// The selected solver and its run events. Summary first; the full event log is a disclosure.
// Local events describe the solver's work; the chain alone decides what is paid.
import { AnimatePresence, motion } from "motion/react";
import { formatUsdc } from "../lib/chain";
import { useDemo, type RunEvent } from "../lib/store";
import { Hash } from "./Hash";

const COPY: Record<string, { icon: string; text: (e: RunEvent) => string; tone: string }> = {
  "quote.created": { icon: "◆", text: (e) => `Quoted ${formatUsdc(String(e.data.price ?? "0"))}`, tone: "money" },
  "solver.started": { icon: "▶", text: (e) => `Assigned Arc job #${e.chainJobId}`, tone: "neutral" },
  "proof.started": { icon: "◌", text: () => "Proving the encrypted delivery", tone: "locked" },
  "proof.finished": { icon: "π", text: (e) => (e.data.verdict === 1 ? "Proof ready · verdict 1" : "Proof ready · verdict 0"), tone: "verified" },
  "proof.failed": { icon: "✕", text: (e) => `Prover error · ${String(e.data.code)}`, tone: "rejected" },
  "submission.preflight_rejected": { icon: "✕", text: (e) => `Preflight rejected (${String(e.data.reason)}) · nothing sent`, tone: "rejected" },
  "submission.broadcast": { icon: "⤴", text: () => "Submission sent", tone: "locked" },
  "submission.confirmed": { icon: "✓", text: () => "Proof accepted on Arc", tone: "verified" },
  "release.broadcast": { icon: "⤴", text: () => "Release sent", tone: "locked" },
  "release.confirmed": { icon: "✓", text: () => "Release receipt confirmed", tone: "verified" },
  "run.abandoned": { icon: "⏸", text: (e) => `Abandoned · ${String(e.data.reason)}`, tone: "locked" },
  "run.failed": { icon: "✕", text: (e) => `Failed · ${String(e.data.message)}`, tone: "rejected" },
};

export function SolverPanel() {
  const events = useDemo((s) => s.events);
  const selected = useDemo((s) => s.fundingTerms?.provider);
  const assigned = events.find((e) => e.type === "solver.started")?.data.provider as string | undefined;
  const provider = assigned ?? selected;
  const quotes = events.filter((e) => e.type === "quote.created").length;
  const shown = events.filter((e) => COPY[e.type]);
  const last = shown[shown.length - 1];
  const finished = [...events].reverse().find((e) => e.type === "proof.finished");

  return (
    <>
      <div>
        <div className="panel-title">Selected solver</div>
        {provider ? <Hash value={provider} /> : <p className="dim" style={{ margin: 0 }}>{quotes > 1 ? `${quotes} solvers quoted · the buyer chooses one` : "Watching the job feed for work it can solve."}</p>}
        <p className="faint" style={{ fontSize: 13, margin: "8px 0 0" }}>Capability: autonomous agent. Human-prepared files: eligible, adapter next.</p>
      </div>
      {finished && (
        <div className="card" style={{ padding: 14 }}>
          <div className="panel-title">Proof</div>
          <div className="mono" style={{ fontSize: 14 }}>
            {String(finished.data.sealBytes ?? "—")} bytes · {Number(finished.data.userCycles ?? 0).toLocaleString("en-US")} cycles · {(Number(finished.data.proveMillis ?? 0) / 1000).toFixed(1)} s
          </div>
        </div>
      )}
      {last && (
        <div aria-live="polite">
          <div className="panel-title">Latest</div>
          <span className={`badge ${COPY[last.type]!.tone}`}>{COPY[last.type]!.icon} {COPY[last.type]!.text(last)}</span>
        </div>
      )}
      {shown.length > 0 && (
        <details>
          <summary className="dim" style={{ cursor: "pointer" }}>Run log ({shown.length})</summary>
          <ol style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 8 }}>
            <AnimatePresence initial={false}>
              {shown.map((e) => {
                const c = COPY[e.type]!;
                return (
                  <motion.li key={e.seq} layout initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} style={{ display: "grid", gap: 4 }}>
                    <span className={`badge ${c.tone}`} style={{ justifySelf: "start", whiteSpace: "normal" }}>{c.icon} {c.text(e)}</span>
                    {typeof e.data.txHash === "string" && <Hash value={e.data.txHash} tx />}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        </details>
      )}
    </>
  );
}
