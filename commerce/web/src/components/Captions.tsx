// One-line narration per stage. Space steps through the lines; each line focuses one area of the screen.
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { stageOf, store, useDemo, type Stage } from "../lib/store";

export type Area = "buyer" | "vault" | "solver" | "timeline";

export const CAPTIONS: Partial<Record<Stage, { text: string; area: Area }[]>> = {
  request: [{ text: "A buyer describes the job in plain English.", area: "buyer" }],
  drafting: [{ text: "Grok drafts the rules; the engine checks they can be proved.", area: "buyer" }],
  rules: [
    { text: "These are the exact checks that will control the payout.", area: "buyer" },
    { text: "Examples are labelled by the checker, not by the model.", area: "buyer" },
  ],
  quoting: [{ text: "Solver agents see the job and quote a price.", area: "solver" }],
  selected: [{ text: "The buyer picks a quote and funds the escrow on Arc.", area: "buyer" }],
  funding: [{ text: "Four transactions: create, budget, approve, fund. The terms freeze on chain.", area: "timeline" }],
  funded: [{ text: "The money is locked. Only a valid proof can release it.", area: "vault" }],
  proving: [{ text: "The solver proves its encrypted delivery passes the rules, without revealing it.", area: "solver" }],
  proved: [{ text: "The proof is 260 bytes, whatever the work.", area: "solver" }],
  submitted: [{ text: "Arc's verifier accepts the proof. The files are still encrypted.", area: "vault" }],
  paid: [{ text: "One transaction pays the solver and releases the key.", area: "vault" }],
  decrypted: [{ text: "The buyer decrypts exactly what was proven, straight from public chain data.", area: "buyer" }],
  rejected: [
    { text: "One cent off. The checker fails it, and the chain would reject the proof.", area: "solver" },
    { text: "Nothing is paid. The escrow stays locked for the buyer.", area: "vault" },
  ],
  refunded: [{ text: "After the deadline, the buyer takes the money back.", area: "vault" }],
};

export function useCaption(): { text: string; area: Area } | null {
  const stage = useDemo(stageOf);
  const i = useDemo((s) => s.captionIndex);
  const lines = CAPTIONS[stage] ?? [];
  return lines[Math.min(i, lines.length - 1)] ?? null;
}

export function Captions({ visible }: { visible: boolean }) {
  const stage = useDemo(stageOf);
  const caption = useCaption();
  useEffect(() => store.set({ captionIndex: 0 }), [stage]);
  return (
    <AnimatePresence mode="wait">
      {visible && caption && (
        <motion.div key={caption.text} className="caption" role="status" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
          {caption.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
