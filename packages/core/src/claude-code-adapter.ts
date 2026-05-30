import { readFileSync } from "node:fs";
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

    const event = JSON.parse(line) as ClaudeJsonlEvent;
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
