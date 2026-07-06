import type { Session } from "@trace/core/browser";

// Cursor sessions split by flavor: a cursor-agent (CLI) chat carries its JSONL
// transcript path and resumes with `cursor-agent --resume`; a GUI composer
// (opaque `cursor:<id>` locator) has no CLI resume command — re-entry happens
// inside the Cursor app — so it yields null and the copy button stays hidden.
export function resumeCommand(
  session: Pick<Session, "tool" | "id" | "transcriptPath">,
): string | null {
  if (session.tool === "codex") return `codex resume ${session.id}`;
  if (session.tool === "cursor") {
    return session.transcriptPath.endsWith(".jsonl")
      ? `cursor-agent --resume ${session.id}`
      : null;
  }
  return `claude --resume ${session.id}`;
}
