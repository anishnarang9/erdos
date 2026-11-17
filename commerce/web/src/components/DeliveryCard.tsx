// The unlock: both commitments are checked on screen, then the ciphertext decodes into the real files.
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { ScrambleText } from "../fx/ScrambleText";
import { sound } from "../fx/sound";
import { useDemo } from "../lib/store";
import { Hash } from "./Hash";

function download(name: string, content: Uint8Array) {
  const url = URL.createObjectURL(new Blob([content as BlobPart]));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DeliveryCard() {
  const delivery = useDemo((s) => s.delivery);
  const sub = useDemo((s) => s.submission);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!delivery) return;
    setStep(0);
    const ts = [setTimeout(() => setStep(1), 400), setTimeout(() => setStep(2), 1100), setTimeout(() => (setStep(3), sound.chime()), 1800)];
    return () => ts.forEach(clearTimeout);
  }, [delivery]);
  if (!sub?.key || !delivery) return null;
  const decoder = new TextDecoder();

  return (
    <motion.section className="card" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ borderColor: step >= 3 ? "var(--verified)" : undefined }}>
      <h2>Delivery unlocked</h2>
      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0", display: "grid", gap: 6 }}>
        <motion.li initial={{ opacity: 0 }} animate={{ opacity: step >= 1 ? 1 : 0.2 }}>
          <span className={`badge ${delivery.envelopeHashOk ? "verified" : "rejected"}`}>{delivery.envelopeHashOk ? "✓" : "✕"} sha256(envelope from calldata) = accepted hash</span>
        </motion.li>
        <motion.li initial={{ opacity: 0 }} animate={{ opacity: step >= 2 ? 1 : 0.2 }}>
          <span className={`badge ${delivery.keyOk ? "verified" : "rejected"}`}>{delivery.keyOk ? "✓" : "✕"} released key opens the key commitment</span>
        </motion.li>
      </ul>
      {sub.releaseTx && <Hash label="release tx" value={sub.releaseTx} tx />}
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {delivery.files.map((f) => (
          <div key={f.name} className="card" style={{ background: "var(--surface-2)", padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span className="mono">{f.name}</span>
              <button className="ghost" onClick={() => download(f.name, f.content)} disabled={step < 3}>Download</button>
            </div>
            <ScrambleText text={decoder.decode(f.content)} start={step >= 3} durationMs={1600} className="mono" />
          </div>
        ))}
      </div>
    </motion.section>
  );
}
