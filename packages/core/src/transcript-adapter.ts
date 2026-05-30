import { readFileSync } from "node:fs";
import {
  parseClaudeCodeTranscript,
  parseClaudeCodeTranscriptFile,
  tailClaudeCodeTranscript,
} from "./claude-code-adapter.ts";
import {
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

/**
 * The one place that knows, per `SessionTool`, how to read session identity,
 * model, token totals, and the message tail out of a transcript. Callers
 * consult `getTranscriptAdapter(tool)` instead of importing per-tool free
 * functions and re-branching on the tool string.
 */
export type TranscriptAdapter = {
  readonly tool: SessionTool;
  parse(input: TranscriptParseInput): ParsedTranscript;
  parseFile(
    transcriptPath: string,
    options?: { expectedId?: string | undefined },
  ): ParsedTranscript;
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
  tail(input) {
    return tailClaudeCodeTranscript(input);
  },
  readTail(input) {
    return readTail(input, tailClaudeCodeTranscript);
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
  tail(input) {
    return tailCodexTranscript(input);
  },
  readTail(input) {
    return readTail(input, tailCodexTranscript);
  },
};

const adaptersByTool: Record<SessionTool, TranscriptAdapter> = {
  claude: claudeTranscriptAdapter,
  codex: codexTranscriptAdapter,
};

export function getTranscriptAdapter(tool: SessionTool): TranscriptAdapter {
  return adaptersByTool[tool];
}

function readTail(
  input: ReadTranscriptTailInput,
  tail: (tailInput: TranscriptTailInput) => TranscriptMessage[],
): TranscriptMessage[] {
  try {
    return tail({
      transcript: readFileSync(input.transcriptPath, "utf8"),
      limit: input.limit,
    });
  } catch {
    return [];
  }
}
