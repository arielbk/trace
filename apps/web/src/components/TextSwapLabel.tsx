import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";

/**
 * Animates a label between values with the shared `t-text-swap` transition:
 * the old value blurs/lifts out, the new value fades/drops in.
 */
export function TextSwapLabel({ value }: { value: string }) {
  const [displayValue, setDisplayValue] = useState(value);
  const [phase, setPhase] = useState<"idle" | "exit" | "enter">("idle");
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (value === displayValue) return;

    const root = document.documentElement;
    const dur =
      parseFloat(getComputedStyle(root).getPropertyValue("--text-swap-dur")) ||
      150;
    const timer = window.setTimeout(() => {
      setDisplayValue(value);
      setPhase("enter");
    }, dur);

    setPhase("exit");

    return () => window.clearTimeout(timer);
  }, [displayValue, value]);

  useEffect(() => {
    if (phase !== "enter") return;

    const label = labelRef.current;
    if (!label) {
      setPhase("idle");
      return;
    }

    void label.offsetHeight;
    const frame = window.requestAnimationFrame(() => setPhase("idle"));

    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  return (
    <span
      ref={labelRef}
      className={cn(
        "t-text-swap",
        phase === "exit" && "is-exit",
        phase === "enter" && "is-enter-start",
      )}
    >
      {displayValue}
    </span>
  );
}
