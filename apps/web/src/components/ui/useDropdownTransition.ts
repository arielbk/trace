import { useEffect, useRef, useState } from "react";

/**
 * Drives the board's shared `.t-dropdown` open/close animation for a Radix
 * popover.
 *
 * Opening needs no orchestration: the content mounts straight into the open
 * state and the stylesheet's `@starting-style` block animates it in. Closing is
 * the part React fights us on — Radix unmounts immediately, so the content is
 * force-mounted, flipped to `.is-closing`, and held for as long as
 * `--dropdown-close-dur` says the exit transition lasts.
 *
 * Both the project filter and the account menu open this way, so the timer
 * lives here rather than being re-derived per popover.
 */
export function useDropdownTransition() {
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
    };
  }, []);

  function onOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      setIsClosing(false);
      setOpen(true);
      return;
    }

    if (!open) return;

    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--dropdown-close-dur",
        ),
      ) || 150;

    setIsClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setIsClosing(false);
      setOpen(false);
    }, closeMs);
  }

  return {
    open,
    isClosing,
    /** Pass to `Popover.Root`; keep the content mounted while `mounted`. */
    onOpenChange,
    mounted: open || isClosing,
  };
}
