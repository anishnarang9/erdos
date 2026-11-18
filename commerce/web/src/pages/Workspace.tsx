// Real transaction workspace (product-plan.md §D Layout 2): outcome + next action, brief/checks, the dominant
// chamber driven by the chain-derived stage, the selected solver, timeline + one release receipt, narration.
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProofChamber } from "../chamber/ProofChamber";
import { HostedBounties } from "../components/HostedBounties";
import { BuyerPanel } from "../components/BuyerPanel";
import { Captions, useCaption } from "../components/Captions";
import { Elapsed } from "../components/Elapsed";
import { Drawer, EvidenceInspector } from "../components/EvidenceInspector";
import { Receipt } from "../components/Receipt";
import { SolverPanel } from "../components/SolverPanel";
import { Timeline } from "../components/Timeline";
import { TopBar } from "../components/TopBar";
import { sound } from "../fx/sound";
import { project } from "../lib/gate";
import { startLive, stopLive } from "../lib/live";
import { hostedDemo } from "../lib/hosted";
import { playRecording, stopReplay, type Recording } from "../lib/replay";
import { usePresenterKeys } from "../lib/presenter";
import { stageOf, store, useDemo } from "../lib/store";

function ChamberOverlay() {
  const events = useDemo((s) => s.events);
  const started = [...events].reverse().find((e) => e.type === "proof.started");
  const finished = [...events].reverse().find((e) => e.type === "proof.finished");
  if (started && !finished) return <div className="chip-overlay">Proving · <Elapsed since={started.at} /> elapsed</div>;
  if (finished) {
    return (
      <motion.div className="chip-overlay" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
        π · {String(finished.data.sealBytes ?? "—")} bytes · {Number(finished.data.userCycles ?? 0).toLocaleString("en-US")} cycles · verdict {String(finished.data.verdict)}
      </motion.div>
    );
  }
  return null;
}

export function Workspace({ jobId }: { jobId: string | null }) {
  const stage = useDemo(stageOf);
  const mode = useDemo((s) => s.mode);
  const proj = project(stage);
  const caption = useCaption();
  const [toast, setToast] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<"evidence" | "solver" | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const onToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 1800);
  }, []);
  const [loadingReplay, setLoadingReplay] = useState(false);
  const [replayError, setReplayError] = useState(false);
  const showPublicWorkspace = hostedDemo && mode !== "replay";
  usePresenterKeys(onToast);

  async function playDemo() {
    setLoadingReplay(true);
    setReplayError(false);
    try {
      const { default: recording } = await import("../../recordings/run-2026-11-16-job3-paid.json");
      playRecording(recording as Recording, 4);
    } catch {
      setReplayError(true);
    } finally {
      setLoadingReplay(false);
    }
  }

  useEffect(() => {
    if (!hostedDemo) {
      startLive(jobId);
      return stopLive;
    }
    return () => {
      stopReplay();
      store.reset();
    };
  }, [jobId]);
  useEffect(() => {
    if (stage === "submitted") sound.chime();
  }, [stage]);

  const open = (which: "evidence" | "solver") => (el: HTMLElement) => {
    trigger.current = el;
    setDrawer(which);
  };
  const close = useCallback(() => {
    setDrawer(null);
    trigger.current?.focus();
  }, []);
  const focus = (area: string) => (caption?.area === area ? "focus-ring" : "");

  return (
    <div className="ws">
      <TopBar onEvidence={open("evidence")} onSolver={open("solver")} />
      <section className="outcome" aria-live="polite">
        <span className={`tone ${proj.tone}`} aria-hidden />
        <motion.h1 key={showPublicWorkspace ? "Public workspace" : proj.outcome} initial={{ opacity: 0.4, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
          {showPublicWorkspace ? "Public workspace" : proj.outcome}
        </motion.h1>
        <span className="next">{showPublicWorkspace ? "Explore Arc testnet bounties or watch the recorded demo." : proj.next}</span>
      </section>
      <main className="ws-main">
        <div className={`ws-col left ${focus("buyer")}`}>
          {hostedDemo && (
            <>
              <HostedBounties key={jobId ?? "list"} jobId={jobId} />
              <section className="card">
                <h2>Selected-provider demo</h2>
                <p className="dim">Recorded on Arc testnet. Plays at 4× speed.</p>
                <button onClick={() => void playDemo()} disabled={loadingReplay}>
                  {mode === "replay" ? "Restart recorded demo" : "Play recorded demo"}
                </button>
                {replayError && <p role="alert">Could not play the recording.</p>}
              </section>
            </>
          )}
          {!showPublicWorkspace && <BuyerPanel />}
        </div>
        <div className={`ws-stage ${focus("vault")}`}>
          <div className="chamber-card">
            <div className="chamber-head">
              <div>
                <div className="eyebrow">{showPublicWorkspace ? "Arc testnet · read only" : mode === "live" ? "Live · Arc testnet" : "Recorded run · signing unavailable"}</div>
                <h2>{proj.status}</h2>
              </div>
            </div>
            <ProofChamber
              gate={proj.gate}
              flow={proj.flow}
              status={{ tone: proj.tone, text: proj.status }}
              left={{ title: "Delivery", sub: "Encrypted files" }}
              right={{ title: "Acceptance", sub: proj.gate === "open" ? "Released" : proj.gate === "accepted" ? "Proof accepted" : "Gate locked" }}
              hint="Gate follows confirmed chain state"
              overlay={<ChamberOverlay />}
            />
          </div>
        </div>
        <div className={`ws-col right ${focus("solver")}`}><SolverPanel /></div>
      </main>
      <div className={`ws-bottom ${focus("timeline")}`}>
        <Timeline />
        <Receipt />
      </div>
      <div className="ws-caption"><Captions visible /></div>
      <AnimatePresence>
        {toast && (
          <motion.div className="toast" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{toast}</motion.div>
        )}
      </AnimatePresence>
      {drawer === "evidence" && <EvidenceInspector onClose={close} />}
      {drawer === "solver" && <Drawer title="Selected solver" onClose={close}><SolverPanel /></Drawer>}
    </div>
  );
}
