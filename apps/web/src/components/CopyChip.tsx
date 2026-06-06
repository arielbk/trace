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
      className="copy-chip"
      title={value}
      aria-label={`Copy ${value}`}
      onClick={() => void copy(value)}
    >
      <span className="copy-chip-value">{display}</span>
      <span className="copy-chip-status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
