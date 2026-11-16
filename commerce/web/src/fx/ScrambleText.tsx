// Ciphertext-to-plaintext decode: every character starts as random hex and resolves left to right.
import { useEffect, useRef, useState } from "react";

const HEX = "0123456789abcdef";
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ScrambleText({ text, durationMs = 1800, start = true, className }: { text: string; durationMs?: number; start?: boolean; className?: string }) {
  const [shown, setShown] = useState(() => (start ? "" : scramble(text, 0)));
  const raf = useRef(0);

  useEffect(() => {
    if (!start) {
      setShown(scramble(text, 0));
      return;
    }
    if (reduced()) {
      setShown(text);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      setShown(scramble(text, p));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [text, durationMs, start]);

  return (
    <pre className={className} aria-label={start ? text : "encrypted"} style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {shown}
    </pre>
  );
}

/** Characters before the progress front are real; the rest are random hex (whitespace is kept for shape). */
function scramble(text: string, progress: number): string {
  const front = Math.floor(text.length * progress);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    out += i < front || c === "\n" || c === " " ? c : HEX[(Math.random() * 16) | 0];
  }
  return out;
}
