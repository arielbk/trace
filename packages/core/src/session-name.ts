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
    if (isNoise(text)) continue;

    return text.length > SESSION_NAME_MAX_LENGTH
      ? text.slice(0, SESSION_NAME_MAX_LENGTH) + "…"
      : text;
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

function isNoise(text: string): boolean {
  if (text.startsWith("/")) return true;
  if (text.includes("<system-reminder")) return true;
  return false;
}
