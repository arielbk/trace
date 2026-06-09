import { readFileSync } from "node:fs";
import { isObject, normalizeRole, textFromContent } from "./transcript-messages.ts";

const SESSION_NAME_MAX_LENGTH = 60;

export function deriveSessionName(transcript: string): string | null {
  for (const line of transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isObject(event)) continue;

    const message = isObject(event.message) ? event.message : undefined;
    const role = normalizeRole(event.type) ?? normalizeRole(message?.role);
    if (role !== "user") continue;

    const text = textFromContent(message?.content ?? event.content);
    if (!text) continue;

    const cleaned = cleanMessageText(text);
    if (!cleaned) continue;

    return cleaned.length > SESSION_NAME_MAX_LENGTH
      ? cleaned.slice(0, SESSION_NAME_MAX_LENGTH) + "…"
      : cleaned;
  }

  return null;
}

export function readSessionName(transcriptPath: string): string | null {
  try {
    return deriveSessionName(readFileSync(transcriptPath, "utf8"));
  } catch {
    return null;
  }
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
