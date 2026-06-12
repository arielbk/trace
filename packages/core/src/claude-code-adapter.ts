import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import {
  collectTranscriptHead,
  collectTranscriptTail,
  isObject,
  normalizeRole,
  textFromContent,
  type JsonObject,
  type TranscriptMessage,
} from "./transcript-messages.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  tokenTotalsFromUsage,
} from "./token-totals.ts";
import type { TokenTotals } from "./types.ts";

export type ClaudeCodeTokenTotals = TokenTotals;

export type ParsedClaudeCodeSession = {
  id: string;
  transcriptPath: string;
  tool: "claude";
  model: string | null;
  tokenTotals: ClaudeCodeTokenTotals;
};

type ClaudeCodeTranscriptInput = {
  transcript: string;
  transcriptPath: string;
};

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
};

type ClaudeJsonlEvent = {
  session_id?: string;
  sessionId?: string;
  usage?: ClaudeUsage;
  message?: {
    session_id?: string;
    sessionId?: string;
    model?: string;
    usage?: ClaudeUsage;
  };
  model?: string;
};

export function parseClaudeCodeTranscript(
  input: ClaudeCodeTranscriptInput,
): ParsedClaudeCodeSession {
  let id: string | undefined;
  let model: string | undefined;
  let tokenTotals = emptyTokenTotals();

  for (const line of input.transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let event: ClaudeJsonlEvent;
    try {
      event = JSON.parse(line) as ClaudeJsonlEvent;
    } catch {
      // Live transcripts routinely end in a half-written line; skip it.
      continue;
    }
    id ??=
      event.session_id ??
      event.sessionId ??
      event.message?.session_id ??
      event.message?.sessionId;
    model ??= event.model ?? event.message?.model;

    tokenTotals = addTokenTotals(
      tokenTotals,
      tokenTotalsFromUsage(event.usage),
    );
    tokenTotals = addTokenTotals(
      tokenTotals,
      tokenTotalsFromUsage(event.message?.usage),
    );
  }

  if (!id) {
    throw new Error("Claude Code transcript does not include a session id");
  }

  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "claude",
    model: model ?? null,
    tokenTotals,
  };
}

export function parseClaudeCodeTranscriptFile(
  transcriptPath: string,
): ParsedClaudeCodeSession {
  return parseClaudeCodeTranscript({
    transcript: readFileSync(transcriptPath, "utf8"),
    transcriptPath,
  });
}

export function scanClaudeCodeSessions(
  projectsRoot: string,
): ParsedClaudeCodeSession[] {
  const sessions: ParsedClaudeCodeSession[] = [];

  for (const transcriptPath of findJsonlFiles(resolve(projectsRoot))) {
    try {
      sessions.push(parseClaudeCodeTranscriptFile(transcriptPath));
    } catch {
      // A transcript without a session id (or otherwise unparseable) can't be
      // registered; skip it rather than aborting the whole backfill.
    }
  }

  return sessions;
}

function findJsonlFiles(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath, { withFileTypes: true })
    .flatMap((entry: Dirent): string[] => {
      const fullPath = join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        return findJsonlFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

export function tailClaudeCodeTranscript(input: {
  transcript: string;
  limit?: number | undefined;
}): TranscriptMessage[] {
  return collectTranscriptTail(
    input.transcript,
    input.limit,
    messageFromClaudeEvent,
  );
}

export function headClaudeCodeTranscript(input: {
  transcript: string;
  limit?: number | undefined;
}): TranscriptMessage[] {
  return collectTranscriptHead(
    input.transcript,
    input.limit,
    messageFromClaudeEvent,
  );
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
