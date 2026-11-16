// A truncated monospace hash with copy and (for transactions) an explorer link.
import { useState } from "react";
import { explorerTx } from "../lib/chain";

export function Hash({ label, value, tx = false }: { label?: string; value: string; tx?: boolean }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable
    }
  };
  return (
    <span className="hash" title={value}>
      {label && <span className="faint">{label}</span>}
      {tx ? (
        <a href={explorerTx(value)} target="_blank" rel="noreferrer">{short} ↗</a>
      ) : (
        <span>{short}</span>
      )}
      <button onClick={() => void copy()} aria-label={`Copy ${label ?? "value"}`}>{copied ? "copied" : "copy"}</button>
    </span>
  );
}
