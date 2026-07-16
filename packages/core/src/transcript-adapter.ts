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
  type CodexSubagentSpawn,
} from "./codex-adapter.ts";
import {
  headCopilotTranscript,
  parseCopilotTranscript,
  parseCopilotTranscriptFile,
  tailCopilotTranscript,
} from "./copilot-adapter.ts";
import { cursorTranscriptAdapter } from "./cursor-adapter.ts";
import type { TranscriptMessage } from "./transcript-messages.ts";
import type { ContextTokens, SessionTool, TokenTotals } from "./types.ts";

export type ParsedTranscript = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model: string | null;
  title: string | null;
  tokenTotals: TokenTotals;
  // Live context-window occupancy when the tool exposes it (Cursor); absent
  // otherwise. Not persisted — surfaced through to the refreshed session.
  contextTokens?: ContextTokens | null;
  // Parent-side in-process subagent spawn records when the tool logs them in
  // the transcript itself (Codex `collab_agent_spawn_end`); absent for tools
  // whose linkage needs out-of-band correlation. Rides along on the parse so
  // the store's read-time discovery costs no extra I/O.
  subagentSpawns?: CodexSubagentSpawn[];
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

const copilotTranscriptAdapter: TranscriptAdapter = {
  tool: "copilot",
  parse(input) {
    return parseCopilotTranscript(input);
  },
  parseFile(transcriptPath) {
    return parseCopilotTranscriptFile(transcriptPath);
  },
  head(input) {
    return headCopilotTranscript(input);
  },
  readHead(input) {
    return readFromFile(input, headCopilotTranscript);
  },
  tail(input) {
    return tailCopilotTranscript(input);
  },
  readTail(input) {
    return readFromFile(input, tailCopilotTranscript);
  },
};

// Partial because the tool axis (`SessionTool`) can carry tools whose adapter
// has not landed yet. `getTranscriptAdapter` throws for an unregistered tool
// rather than returning undefined, preserving the non-null contract callers
// rely on.
const adaptersByTool: Partial<Record<SessionTool, TranscriptAdapter>> = {
  claude: claudeTranscriptAdapter,
  codex: codexTranscriptAdapter,
  copilot: copilotTranscriptAdapter,
  cursor: cursorTranscriptAdapter,
};

export function getTranscriptAdapter(tool: SessionTool): TranscriptAdapter {
  const adapter = adaptersByTool[tool];
  if (!adapter) {
    throw new Error(`No transcript adapter registered for tool "${tool}"`);
  }
  return adapter;
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
