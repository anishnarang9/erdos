// Step 2: Grok's draft as the engine sees it. Quoted phrases fly out of the request into a "grounded in" strip;
// the rules type out from the engine's canonical preview (never the model's prose), each stamped by the engine.
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { DraftResponse } from "../lib/api";
import { actions } from "../lib/live";
import { ruleText } from "../lib/rules";
import { store, useDemo } from "../lib/store";
import { sound } from "../fx/sound";
import { Hash } from "./Hash";

type Draft = Extract<DraftResponse, { kind: "draft" }>;

function Highlighted({ text, quotes, flown }: { text: string; quotes: string[]; flown: boolean }) {
  // Mark the first occurrence of each request quote; once flown, the marks become plain text.
  const parts: (string | { q: string; i: number })[] = [];
  let rest = text;
  quotes.forEach((q, i) => {
    const at = rest.indexOf(q);
    if (at < 0) return;
    parts.push(rest.slice(0, at), { q, i });
    rest = rest.slice(at + q.length);
  });
  parts.push(rest);
  return (
    <p style={{ margin: 0, lineHeight: 1.7 }}>
      {parts.map((p, k) =>
        typeof p === "string" ? (
          <span key={k}>{p}</span>
        ) : flown ? (
          <span key={k} className="faint">{p.q}</span>
        ) : (
          <motion.mark key={k} layoutId={`q-${p.i}`} style={{ background: "rgba(47,143,255,0.18)", color: "var(--text)", borderRadius: 3, padding: "0 2px" }}>
            {p.q}
          </motion.mark>
        ),
      )}
    </p>
  );
}

function TypedRule({ text, delay }: { text: string; delay: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      sound.tick();
      iv = setInterval(() => setN((x) => (x >= text.length ? (clearInterval(iv), x) : x + 2)), 14);
    }, delay);
    return () => {
      clearTimeout(start);
      if (iv) clearInterval(iv);
    };
  }, [text, delay]);
  return <span className="mono" style={{ fontSize: 14 }}>{text.slice(0, n)}{n < text.length && <span className="faint">▍</span>}</span>;
}

export function RulesCard({ draft }: { draft: Draft }) {
  const request = useDemo((s) => s.draftRequest?.request ?? "");
  const job = useDemo((s) => s.job);
  const [flown, setFlown] = useState(false);
  useEffect(() => {
    setFlown(false);
    const t = setTimeout(() => setFlown(true), 1100);
    return () => clearTimeout(t);
  }, [draft.draftId]);
  const quotes = draft.sourceQuotes.filter((q) => !q.path.includes(".") && request.includes(q.quote)).map((q) => q.quote).slice(0, 4);
  const rules = (draft.preview?.rules ?? []) as unknown[];

  return (
    <LayoutGroup>
      <motion.section className="card" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Rules the payout depends on</h2>
          <span className="badge verified">✓ checked by engine</span>
        </div>
        <div style={{ marginTop: 12 }} className="dim">
          <Highlighted text={request} quotes={quotes} flown={flown} />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 28, margin: "12px 0" }} aria-label="Grounded in your request">
          {flown && quotes.map((q, i) => (
            <motion.span key={i} layoutId={`q-${i}`} className="badge money" style={{ fontFamily: "var(--sans)", fontWeight: 500, whiteSpace: "normal", lineHeight: 1.35 }} transition={{ type: "spring", stiffness: 140, damping: 18 }}>
              “{q}”
            </motion.span>
          ))}
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
          <AnimatePresence>
            {flown && rules.map((r, i) => (
              <motion.li key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.35 }}>
                <TypedRule text={ruleText(r)} delay={300 + i * 350} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
        {flown && <Examples draft={draft} delay={0.4 + rules.length * 0.35} />}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 16 }}>
          {draft.engine && <Hash label="rulesHash" value={draft.engine.rulesHash} />}
          <span className="faint mono" style={{ fontSize: 12 }}>{draft.model}</span>
        </div>
        {!job && (
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button onClick={() => void actions.approve()}>Approve these rules</button>
            <button className="ghost" onClick={() => store.set({ draft: null })}>Edit request</button>
            <span className="dim" style={{ alignSelf: "center", fontSize: 13 }}>Approval binds the exact rulesHash; any edit voids it.</span>
          </div>
        )}
      </motion.section>
    </LayoutGroup>
  );
}

function Examples({ draft, delay }: { draft: Draft; delay: number }) {
  return (
    <motion.table initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay }} style={{ width: "100%", marginTop: 16, borderCollapse: "collapse", fontSize: 13 }}>
      <caption className="dim" style={{ textAlign: "left", marginBottom: 6 }}>Examples, labelled by the checker (not by Grok)</caption>
      <thead className="faint">
        <tr><th align="left">example</th><th align="left">Grok predicted</th><th align="left">checker</th></tr>
      </thead>
      <tbody>
        {draft.examples.map((e) => (
          <tr key={e.name} style={{ borderTop: "1px solid var(--line)" }}>
            <td className="mono" style={{ padding: "6px 0" }}>{e.name}</td>
            <td>{e.predictedVerdict ? "pass" : "fail"}</td>
            <td>
              {e.checkerVerdict === null ? (
                <span className="badge neutral" title={e.checkerError}>⚠ engine error</span>
              ) : e.checkerVerdict === 1 ? (
                <span className="badge verified">✓ pass</span>
              ) : (
                <span className="badge rejected">✕ fail</span>
              )}
              {e.agrees === false && <span className="badge locked" style={{ marginLeft: 6 }}>Grok was wrong</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </motion.table>
  );
}
