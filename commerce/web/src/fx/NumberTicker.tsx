// Spring-animated number (balances, cycles). Animates whenever `value` changes.
import { animate, useMotionValue, useTransform, motion } from "motion/react";
import { useEffect } from "react";

export function NumberTicker({ value, format = (n) => Math.round(n).toLocaleString("en-US"), className }: { value: number; format?: (n: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, format);
  useEffect(() => {
    const c = animate(mv, value, { type: "spring", stiffness: 60, damping: 18 });
    return () => c.stop();
  }, [value, mv]);
  return <motion.span className={className}>{text}</motion.span>;
}
