import { cn } from "../lib/utils.ts";
import { useClipboardCopy } from "./useClipboardCopy.ts";
import { TextSwapLabel } from "./TextSwapLabel.tsx";
import { CopyIcon, CheckIcon } from "./icons.tsx";

/**
 * Pill button that copies `value` to the clipboard, with the shared icon-swap
 * (copy → check) and text-swap (`label` → "Copied") micro-interactions. This
 * is the single building block behind every "copy a prompt/command"
 * affordance — re-enter prompts, resume commands — so they share styling and
 * behavior exactly rather than drifting into look-alike one-offs.
 */
export function CopyPromptButton({
  label,
  copyLabel,
  value,
  className,
}: {
  label: string;
  copyLabel: string;
  value: string;
  className?: string;
}) {
  const { copied, copy } = useClipboardCopy();
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-action-gap px-control-x py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer bg-accent-soft text-accent",
        className,
      )}
      style={{
        border:
          "1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-border))",
      }}
      aria-label={copied ? "Copied" : copyLabel}
      title={value}
      onClick={() => void copy(value)}
    >
      <span
        className="t-icon-swap inline-grid size-icon-inline place-items-center"
        data-state={copied ? "b" : "a"}
        aria-hidden="true"
      >
        <span className="t-icon inline-flex" data-icon="a">
          <CopyIcon />
        </span>
        <span className="t-icon inline-flex" data-icon="b">
          <CheckIcon />
        </span>
      </span>
      <TextSwapLabel value={copied ? "Copied" : label} />
    </button>
  );
}
