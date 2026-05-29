import { readFileSync } from "node:fs";
import type { SessionTool } from "./types.ts";

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

export type TranscriptTailInput = {
  transcript: string;
  tool: SessionTool;
  limit?: number | undefined;
};

export type ReadTranscriptTailInput = {
  transcriptPath: string;
  tool: SessionTool;
  limit?: number | undefined;
};

type JsonObject = Record<string, unknown>;

export function readTranscriptTail(
  input: ReadTranscriptTailInput,
): TranscriptMessage[] {
  try {
    return tailTranscriptMessages({
      transcript: readFileSync(input.transcriptPath, "utf8"),
      tool: input.tool,
      limit: input.limit,
    });
  } catch {
    return [];
  }
}

export function tailTranscriptMessages(
  input: TranscriptTailInput,
): TranscriptMessage[] {
  const limit = normalizeLimit(input.limit);
  const messages: TranscriptMessage[] = [];

  try {
    for (const line of input.transcript.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }

      const event = JSON.parse(line) as unknown;
      if (!isObject(event)) {
        continue;
      }

      const message =
        input.tool === "claude"
          ? messageFromClaudeEvent(event)
          : messageFromCodexEvent(event);

      if (message) {
        messages.push(message);
      }
    }
  } catch {
    return [];
  }

  return messages.slice(-limit);
}

function normalizeLimit(limit: number | undefined): number {
  return Number.isInteger(limit) && limit !== undefined && limit > 0
    ? limit
    : 8;
}

function messageFromClaudeEvent(event: JsonObject): TranscriptMessage | null {
  const message = isObject(event.message) ? event.message : undefined;
  const role = normalizeRole(event.type) ?? normalizeRole(message?.role);
  if (!role) {
    return null;
  }

  const text = textFromContent(message?.content ?? event.content);
  return text ? { role, text } : null;
}

function messageFromCodexEvent(event: JsonObject): TranscriptMessage | null {
  const type = typeof event.type === "string" ? event.type : "";
  const role =
    normalizeRole(event.role) ??
    (type === "turn.started" || type === "user_message" ? "user" : undefined) ??
    (type === "agent_message" || type === "assistant_message"
      ? "assistant"
      : undefined);

  if (!role) {
    return null;
  }

  const text = textFromContent(
    event.message ?? event.prompt ?? event.content ?? event.text,
  );
  return text ? { role, text } : null;
}

function normalizeRole(role: unknown): TranscriptMessage["role"] | undefined {
  if (role === "human" || role === "user") {
    return "user";
  }

  if (role === "assistant") {
    return "assistant";
  }

  return undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return normalizedText(content);
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (isObject(part) && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .filter((part) => part.trim().length > 0)
      .join("\n");
    return normalizedText(text);
  }

  if (isObject(content) && typeof content.text === "string") {
    return normalizedText(content.text);
  }

  return undefined;
}

function normalizedText(text: string): string | undefined {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
