import { useClipboardCopy } from "./useClipboardCopy.ts";

/**
 * Click-to-copy chip: renders a compact `display` form (e.g. a truncated UUID),
 * exposes the full `value` via the native `title` tooltip for hover, and copies
 * the full `value` to the clipboard on click with a brief "Copied" confirmation.
 *
 * Truncation of `display` is the caller's job (see `truncateId` in `format.ts`);
 * this component never derives the display from the value.
 */
export function CopyChip({ value, display }: { value: string; display: string }) {
  const { copied, copy } = useClipboardCopy();

  return (
    <button
      type="button"
      data-testid="copy-chip"
      className="inline-flex items-center gap-2 px-2 py-1 border border-chip-border rounded-sm bg-surface text-chip-text font-mono text-base leading-snug cursor-pointer hover:border-border-strong"
      title={value}
      aria-label={`Copy ${value}`}
      onClick={() => void copy(value)}
    >
      <span>{display}</span>
      <span className="text-accent text-xs font-bold uppercase empty:hidden" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
