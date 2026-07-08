// Neutral vocabulary returned by the reader. Deliberately NOT trace's
// ParsedTranscript / TranscriptMessage / SessionTool — the adapter shim in
// @trace/core is the only place the two vocabularies meet.

export type CursorSession = {
  composerId: string;
  projectRoot: string | null;
  title: string | null;
  model: string | null;
  createdAt: number | null; // epoch ms (composerData.createdAt)
  lastUpdatedAt: number | null;
  messageCount: number;
  tokenTotals: { inputTokens: number; outputTokens: number } | null;
  // Cursor doesn't persist cumulative input/output spend, but it does record the
  // current context-window occupancy (`contextTokensUsed` of `contextTokenLimit`).
  // A snapshot of the live window, not cumulative spend — null when absent.
  contextTokens: { used: number; limit: number } | null;
};

export type CursorMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; status?: string };

/**
 * Options shared by the reader's entry points. `storageRoot` is what makes the
 * reader testable (point it at a fixture) and, later, cross-OS. It defaults to
 * the macOS Cursor user-storage path.
 */
export type ReaderOptions = {
  storageRoot?: string;
};
