// Workspace header: identity, mode (LIVE · ARC TESTNET or RECORDED RUN), job id, buyer token, signer, sound,
// evidence. The signer list reflects GET /v1/demo/capabilities; choosing one in the UI grants no authority.
import { useEffect, useState } from "react";
import { api, getToken, setToken } from "../lib/api";
import { hasInjectedWallet } from "../lib/chain";
import { store, useDemo } from "../lib/store";
import { Wordmark } from "./Wordmark";

export function TopBar({ onEvidence, onSolver }: { onEvidence: (el: HTMLElement) => void; onSolver: (el: HTMLElement) => void }) {
  const mode = useDemo((s) => s.mode);
  const recordedAt = useDemo((s) => s.recordedAt);
  const speed = useDemo((s) => s.replaySpeed);
  const realMs = useDemo((s) => s.replayRealMs);
  const signer = useDemo((s) => s.signer);
  const muted = useDemo((s) => s.muted);
  const focus = useDemo((s) => s.focus);
  const jobId = useDemo((s) => s.jobId);
  const chainJob = useDemo((s) => s.job?.chain?.jobId);
  const [token, setTok] = useState(getToken());
  const [demoSigner, setDemoSigner] = useState<{ enabled: boolean } | null>(null);

  useEffect(() => {
    if (!token || mode !== "live") return;
    api.capabilities().then(setDemoSigner, () => setDemoSigner({ enabled: false }));
  }, [token, mode]);
  useEffect(() => {
    if (demoSigner && !demoSigner.enabled && signer === "demo") store.set({ signer: "wallet" });
  }, [demoSigner, signer]);

  return (
    <header className="ws-top">
      <Wordmark />
      {mode === "live" ? (
        <span className="mode-chip live"><i aria-hidden />Live · Arc testnet</span>
      ) : (
        <span className="mode-chip replay"><i aria-hidden />Recorded run · {recordedAt ? new Date(recordedAt).toLocaleString() : ""}</span>
      )}
      {mode === "replay" && speed && speed > 1 && realMs !== undefined && (
        <span className="badge locked">Time-lapse {speed}× · real time {Math.floor(realMs / 60000)}:{String(Math.round((realMs % 60000) / 1000)).padStart(2, "0")}</span>
      )}
      {focus === "act2" && <span className="badge rejected">Act two · tampered delivery</span>}
      {jobId && <span className="jobid" title={jobId}>job {jobId.slice(-8)}{chainJob ? ` · Arc #${chainJob}` : ""}</span>}
      <span className="spacer" />
      {mode === "live" && (!token ? (
        <form onSubmit={(e) => { e.preventDefault(); const v = (new FormData(e.currentTarget).get("t") as string).trim(); setToken(v); setTok(v); }} style={{ display: "flex", gap: 8 }}>
          <input name="t" type="password" placeholder="Buyer API token" aria-label="Buyer API token" />
          <button>Connect</button>
        </form>
      ) : (
        <span className="badge verified">✓ Buyer connected</span>
      ))}
      {mode === "live" && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <span>Signer</span>
          <select value={signer} onChange={(e) => store.set({ signer: e.target.value as "demo" | "wallet" })}>
            <option value="demo" disabled={!demoSigner?.enabled}>Demo signer · testnet{demoSigner?.enabled ? "" : " (off)"}</option>
            <option value="wallet" disabled={!hasInjectedWallet()}>My wallet{hasInjectedWallet() ? "" : " (none found)"}</option>
          </select>
        </label>
      )}
      <button className="ghost solver-toggle" onClick={(e) => onSolver(e.currentTarget)}>Solver</button>
      <button className="ghost" onClick={(e) => onEvidence(e.currentTarget)}>Evidence</button>
      <button className="ghost" onClick={() => store.set({ muted: !muted })} aria-pressed={!muted} aria-label={muted ? "Sound off; turn on" : "Sound on; mute"}>
        {muted ? "Sound off" : "Sound on"}
      </button>
    </header>
  );
}
