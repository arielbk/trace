export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

export type JsonObject = Record<string, unknown>;

/**
 * Shared tail harness: walk a JSONL transcript, extract one message per event
 * with the tool-specific `extract` strategy, and return the last `limit`
 * messages in order. Any parse failure yields an empty tail, matching the
 * "best effort, never throw" contract the tail callers rely on.
 */
export function collectTranscriptTail(
  transcript: string,
  limit: number | undefined,
  extract: (event: JsonObject) => TranscriptMessage | null,
): TranscriptMessage[] {
  const normalizedLimit = normalizeLimit(limit);
  const messages: TranscriptMessage[] = [];

  try {
    for (const line of transcript.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }

      const event = JSON.parse(line) as unknown;
      if (!isObject(event)) {
        continue;
      }

      const message = extract(event);
      if (message) {
        messages.push(message);
      }
    }
  } catch {
    return [];
  }

  return messages.slice(-normalizedLimit);
}

/**
 * Shared head harness: the counterpart to `collectTranscriptTail`. Walk a JSONL
 * transcript from the top, extract one message per event with the tool-specific
 * `extract` strategy, and return the first `limit` **user** messages in order —
 * short-circuiting once the cap is reached so a large transcript isn't parsed to
 * completion. Same "best effort, never throw → empty result" contract as the
 * tail harness.
 */
export function collectTranscriptHead(
  transcript: string,
  limit: number | undefined,
  extract: (event: JsonObject) => TranscriptMessage | null,
): TranscriptMessage[] {
  const normalizedLimit = normalizeLimit(limit);
  const messages: TranscriptMessage[] = [];

  try {
    for (const line of transcript.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }

      const event = JSON.parse(line) as unknown;
      if (!isObject(event)) {
        continue;
      }

      const message = extract(event);
      if (message?.role === "user") {
        messages.push(message);
        if (messages.length >= normalizedLimit) {
          break;
        }
      }
    }
  } catch {
    return [];
  }

  return messages;
}

function normalizeLimit(limit: number | undefined): number {
  return Number.isInteger(limit) && limit !== undefined && limit > 0
    ? limit
    : 8;
}

export function normalizeRole(
  role: unknown,
): TranscriptMessage["role"] | undefined {
  if (role === "human" || role === "user") {
    return "user";
  }

  if (role === "assistant") {
    return "assistant";
  }

  return undefined;
}

export function textFromContent(content: unknown): string | undefined {
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

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
