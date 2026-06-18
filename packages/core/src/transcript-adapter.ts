import { readFileSync } from "node:fs";
import {
  headClaudeCodeTranscript,
  parseClaudeCodeTranscript,
  parseClaudeCodeTranscriptFile,
  tailClaudeCodeTranscript,
} from "./claude-code-adapter.ts";
import {
  headCodexTranscript,
  parseCodexTranscript,
  parseCodexTranscriptFile,
  tailCodexTranscript,
} from "./codex-adapter.ts";
import type { TranscriptMessage } from "./transcript-messages.ts";
import type { SessionTool, TokenTotals } from "./types.ts";

export type ParsedTranscript = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model: string | null;
  title: string | null;
  tokenTotals: TokenTotals;
};

export type TranscriptParseInput = {
  transcript: string;
  transcriptPath: string;
  expectedId?: string | undefined;
};

export type TranscriptTailInput = {
  transcript: string;
  limit?: number | undefined;
};

export type ReadTranscriptTailInput = {
  transcriptPath: string;
  limit?: number | undefined;
};

export type TranscriptHeadInput = TranscriptTailInput;

export type ReadTranscriptHeadInput = ReadTranscriptTailInput;

/**
 * The one place that knows, per `SessionTool`, how to read session identity,
 * model, token totals, and the message head/tail out of a transcript. Callers
 * consult `getTranscriptAdapter(tool)` instead of importing per-tool free
 * functions and re-branching on the tool string. `head` surfaces the first user
 * messages in order (for session naming); `tail` surfaces the last messages.
 */
export type TranscriptAdapter = {
  readonly tool: SessionTool;
  parse(input: TranscriptParseInput): ParsedTranscript;
  parseFile(
    transcriptPath: string,
    options?: { expectedId?: string | undefined },
  ): ParsedTranscript;
  head(input: TranscriptHeadInput): TranscriptMessage[];
  readHead(input: ReadTranscriptHeadInput): TranscriptMessage[];
  tail(input: TranscriptTailInput): TranscriptMessage[];
  readTail(input: ReadTranscriptTailInput): TranscriptMessage[];
};

const claudeTranscriptAdapter: TranscriptAdapter = {
  tool: "claude",
  parse(input) {
    return parseClaudeCodeTranscript({
      transcript: input.transcript,
      transcriptPath: input.transcriptPath,
    });
  },
  parseFile(transcriptPath) {
    return parseClaudeCodeTranscriptFile(transcriptPath);
  },
  head(input) {
    return headClaudeCodeTranscript(input);
  },
  readHead(input) {
    return readFromFile(input, headClaudeCodeTranscript);
  },
  tail(input) {
    return tailClaudeCodeTranscript(input);
  },
  readTail(input) {
    return readFromFile(input, tailClaudeCodeTranscript);
  },
};

const codexTranscriptAdapter: TranscriptAdapter = {
  tool: "codex",
  parse(input) {
    return parseCodexTranscript({
      transcript: input.transcript,
      transcriptPath: input.transcriptPath,
      expectedThreadId: input.expectedId,
    });
  },
  parseFile(transcriptPath, options) {
    return parseCodexTranscriptFile(transcriptPath, {
      expectedThreadId: options?.expectedId,
    });
  },
  head(input) {
    return headCodexTranscript(input);
  },
  readHead(input) {
    return readFromFile(input, headCodexTranscript);
  },
  tail(input) {
    return tailCodexTranscript(input);
  },
  readTail(input) {
    return readFromFile(input, tailCodexTranscript);
  },
};

const adaptersByTool: Record<SessionTool, TranscriptAdapter> = {
  claude: claudeTranscriptAdapter,
  codex: codexTranscriptAdapter,
};

export function getTranscriptAdapter(tool: SessionTool): TranscriptAdapter {
  return adaptersByTool[tool];
}

function readFromFile(
  input: ReadTranscriptTailInput,
  walk: (walkInput: TranscriptTailInput) => TranscriptMessage[],
): TranscriptMessage[] {
  try {
    return walk({
      transcript: readFileSync(input.transcriptPath, "utf8"),
      limit: input.limit,
    });
  } catch {
    return [];
  }
}
