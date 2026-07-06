import { cursorLocatorFlavor } from "./transcript-locator.ts";
import type { Session } from "./types.ts";

// The per-tool "how do I get back into this session from a terminal" contract,
// kept next to the other tool seams so callers (the web board's copy chips)
// stay tool-blind. Cursor splits by locator flavor: a cursor-agent (CLI) chat
// resumes with `cursor-agent --resume`; a GUI composer has no CLI resume
// command — re-entry happens inside the Cursor app — so it yields null and the
// copy button stays hidden.
export function resumeCommand(
  session: Pick<Session, "tool" | "id" | "transcriptPath">,
): string | null {
  if (session.tool === "codex") return `codex resume ${session.id}`;
  if (session.tool === "cursor") {
    return cursorLocatorFlavor(session.transcriptPath) === "agent-transcript"
      ? `cursor-agent --resume ${session.id}`
      : null;
  }
  return `claude --resume ${session.id}`;
}
