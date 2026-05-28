import { readFileSync } from "node:fs";

export type ClaudeCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

export type ParsedClaudeCodeSession = {
  id: string;
  transcriptPath: string;
  tool: "claude";
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
    usage?: ClaudeUsage;
  };
};

export function parseClaudeCodeTranscript(input: ClaudeCodeTranscriptInput): ParsedClaudeCodeSession {
  let id: string | undefined;
  const tokenTotals: ClaudeCodeTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };

  for (const line of input.transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const event = JSON.parse(line) as ClaudeJsonlEvent;
    id ??= event.session_id ?? event.sessionId ?? event.message?.session_id ?? event.message?.sessionId;

    addUsage(tokenTotals, event.usage);
    addUsage(tokenTotals, event.message?.usage);
  }

  if (!id) {
    throw new Error("Claude Code transcript does not include a session id");
  }

  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "claude",
    tokenTotals,
  };
}

export function parseClaudeCodeTranscriptFile(transcriptPath: string): ParsedClaudeCodeSession {
  return parseClaudeCodeTranscript({
    transcript: readFileSync(transcriptPath, "utf8"),
    transcriptPath,
  });
}

function addUsage(tokenTotals: ClaudeCodeTokenTotals, usage: ClaudeUsage | undefined): void {
  if (!usage) {
    return;
  }

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;

  tokenTotals.inputTokens += inputTokens;
  tokenTotals.outputTokens += outputTokens;
  tokenTotals.cacheCreationInputTokens += cacheCreationInputTokens;
  tokenTotals.cacheReadInputTokens += cacheReadInputTokens;
  tokenTotals.totalTokens +=
    usage.total_tokens ?? inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
}
