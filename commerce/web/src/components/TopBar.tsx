// Mode flag (LIVE · ARC TESTNET or RECORDED RUN), signer mode, sound, and the buyer's API token.
import { useEffect, useState } from "react";
import { api, getToken, setToken } from "../lib/api";
import { hasInjectedWallet } from "../lib/chain";
import { store, useDemo } from "../lib/store";

export function TopBar() {
  const mode = useDemo((s) => s.mode);
  const recordedAt = useDemo((s) => s.recordedAt);
  const signer = useDemo((s) => s.signer);
  const muted = useDemo((s) => s.muted);
  const focus = useDemo((s) => s.focus);
  const [token, setTok] = useState(getToken());
  const [demoSigner, setDemoSigner] = useState<{ enabled: boolean; poster?: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    api.capabilities().then(setDemoSigner, () => setDemoSigner({ enabled: false }));
  }, [token]);
  useEffect(() => {
    if (demoSigner && !demoSigner.enabled && signer === "demo") store.set({ signer: "wallet" });
  }, [demoSigner, signer]);

  return (
    <header className="topbar">
      <span className="brand">Proof-Gated Jobs<small>pay for work only when a proof says it passes</small></span>
      {mode === "live" ? (
        <span className="mode-flag live">● LIVE · ARC TESTNET</span>
      ) : (
        <span className="mode-flag replay">⟲ RECORDED RUN · {recordedAt ? new Date(recordedAt).toLocaleString() : ""}</span>
      )}
      {focus === "act2" && <span className="badge rejected">Act two · tampered delivery</span>}
      <span className="spacer" />
      {!token ? (
        <form onSubmit={(e) => { e.preventDefault(); const v = (new FormData(e.currentTarget).get("t") as string).trim(); setToken(v); setTok(v); }} style={{ display: "flex", gap: 8 }}>
          <input name="t" type="password" placeholder="Buyer API token" aria-label="Buyer API token" style={{ width: 220 }} />
          <button>Connect</button>
        </form>
      ) : (
        <span className="badge verified">✓ buyer connected</span>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
        <span className="dim">Signer</span>
        <select value={signer} onChange={(e) => store.set({ signer: e.target.value as "demo" | "wallet" })} style={{ width: 210 }}>
          <option value="demo" disabled={!demoSigner?.enabled}>Demo signer · testnet{demoSigner?.enabled ? "" : " (off)"}</option>
          <option value="wallet" disabled={!hasInjectedWallet()}>My wallet{hasInjectedWallet() ? "" : " (none found)"}</option>
        </select>
      </label>
      <button className="ghost" onClick={() => store.set({ muted: !muted })} aria-pressed={!muted} aria-label={muted ? "Unmute" : "Mute"}>
        {muted ? "🔇" : "🔊"}
      </button>
    </header>
  );
}
