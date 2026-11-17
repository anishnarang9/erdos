// The Arc timeline: each node lights up only from confirmed data, with its transaction link.
import { motion } from "motion/react";
import { STAGE_ORDER, stageOf, useDemo, type Stage } from "../lib/store";
import { Hash } from "./Hash";

const NODES: { stage: Stage; label: string }[] = [
  { stage: "approved", label: "Rules approved" },
  { stage: "quoting", label: "Compiled" },
  { stage: "funded", label: "Funded" },
  { stage: "proved", label: "Proved" },
  { stage: "submitted", label: "Proof accepted" },
  { stage: "paid", label: "Paid" },
  { stage: "decrypted", label: "Decrypted" },
];

export function Timeline() {
  const stage = useDemo(stageOf);
  const job = useDemo((s) => s.job);
  const sub = useDemo((s) => s.submission);
  const refund = useDemo((s) => s.refundOp);
  const at = STAGE_ORDER.indexOf(stage === "rejected" ? "proved" : stage === "refunded" ? "funded" : stage);
  const tx: Partial<Record<Stage, string | undefined>> = { funded: job?.chain?.fundTx, submitted: sub?.submitTx ?? undefined, paid: sub?.releaseTx ?? undefined };

  return (
    <footer className="timeline" aria-label="Arc testnet timeline">
      <span className="panel-title" style={{ marginRight: 8 }}>Arc</span>
      {NODES.map((n, i) => {
        const done = STAGE_ORDER.indexOf(n.stage) <= at;
        const current = STAGE_ORDER.indexOf(n.stage) === at;
        return (
          <div key={n.stage} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {i > 0 && (
              <motion.span style={{ width: 36, height: 2, background: "var(--line-strong)", transformOrigin: "left" }}
                animate={{ background: done ? "var(--verified)" : "var(--line-strong)" }} />
            )}
            <div style={{ display: "grid", gap: 4 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <motion.span aria-hidden style={{ width: 12, height: 12, borderRadius: 6, border: "2px solid var(--line-strong)" }}
                  animate={{ background: done ? "var(--verified)" : "transparent", borderColor: done ? "var(--verified)" : "var(--line-strong)", scale: current ? [1, 1.35, 1] : 1 }}
                  transition={current ? { duration: 1.4, repeat: Infinity } : { duration: 0.3 }} />
                <span style={{ fontSize: 13, color: done ? "var(--text)" : "var(--text-faint)" }}>{n.label}</span>
              </span>
              {tx[n.stage] && <Hash value={tx[n.stage]!} tx />}
            </div>
          </div>
        );
      })}
      {stage === "rejected" && <span className="badge rejected" style={{ marginLeft: 16 }}>✕ rejected · escrow locked</span>}
      {stage === "refunded" && (
        <span style={{ marginLeft: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge money">↩ refunded</span>
          {refund?.steps[0]?.txHash && <Hash value={refund.steps[0].txHash} tx />}
        </span>
      )}
    </footer>
  );
}
