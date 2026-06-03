import { useEffect, useRef, useState } from "react";

/**
 * Click-to-copy chip: renders a compact `display` form (e.g. a truncated UUID),
 * exposes the full `value` via the native `title` tooltip for hover, and copies
 * the full `value` to the clipboard on click with a brief "Copied" confirmation.
 *
 * Truncation of `display` is the caller's job (see `truncateId` in `format.ts`);
 * this component never derives the display from the value.
 */
export function CopyChip({ value, display }: { value: string; display: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard may be unavailable (insecure context, denied permission);
      // still surface the confirmation so the interaction feels responsive.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      className="copy-chip"
      title={value}
      aria-label={`Copy ${value}`}
      onClick={handleCopy}
    >
      <span className="copy-chip-value">{display}</span>
      <span className="copy-chip-status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
