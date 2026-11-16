// Glowing beams between the panels, fired on stage transitions (money, proof, key). Pure SVG over the stage.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { stageOf, useDemo, type Stage } from "../lib/store";
import { sound } from "./sound";

type Kind = "money" | "proof" | "key" | "fail";
interface Beam {
  id: number;
  kind: Kind;
  from: [number, number];
  to: [number, number];
  delay: number;
  /** Fraction of the path drawn (fail beams stop halfway: nothing reached the chain). */
  reach: number;
}

const BUYER: [number, number] = [36, 52];
const VAULT: [number, number] = [50, 46];
const SOLVER: [number, number] = [64, 52];
const COLOR: Record<Kind, string> = { money: "var(--money)", proof: "var(--verified)", key: "var(--verified)", fail: "var(--rejected)" };

const beamsFor = (to: Stage): Omit<Beam, "id">[] => {
  switch (to) {
    case "funded":
      return [{ kind: "money", from: BUYER, to: VAULT, delay: 0, reach: 1 }];
    case "submitted":
      return [{ kind: "proof", from: SOLVER, to: VAULT, delay: 0, reach: 1 }];
    case "paid":
      // One release receipt carries both; the animation sequences payout then key for readability.
      return [
        { kind: "money", from: VAULT, to: SOLVER, delay: 0, reach: 1 },
        { kind: "key", from: VAULT, to: BUYER, delay: 0.7, reach: 1 },
      ];
    case "refunded":
      return [{ kind: "money", from: VAULT, to: BUYER, delay: 0, reach: 1 }];
    case "rejected":
      return [{ kind: "fail", from: SOLVER, to: VAULT, delay: 0, reach: 0.5 }];
    default:
      return [];
  }
};

let nextId = 1;

export function Beams() {
  const stage = useDemo(stageOf);
  const prev = useRef<Stage>(stage);
  const [beams, setBeams] = useState<Beam[]>([]);

  useEffect(() => {
    if (prev.current === stage) return;
    prev.current = stage;
    const fresh = beamsFor(stage).map((b) => ({ ...b, id: nextId++ }));
    if (fresh.length === 0) return;
    if (stage === "paid") sound.clink();
    if (stage === "rejected") sound.buzz();
    setBeams((bs) => [...bs, ...fresh]);
    const ttl = setTimeout(() => setBeams((bs) => bs.filter((b) => !fresh.includes(b))), 3200);
    return () => clearTimeout(ttl);
  }, [stage]);

  return (
    <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 10 }}>
      <AnimatePresence>
        {beams.map((b) => {
          const d = `M ${b.from[0]} ${b.from[1]} Q 50 ${b.kind === "key" || b.from === VAULT ? 30 : 62} ${b.to[0]} ${b.to[1]}`;
          return (
            <g key={b.id}>
              <motion.path d={d} fill="none" stroke={COLOR[b.kind]} strokeWidth={0.25} strokeOpacity={0.25} vectorEffect="non-scaling-stroke"
                initial={{ pathLength: 0 }} animate={{ pathLength: b.reach }} exit={{ opacity: 0 }} transition={{ delay: b.delay, duration: 1.1, ease: "easeInOut" }} />
              <motion.path d={d} fill="none" stroke={COLOR[b.kind]} strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke"
                style={{ filter: `drop-shadow(0 0 6px ${COLOR[b.kind]})` }}
                initial={{ pathLength: 0.08, pathOffset: 0, opacity: 0 }}
                animate={{ pathOffset: b.reach - 0.08, opacity: [0, 1, 1, b.kind === "fail" ? 0 : 1] }}
                exit={{ opacity: 0 }}
                transition={{ delay: b.delay, duration: 1.1, ease: "easeInOut" }} />
            </g>
          );
        })}
      </AnimatePresence>
    </svg>
  );
}
