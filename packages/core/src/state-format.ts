export type StateMdDraft = {
  summary: string;
  currentState?: string;
  nextStep?: string;
};

function isPresent(value: string | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !/^(?:none|n\/a)$/i.test(trimmed);
}

export function formatStateMd(draft: StateMdDraft): string {
  const parts = [`# ${draft.summary.trim()}`, ""];

  if (isPresent(draft.currentState)) {
    parts.push("## Current state", "", draft.currentState.trim(), "");
  }

  if (isPresent(draft.nextStep)) {
    parts.push("## Next step", "", draft.nextStep.trim(), "");
  }

  return `${parts.join("\n").replace(/\n+$/, "\n")}`;
}
