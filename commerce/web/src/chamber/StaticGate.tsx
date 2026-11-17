// Reduced-motion and no-WebGL fallback: the same gate state as a still drawing, no travel or shaking.
import type { GateState } from "./ProofChamber";

const HEADER: Record<GateState, string> = { idle: "#dfe8cf", locked: "#dfe8cf", accepted: "#c6ed91", open: "#c6ed91", rejected: "#f0ae94" };

export function StaticGate({ gate }: { gate: GateState }) {
  const open = gate === "open";
  const bars = Array.from({ length: 9 }, (_, k) => k);
  return (
    <svg className="static-gate" viewBox="0 0 800 420" role="img" aria-label={`Gate ${open ? "open" : gate === "rejected" ? "closed, check failed" : "closed"}`}>
      <polygon points="90,300 420,140 720,250 390,410" fill="#1e4a35" stroke="#8fae6e" strokeWidth="4" />
      <ellipse cx="560" cy="300" rx="95" ry="48" fill={open ? "#4d8a3f" : "#2b6140"} stroke="#dfe8cf" strokeWidth="3" />
      {/* glyphs: left of the gate while closed, on the pad when open */}
      {Array.from({ length: 12 }, (_, i) => {
        const cx = open ? 520 + (i % 4) * 26 : 210 + (i % 4) * 26;
        const cy = open ? 285 + Math.floor(i / 4) * 16 : 280 - Math.floor(i / 4) * 18 + (i % 4) * 4;
        return <circle key={i} cx={cx} cy={cy} r="12" fill={i % 3 ? "#cfe0bd" : "#7fae5a"} />;
      })}
      <g transform="translate(330,120)">
        <rect x="0" y="0" width="16" height="190" fill="#6f8f57" />
        <rect x="150" y="70" width="16" height="190" fill="#6f8f57" />
        {!open && bars.map((k) => <line key={k} x1={20 + k * 15} y1={18 + k * 7.6} x2={20 + k * 15} y2={180 + k * 7.6} stroke="#b9cc9c" strokeWidth="6" />)}
        <polygon points="0,-4 166,66 166,80 0,10" fill={HEADER[gate]} />
      </g>
    </svg>
  );
}
