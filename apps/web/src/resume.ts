import type { Session } from "@trace/core/browser";

export function resumeCommand(session: Pick<Session, "tool" | "id">): string {
  if (session.tool === "codex") return `codex resume ${session.id}`;
  return `claude --resume ${session.id}`;
}
