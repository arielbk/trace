import { readFileSync } from "node:fs";
import { emptyTokenTotals } from "./token-totals.ts";
import { isObject, textFromContent, type TranscriptMessage } from "./transcript-messages.ts";
import type { TokenTotals } from "./types.ts";

export type ParsedCopilotSession = {
  id: string;
  transcriptPath: string;
  tool: "copilot";
  model: string | null;
  title: null;
  tokenTotals: TokenTotals;
};

type CopilotEvent = {
  type?: unknown;
  data?: unknown;
  sessionId?: unknown;
  model?: unknown;
  content?: unknown;
  outputTokens?: unknown;
};

/** Parse Copilot CLI's append-only `events.jsonl` transcript. */
export function parseCopilotTranscript(input: {
  transcript: string;
  transcriptPath: string;
}): ParsedCopilotSession {
  let id: string | undefined;
  let model: string | undefined;
  let outputTokens = 0;

  forEachCopilotEvent(input.transcript, (event) => {
    const data = eventData(event);
    if (event.type === "session.start") {
      id ??= stringValue(data.sessionId) ?? stringValue(event.sessionId);
    }
    if (event.type === "assistant.message") {
      model ??= stringValue(data.model) ?? stringValue(event.model);
      outputTokens += numberValue(data.outputTokens) ?? numberValue(event.outputTokens) ?? 0;
    }
    if (event.type === "session.auto_mode_resolved") {
      model ??= stringValue(data.model) ?? stringValue(event.model);
    }
  });

  if (!id) {
    throw new Error("Copilot transcript does not include a session.start id");
  }

  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "copilot",
    model: model ?? null,
    title: null,
    tokenTotals: { ...emptyTokenTotals(), outputTokens, totalTokens: outputTokens },
  };
}

export function parseCopilotTranscriptFile(transcriptPath: string): ParsedCopilotSession {
  return parseCopilotTranscript({
    transcript: readFileSync(transcriptPath, "utf8"),
    transcriptPath,
  });
}

export function headCopilotTranscript(input: {
  transcript: string;
  limit?: number | undefined;
}): TranscriptMessage[] {
  return copilotMessages(input.transcript).filter((message) => message.role === "user").slice(0, limitFor(input.limit));
}

export function tailCopilotTranscript(input: {
  transcript: string;
  limit?: number | undefined;
}): TranscriptMessage[] {
  return copilotMessages(input.transcript).slice(-limitFor(input.limit));
}

function copilotMessages(transcript: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  forEachCopilotEvent(transcript, (event) => {
    const data = eventData(event);
    const role = event.type === "user.message" ? "user" : event.type === "assistant.message" ? "assistant" : undefined;
    const text = textFromContent(data.content ?? event.content);
    if (role && text) messages.push({ role, text });
  });
  return messages;
}

function forEachCopilotEvent(transcript: string, visit: (event: CopilotEvent) => void): void {
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isObject(event)) visit(event as CopilotEvent);
    } catch {
      // A live JSONL file can contain an incomplete final write.
    }
  }
}

function eventData(event: CopilotEvent): Record<string, unknown> {
  return isObject(event.data) ? event.data : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function limitFor(limit: number | undefined): number {
  return Number.isInteger(limit) && limit !== undefined && limit > 0 ? limit : 8;
}
