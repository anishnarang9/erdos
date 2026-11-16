// The zkVM proving view. While proving it is honest-indeterminate: a sweeping wave and the real elapsed time
// (the engine does not report progress). On proof.finished it collapses into the proof chip with real metrics.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { NumberTicker } from "../fx/NumberTicker";
import { sound } from "../fx/sound";
import type { RunEvent } from "../lib/store";

const COLS = 28;
const ROWS = 9;

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, []);
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return <span className="mono">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

export function ProvingGrid({ started, finished }: { started?: RunEvent; finished?: RunEvent }) {
  const proving = !!started && !finished;
  useEffect(() => {
    if (proving) sound.humStart();
    else sound.humStop();
    return () => sound.humStop();
  }, [proving]);
  if (!started) return null;
  const d = finished?.data ?? {};
  const pass = d.verdict === 1;

  return (
    <div className="card" style={{ background: "var(--surface-2)" }} aria-live="polite">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <span className="panel-title">zkVM · RISC Zero 3.1.0 · Groth16</span>
        {proving ? (
          <span className="badge locked">◌ proving · <Elapsed since={started.at} /></span>
        ) : (
          <span className={`badge ${pass ? "verified" : "rejected"}`}>{pass ? "✓ verdict 1 · rules pass" : "✕ verdict 0 · rules fail"}</span>
        )}
      </div>
      <AnimatePresence mode="wait">
        {proving ? (
          <motion.div key="grid" exit={{ scaleY: 0.05, opacity: 0, transition: { duration: 0.6, ease: "easeIn" } }}
            style={{ display: "grid", gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 3 }} aria-label="Proving (progress is not reported by the engine)">
            {Array.from({ length: COLS * ROWS }, (_, i) => {
              const col = i % COLS;
              const row = Math.floor(i / COLS);
              return (
                <motion.span key={i} style={{ aspectRatio: "1", borderRadius: 2, background: "var(--money)" }}
                  animate={{ opacity: [0.08, 0.85, 0.08] }}
                  transition={{ duration: 2.4, repeat: Infinity, delay: (col * 0.06 + row * 0.11) % 2.4, ease: "easeInOut" }} />
              );
            })}
          </motion.div>
        ) : (
          <motion.div key="chip" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 16 }}
            style={{ border: `1px solid ${pass ? "var(--verified)" : "var(--rejected)"}`, borderRadius: 6, padding: 14, display: "grid", gap: 6, boxShadow: `0 0 28px ${pass ? "rgba(61,220,151,0.25)" : "rgba(255,92,92,0.25)"}` }}>
            <span className="mono" style={{ fontSize: 18 }}>π · {String(d.sealBytes ?? 260)} bytes · 0xe71e6620…</span>
            <span className="dim mono" style={{ fontSize: 13 }}>
              <NumberTicker value={Number(d.userCycles ?? 0)} /> guest cycles · {(Number(d.proveMillis ?? 0) / 1000).toFixed(1)} s on WSL2
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
