// Real elapsed time since an event (the engine reports no progress, so no percentage is ever shown).
import { useEffect, useState } from "react";

export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, []);
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return <span className="mono">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}
