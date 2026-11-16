// The solver agent's side, from its run events. Local events animate; the chain decides what is paid.
import { AnimatePresence, motion } from "motion/react";
import { formatUsdc } from "../lib/chain";
import { useDemo, type RunEvent } from "../lib/store";
import { Hash } from "./Hash";
import { ProvingGrid } from "./ProvingGrid";

const COPY: Record<string, { icon: string; text: (e: RunEvent) => string; tone: string }> = {
  "quote.created": { icon: "◆", text: (e) => `Quoted ${formatUsdc(String(e.data.price ?? "0"))}`, tone: "money" },
  "solver.started": { icon: "▶", text: (e) => `Assigned chain job #${e.chainJobId} · solving with ${String(e.data.solver)}`, tone: "neutral" },
  "proof.started": { icon: "◌", text: () => "Proving the encrypted delivery", tone: "locked" },
  "proof.finished": { icon: "π", text: (e) => (e.data.verdict === 1 ? "Proof ready · verdict 1" : "Proof ready · verdict 0 (rules fail)"), tone: "verified" },
  "proof.failed": { icon: "✕", text: (e) => `Prover error · ${String(e.data.code)}`, tone: "rejected" },
  "submission.preflight_rejected": { icon: "✕", text: (e) => `Chain would reject it (${String(e.data.reason)}) · nothing sent`, tone: "rejected" },
  "submission.broadcast": { icon: "⤴", text: () => "Submitting proof to Arc", tone: "locked" },
  "submission.confirmed": { icon: "✓", text: () => "ProofAccepted on Arc", tone: "verified" },
  "release.broadcast": { icon: "⤴", text: () => "Releasing the key", tone: "locked" },
  "release.confirmed": { icon: "✓", text: () => "Key released · payment settled", tone: "verified" },
  "run.abandoned": { icon: "⏸", text: (e) => `Abandoned · ${String(e.data.reason)}`, tone: "locked" },
  "run.failed": { icon: "✕", text: (e) => `Failed · ${String(e.data.message)}`, tone: "rejected" },
};

export function SolverPanel() {
  const events = useDemo((s) => s.events);
  const provider = events.find((e) => e.data.provider)?.data.provider as string | undefined;
  const started = events.find((e) => e.type === "proof.started");
  const finished = events.find((e) => e.type === "proof.finished");

  return (
    <div className="panel" aria-labelledby="solver-title">
      <div className="panel-title" id="solver-title">◈ Solver agent</div>
      {provider ? <Hash label="wallet" value={provider} /> : <p className="dim">Watching the job feed for work it can solve…</p>}
      <ProvingGrid {...(started ? { started } : {})} {...(finished ? { finished } : {})} />
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} aria-live="polite">
        <AnimatePresence initial={false}>
          {events.map((e) => {
            const c = COPY[e.type];
            if (!c) return null;
            return (
              <motion.li key={e.seq} layout initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}
                style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className={`badge ${c.tone}`} style={{ width: 30, justifyContent: "center" }}>{c.icon}</span>
                <span>{c.text(e)}</span>
                {typeof e.data.txHash === "string" && <Hash value={e.data.txHash} tx />}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
}
