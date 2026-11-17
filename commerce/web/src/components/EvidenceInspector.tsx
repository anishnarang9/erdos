// Evidence inspector (product-plan.md §D Layout 3): Checks / Files / Transactions in an HTML drawer.
// Raw hashes sit behind a further disclosure. Escape or Close returns focus to the trigger.
import { Fragment, useEffect, useRef, useState } from "react";
import { formatUsdc } from "../lib/chain";
import { ruleText } from "../lib/rules";
import { useDemo } from "../lib/store";
import { Hash } from "./Hash";

type Tab = "checks" | "files" | "transactions";

export function Drawer({ title, onClose, children, tabs }: { title: string; onClose: () => void; children: React.ReactNode; tabs?: React.ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <span className="spacer" />
          <button ref={close} className="ghost" onClick={onClose}>Close</button>
        </header>
        {tabs ?? <div />}
        <div className="body">{children}</div>
      </aside>
    </>
  );
}

export function EvidenceInspector({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("checks");
  const draft = useDemo((s) => s.draft);
  const job = useDemo((s) => s.job);
  const events = useDemo((s) => s.events);
  const delivery = useDemo((s) => s.delivery);
  const sub = useDemo((s) => s.submission);
  const fundOp = useDemo((s) => s.fundOp);
  const refundOp = useDemo((s) => s.refundOp);
  const terms = useDemo((s) => s.fundingTerms);
  const rules = (draft?.kind === "draft" ? draft.preview?.rules ?? [] : []) as unknown[];
  const finished = [...events].reverse().find((e) => e.type === "proof.finished");
  const outputs = job?.revision.revision.outputs ?? (draft?.kind === "draft" ? draft.revision.outputs : []);

  const txs: { label: string; hash: string }[] = [];
  for (const s of fundOp?.steps ?? []) if (s.txHash && s.label !== "link") txs.push({ label: s.label, hash: s.txHash });
  if (!txs.some((t) => t.label === "fund") && job?.chain?.fundTx) txs.push({ label: "fund", hash: job.chain.fundTx });
  if (sub?.submitTx) txs.push({ label: "submit (proof accepted)", hash: sub.submitTx });
  if (sub?.releaseTx) txs.push({ label: "release (payout + key)", hash: sub.releaseTx });
  const refundTx = refundOp?.steps[0]?.txHash ?? sub?.refundTx;
  if (refundTx) txs.push({ label: "refund", hash: refundTx });

  const tabs = (
    <div className="tabs" role="tablist">
      {(["checks", "files", "transactions"] as Tab[]).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
      ))}
    </div>
  );

  return (
    <Drawer title="Evidence" onClose={onClose} tabs={tabs}>
      {tab === "checks" && (
        <>
          <p className="dim" style={{ margin: 0 }}>The engine's canonical rules, rendered from its own preview (not the model's prose). The proof reports one verdict for all of them.</p>
          {rules.length === 0 ? <p className="faint">No approved rules yet.</p> : (
            <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
              {rules.map((r, i) => <li key={i} className="mono" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{ruleText(r)}</li>)}
            </ol>
          )}
          {finished && (
            <p>
              <span className={`badge ${finished.data.verdict === 1 ? "verified" : "rejected"}`}>
                {finished.data.verdict === 1 ? "✓ Verdict 1 · every rule passes" : "✕ Verdict 0 · at least one rule fails"}
              </span>
            </p>
          )}
          <details>
            <summary className="dim" style={{ cursor: "pointer" }}>Commitments</summary>
            <dl className="kv" style={{ marginTop: 12 }}>
              {job?.manifest && <><dt>imageId</dt><dd><Hash value={job.manifest.imageId} /></dd><dt>rulesHash</dt><dd><Hash value={job.manifest.rulesHash} /></dd><dt>referenceHash</dt><dd><Hash value={job.manifest.referenceHash} /></dd></>}
              {sub?.envelopeHash && <><dt>envelopeHash</dt><dd><Hash value={sub.envelopeHash} /></dd></>}
              {sub?.keyCommitment && <><dt>keyCommitment</dt><dd><Hash value={sub.keyCommitment} /></dd></>}
            </dl>
          </details>
        </>
      )}
      {tab === "files" && (
        <>
          {delivery ? (
            <>
              <p style={{ margin: 0 }}>
                <span className={`badge ${delivery.envelopeHashOk && delivery.keyOk ? "verified" : "rejected"}`}>
                  {delivery.envelopeHashOk && delivery.keyOk ? "✓ Recovered and verified from chain data" : "✕ Commitment check failed"}
                </span>
              </p>
              <dl className="kv">
                {delivery.files.map((f) => <Fragment key={f.name}><dt className="mono">{f.name}</dt><dd>{f.content.length.toLocaleString("en-US")} bytes</dd></Fragment>)}
              </dl>
            </>
          ) : (
            <>
              <p className="dim" style={{ margin: 0 }}>Files are recoverable only after the release receipt: the browser reads the envelope from the accepted submission and decrypts it with the released key.</p>
              <dl className="kv">{outputs.map((o) => <Fragment key={o.name}><dt className="mono">{o.name}</dt><dd>{o.format} · not yet recoverable</dd></Fragment>)}</dl>
            </>
          )}
          <p className="faint" style={{ fontSize: 13 }}>Data visibility: the released key is public, so anyone can decrypt this delivery. Use public or shareable data.</p>
        </>
      )}
      {tab === "transactions" && (
        <>
          <dl className="kv">
            <dt>Network</dt><dd>Arc testnet (5042002)</dd>
            {job?.chain && <><dt>Chain job</dt><dd>#{job.chain.jobId} · {job.chain.status}</dd></>}
            {terms && <><dt>Budget</dt><dd>{formatUsdc(terms.budget)}</dd><dt>Solver</dt><dd><Hash value={terms.provider} /></dd></>}
          </dl>
          {txs.length === 0 ? <p className="faint">No transactions yet.</p> : (
            <dl className="kv">{txs.map((t) => <Fragment key={t.hash}><dt>{t.label}</dt><dd><Hash value={t.hash} tx /></dd></Fragment>)}</dl>
          )}
          {events.some((e) => e.type === "submission.preflight_rejected") && (
            <p><span className="badge rejected">✕ Preflight rejected · nothing sent</span></p>
          )}
        </>
      )}
    </Drawer>
  );
}
