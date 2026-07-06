import type { Session } from "@trace/core/browser";

// Cursor (GUI) sessions have no CLI resume command — re-entry happens inside
// the Cursor app — so they yield null and the copy button stays hidden.
export function resumeCommand(
  session: Pick<Session, "tool" | "id">,
): string | null {
  if (session.tool === "codex") return `codex resume ${session.id}`;
  if (session.tool === "cursor") return null;
  return `claude --resume ${session.id}`;
}
