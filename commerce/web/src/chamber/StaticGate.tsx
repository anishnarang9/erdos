// Reduced-motion and no-WebGL fallback: the same gate state as a still drawing, no travel or shaking.
import type { GateState } from "./ProofChamber";

const HEADER: Record<GateState, string> = { idle: "#cfd3ff", locked: "#cfd3ff", accepted: "#6bffd8", open: "#6bffd8", rejected: "#ff6b8b" };

export function StaticGate({ gate }: { gate: GateState }) {
  const open = gate === "open";
  const bars = Array.from({ length: 9 }, (_, k) => k);
  return (
    <svg className="static-gate" viewBox="0 0 800 420" role="img" aria-label={`Gate ${open ? "open" : gate === "rejected" ? "closed, check failed" : "closed"}`}>
      <polygon points="90,300 420,140 720,250 390,410" fill="#11111f" stroke="#7d8cff" strokeWidth="4" />
      <ellipse cx="560" cy="300" rx="95" ry="48" fill={open ? "#1f6f66" : "#1b1b33"} stroke="#cfd3ff" strokeWidth="3" />
      {/* glyphs: left of the gate while closed, on the pad when open */}
      {Array.from({ length: 12 }, (_, i) => {
        const cx = open ? 520 + (i % 4) * 26 : 210 + (i % 4) * 26;
        const cy = open ? 285 + Math.floor(i / 4) * 16 : 280 - Math.floor(i / 4) * 18 + (i % 4) * 4;
        return <circle key={i} cx={cx} cy={cy} r="12" fill={i % 3 ? "#cfd3ff" : "#a86bff"} />;
      })}
      <g transform="translate(330,120)">
        <rect x="0" y="0" width="16" height="190" fill="#3b3b5c" />
        <rect x="150" y="70" width="16" height="190" fill="#3b3b5c" />
        {!open && bars.map((k) => <line key={k} x1={20 + k * 15} y1={18 + k * 7.6} x2={20 + k * 15} y2={180 + k * 7.6} stroke="#b9bdf0" strokeWidth="6" />)}
        <polygon points="0,-4 166,66 166,80 0,10" fill={HEADER[gate]} />
      </g>
    </svg>
  );
}
