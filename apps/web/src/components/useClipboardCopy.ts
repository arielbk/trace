import { useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a brief `copied` flag that auto-resets after
 * `resetMs`. Clipboard failures (insecure context, denied permission) are
 * swallowed so the flag still flips and the interaction feels responsive.
 *
 * Shared by the copy chip and the board's copy-prompt row action so both
 * affordances confirm a copy the same way.
 */
export function useClipboardCopy(resetMs = 1200): {
  copied: boolean;
  copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard may be unavailable; still surface the confirmation.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), resetMs);
  }

  return { copied, copy };
}
