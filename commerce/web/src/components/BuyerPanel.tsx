// The buyer's column: request → rules → fund → (unlock | locked escrow and refund).
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { actions } from "../lib/live";
import { stageOf, useDemo } from "../lib/store";
import { DeliveryCard } from "./DeliveryCard";
import { Clarification, Unsupported } from "./DraftOutcome";
import { FundCard } from "./FundCard";
import { Hash } from "./Hash";
import { RequestCard } from "./RequestCard";
import { RulesCard } from "./RulesCard";

function RefundCard() {
  const job = useDemo((s) => s.job);
  const refundOp = useDemo((s) => s.refundOp);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(iv);
  }, []);
  // The chain's deadline is authoritative; the quote's terms are only a fallback before the first read.
  const expiredAt = Number(useDemo((s) => s.chainExpiredAt ?? s.fundingTerms?.expiredAt ?? "0"));
  const left = Math.max(0, Math.round(expiredAt - now));
  if (!job?.chain) return null;
  const refundTx = refundOp?.status === "confirmed" ? refundOp.steps[0]?.txHash : undefined;
  if (refundTx || job.chain.status === "Expired") {
    return (
      <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ borderColor: "var(--money)" }}>
        <h2>Refunded to the buyer</h2>
        <p className="dim">The proof failed the approved rules, so the solver was never paid. After the deadline the budget went back to the buyer.</p>
        {refundTx && <Hash label="refund tx" value={refundTx} tx />}
      </motion.section>
    );
  }
  return (
    <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ borderColor: "var(--locked)" }}>
      <h2>Escrow stays locked</h2>
      <p className="dim">The proof failed the approved rules, so nothing was paid. The buyer can reclaim the budget once the deadline passes on chain.</p>
      {expiredAt > 0 && left > 0 && <span className="badge locked">⏳ refund opens in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
      <div style={{ marginTop: 12 }}>
        <button disabled={(expiredAt > 0 && left > 0) || refundOp?.status === "pending"} onClick={() => void actions.refund()}>
          {refundOp?.status === "pending" ? "Claiming refund…" : "Claim refund"}
        </button>
      </div>
      {refundOp?.status === "failed" && <p className="badge rejected" style={{ marginTop: 8 }}>✕ {refundOp.error}</p>}
    </motion.section>
  );
}

export function BuyerPanel() {
  const stage = useDemo(stageOf);
  const draft = useDemo((s) => s.draft);
  const job = useDemo((s) => s.job);
  const error = useDemo((s) => s.error);

  return (
    <div className="panel" aria-labelledby="buyer-title">
      <div className="panel-title" id="buyer-title">◇ Buyer</div>
      {error && <div className="badge rejected" role="alert" style={{ whiteSpace: "normal" }}>✕ {error}</div>}
      {!job && draft?.kind !== "draft" && <RequestCard />}
      {draft?.kind === "clarification" && <Clarification draft={draft} />}
      {draft?.kind === "unsupported" && <Unsupported draft={draft} />}
      {draft?.kind === "draft" && <RulesCard draft={draft} />}
      {job && <FundCard />}
      {(stage === "rejected" || stage === "refunded") && <RefundCard />}
      <DeliveryCard />
    </div>
  );
}
