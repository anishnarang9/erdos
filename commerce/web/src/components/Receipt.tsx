// The single release receipt: payout and key released by one transaction, shown as one semantic state.
import { motion } from "motion/react";
import { formatUsdc } from "../lib/chain";
import { stageOf, useDemo } from "../lib/store";
import { Hash } from "./Hash";

export function Receipt() {
  const stage = useDemo(stageOf);
  const sub = useDemo((s) => s.submission);
  const budget = useDemo((s) => s.fundingTerms?.budget);
  const files = useDemo((s) => s.delivery?.files);
  const refund = useDemo((s) => s.refundOp?.steps[0]?.txHash ?? s.submission?.refundTx ?? undefined);
  if ((stage === "paid" || stage === "decrypted") && sub?.releaseTx) {
    return (
      <motion.div className="receipt" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.35 }}>
        <span className="panel-title" style={{ margin: 0 }}>Release receipt</span>
        <span><strong>{budget ? formatUsdc(budget) : "Payout"}</strong> to the solver · key released</span>
        <Hash value={sub.releaseTx} tx />
        {files && <span className="faint" style={{ fontSize: 13 }}>{files.map((f) => f.name).join(" · ")} recovered</span>}
      </motion.div>
    );
  }
  if (stage === "refunded") {
    return (
      <div className="receipt">
        <span className="panel-title" style={{ margin: 0 }}>Refund receipt</span>
        <span>{budget ? formatUsdc(budget) : "Budget"} returned to the buyer after expiry</span>
        {refund && <Hash value={refund} tx />}
      </div>
    );
  }
  return null;
}
