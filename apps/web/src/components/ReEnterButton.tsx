import { cn } from "../lib/utils.ts";
import { buildReEnterPrompt } from "../format.ts";
import { useClipboardCopy } from "./useClipboardCopy.ts";
import { TextSwapLabel } from "./TextSwapLabel.tsx";
import { ArrowIcon, CheckIcon } from "./icons.tsx";

/**
 * Copies the re-enter prompt for a task, with the shared icon-swap (arrow →
 * check) and text-swap (Re-enter → Copied) micro-interactions. Used by both the
 * task list rows and the task detail header so the affordance feels identical.
 */
export function ReEnterButton({
  title,
  slug,
  className,
}: {
  title: string;
  slug: string;
  className?: string;
}) {
  const { copied, copy } = useClipboardCopy();
  const prompt = buildReEnterPrompt(title, slug);
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
      aria-label={copied ? "Copied" : "Copy re-enter prompt"}
      title={prompt}
      onClick={() => void copy(prompt)}
    >
      <span
        className="t-icon-swap inline-grid size-icon-inline place-items-center"
        data-state={copied ? "b" : "a"}
        aria-hidden="true"
      >
        <span className="t-icon inline-flex" data-icon="a">
          <ArrowIcon />
        </span>
        <span className="t-icon inline-flex" data-icon="b">
          <CheckIcon />
        </span>
      </span>
      <TextSwapLabel value={copied ? "Copied" : "Re-enter"} />
    </button>
  );
}
