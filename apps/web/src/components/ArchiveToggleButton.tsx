import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { TextSwapLabel } from "./TextSwapLabel.tsx";
import { ArchiveIcon, SuccessCheckIcon, UnarchiveIcon } from "./icons.tsx";

const FLASH_MS = 1100;

/**
 * Labeled archive / unarchive button for the task detail header. Shares the
 * task-list buttons' look and adds matching micro-interactions: a colour
 * transition on hover, an icon swap to an animated success check on click, and
 * a text swap as the label flips between Archive and Unarchive.
 */
export function ArchiveToggleButton({
  isArchived,
  onToggle,
  className,
}: {
  isArchived: boolean;
  onToggle: () => void | Promise<void>;
  className?: string;
}) {
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    };
  }, []);

  function handleClick() {
    setFlash(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlash(false);
    }, FLASH_MS);
    void Promise.resolve(onToggle()).catch(() => setFlash(false));
  }

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface text-text-muted text-xs font-semibold cursor-pointer transition-colors hover:text-accent hover:border-border-strong",
        flash && "text-accent border-border-strong bg-accent-soft",
        className,
      )}
      aria-label={isArchived ? "Unarchive task" : "Archive task"}
      onClick={handleClick}
    >
      <span
        className="t-icon-swap inline-grid size-icon-inline place-items-center"
        data-state={flash ? "b" : "a"}
        aria-hidden="true"
      >
        <span className="t-icon inline-flex" data-icon="a">
          {isArchived ? <UnarchiveIcon size={13} /> : <ArchiveIcon size={13} />}
        </span>
        <span className="t-icon inline-flex" data-icon="b">
          <SuccessCheckIcon shown={flash} />
        </span>
      </span>
      <TextSwapLabel value={isArchived ? "Unarchive" : "Archive"} />
    </button>
  );
}
