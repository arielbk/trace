import { buildReEnterPrompt } from "../format.ts";
import { CopyPromptButton } from "./CopyPromptButton.tsx";

/**
 * Copies the re-enter prompt for a task. A thin skin over `CopyPromptButton`
 * so it looks and behaves identically to every other copy-a-prompt affordance
 * (e.g. the timeline's Resume button) — used by both the task list rows and
 * the task detail header so the affordance feels the same everywhere.
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
  return (
    <CopyPromptButton
      label="Re-enter"
      copyLabel="Copy re-enter prompt"
      value={buildReEnterPrompt(title, slug)}
      className={className}
    />
  );
}
