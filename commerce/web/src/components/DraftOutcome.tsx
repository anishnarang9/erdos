// Grok asked a question, or the engine reported a capability it does not have.
import { motion } from "motion/react";
import { useState } from "react";
import type { DraftResponse } from "../lib/api";
import { actions } from "../lib/live";

export function Clarification({ draft }: { draft: Extract<DraftResponse, { kind: "clarification" }> }) {
  const [answer, setAnswer] = useState("");
  const question = draft.questions.join(" ");
  return (
    <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ borderColor: "var(--locked)" }}>
      <span className="badge locked">? Grok needs a detail · round {draft.round} of 2</span>
      <ul style={{ margin: "12px 0", paddingLeft: 20 }}>
        {draft.questions.map((q) => <li key={q}>{q}</li>)}
      </ul>
      <label htmlFor="answer">Your answer</label>
      <textarea id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} />
      <button style={{ marginTop: 12 }} disabled={answer.trim() === ""} onClick={() => void actions.answerClarification(question, answer)}>
        Answer and redraft
      </button>
    </motion.section>
  );
}

export function Unsupported({ draft }: { draft: Extract<DraftResponse, { kind: "unsupported" }> }) {
  const ce = draft.capabilityError;
  return (
    <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ borderColor: "var(--rejected)" }}>
      <span className="badge rejected">✕ the engine cannot check this yet</span>
      {ce ? (
        <>
          <p style={{ marginBottom: 4 }}>{ce.message}</p>
          {ce.request && (
            <p className="dim" style={{ marginTop: 0 }}>
              Capability request filed: <span className="mono">{ce.request.kind} · {ce.request.name}</span>
            </p>
          )}
        </>
      ) : (
        <p>{draft.reason}{draft.errors?.length ? `: ${draft.errors.map((e) => e.message).join("; ")}` : ""}</p>
      )}
      <p className="faint" style={{ fontSize: 13 }}>No job is created. Rephrase the request, or ask for the capability.</p>
    </motion.section>
  );
}
