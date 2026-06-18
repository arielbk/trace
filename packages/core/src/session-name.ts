import { getTranscriptAdapter } from "./transcript-adapter.ts";
import type { TranscriptMessage } from "./transcript-messages.ts";
import type { Session, SessionTool } from "./types.ts";

const SESSION_NAME_MAX_LENGTH = 60;

/**
 * The single place session display-name precedence lives: the conversation
 * `title` Claude wrote into the transcript wins; absent that, fall back to the
 * first-line synthesis of the transcript. Both the web timeline and the CLI
 * session summary resolve names through here so the rule is never duplicated.
 */
export function resolveSessionName(
  session: Pick<Session, "title" | "transcriptPath" | "tool">,
): string | null {
  if (session.title) return session.title;
  return readSessionName(session.transcriptPath, session.tool);
}

export function deriveSessionName(
  transcript: string,
  tool: SessionTool = "claude",
): string | null {
  return nameFromHead(getTranscriptAdapter(tool).head({ transcript }));
}

export function readSessionName(
  transcriptPath: string,
  tool: SessionTool = "claude",
): string | null {
  return nameFromHead(getTranscriptAdapter(tool).readHead({ transcriptPath }));
}

/**
 * Apply the naming policy to the first user messages of a transcript: clean each
 * candidate in order and return the first that survives, capped at the max
 * length. The tool-specific job of finding those messages lives behind the
 * transcript adapter seam — this module owns only the policy.
 */
function nameFromHead(messages: TranscriptMessage[]): string | null {
  for (const message of messages) {
    const cleaned = cleanMessageText(message.text);
    if (!cleaned) continue;

    return cleaned.length > SESSION_NAME_MAX_LENGTH
      ? cleaned.slice(0, SESSION_NAME_MAX_LENGTH) + "…"
      : cleaned;
  }

  return null;
}

/**
 * Reduce a raw user message to a human-readable name, or null when it carries
 * no usable text. Slash-command invocations are recorded by Claude Code as
 * `<command-name>/foo</command-name>` with the human's actual prompt in
 * `<command-args>…</command-args>` — so for those we surface the args text
 * (the meaningful part) rather than the noisy command tags, and skip the
 * message entirely when the command carried no args.
 */
function cleanMessageText(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed.includes("<command-name>")) {
    const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1];
    const cleanedArgs = args?.trim();
    return cleanedArgs && cleanedArgs.length > 0 ? cleanedArgs : null;
  }

  if (trimmed.startsWith("/")) return null;
  if (trimmed.includes("<system-reminder")) return null;
  if (trimmed.includes("<local-command")) return null;

  return trimmed;
}
