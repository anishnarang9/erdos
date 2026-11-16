import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Beams } from "./fx/Beams";
import { sound } from "./fx/sound";
import { BuyerPanel } from "./components/BuyerPanel";
import { Captions, useCaption } from "./components/Captions";
import { SolverPanel } from "./components/SolverPanel";
import { Timeline } from "./components/Timeline";
import { TopBar } from "./components/TopBar";
import { Vault3D } from "./components/Vault3D";
import { startLive } from "./lib/live";
import { usePresenterKeys } from "./lib/presenter";
import { stageOf, useDemo } from "./lib/store";

const VAULT_LABEL: Record<string, string> = {
  funded: "USDC locked in escrow",
  proving: "Waiting for a proof",
  proved: "Proof ready",
  submitted: "Proof accepted on Arc",
  paid: "Released to the solver",
  decrypted: "Released to the solver",
  rejected: "Locked · proof failed the rules",
  refunded: "Refunded to the buyer",
};

export default function App() {
  const stage = useDemo(stageOf);
  const caption = useCaption();
  const [toast, setToast] = useState<string | null>(null);
  const onToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 1800);
  }, []);
  usePresenterKeys(onToast);

  useEffect(() => {
    const m = /^#\/job\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(location.hash);
    startLive(m ? m[1]! : null);
  }, []);
  useEffect(() => {
    if (stage === "submitted") sound.chime();
  }, [stage]);

  const focus = (area: string) => (caption?.area === area ? "focus-ring" : "");

  return (
    <div className="app">
      <TopBar />
      <main className="stage">
        <div className={focus("buyer")} style={{ minHeight: 0, display: "flex" }}><BuyerPanel /></div>
        <div className={`panel ${focus("vault")}`} style={{ padding: 0, position: "relative" }}>
          <Vault3D />
          <AnimatePresence mode="wait">
            {VAULT_LABEL[stage] && (
              <motion.div key={stage} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                style={{ position: "absolute", bottom: 96, width: "100%", textAlign: "center" }} className="mono">
                {VAULT_LABEL[stage]}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className={focus("solver")} style={{ minHeight: 0, display: "flex", borderLeft: "1px solid var(--line)" }}><SolverPanel /></div>
        <Beams />
        <Captions visible />
        <AnimatePresence>
          {toast && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="badge neutral"
              style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", background: "var(--surface)", zIndex: 30 }}>
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <div className={focus("timeline")}><Timeline /></div>
    </div>
  );
}
