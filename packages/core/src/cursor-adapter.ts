import { readComposer, readComposerTail } from "@trace/cursor-reader";
import type { CursorMessage, CursorSession } from "@trace/cursor-reader";
import { emptyTokenTotals } from "./token-totals.ts";
import type { TranscriptMessage } from "./transcript-messages.ts";
import type {
  ParsedTranscript,
  ReadTranscriptHeadInput,
  ReadTranscriptTailInput,
  TranscriptAdapter,
  TranscriptHeadInput,
  TranscriptParseInput,
  TranscriptTailInput,
} from "./transcript-adapter.ts";
import type { TokenTotals } from "./types.ts";

// Cursor has no on-disk transcript file — sessions live in its state.vscdb
// SQLite store, keyed by composerId. So both the `transcript` and
// `transcriptPath` slots carry the same opaque locator, `cursor:<composerId>`
// (a bare composerId is also accepted), and every entry point resolves through
// @trace/cursor-reader rather than a string/file. This module is the only place
// the reader's neutral vocabulary (CursorSession/CursorMessage) meets trace's
// transcript vocabulary.
const CURSOR_LOCATOR_PREFIX = "cursor:";
const DEFAULT_TAIL_LIMIT = 8;

function composerIdFromLocator(locator: string): string {
  return locator.startsWith(CURSOR_LOCATOR_PREFIX)
    ? locator.slice(CURSOR_LOCATOR_PREFIX.length)
    : locator;
}

/** Widen the reader's `{inputTokens, outputTokens} | null` to a `TokenTotals`. */
function tokenTotalsFromCursor(
  totals: CursorSession["tokenTotals"],
): TokenTotals {
  if (!totals) return emptyTokenTotals();
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: totals.inputTokens + totals.outputTokens,
  };
}

function parsedFromSession(
  session: CursorSession,
  transcriptPath: string,
): ParsedTranscript {
  return {
    id: session.composerId,
    transcriptPath,
    tool: "cursor",
    model: session.model,
    tokenTotals: tokenTotalsFromCursor(session.tokenTotals),
    contextTokens: session.contextTokens,
  };
}

/**
 * Project a neutral `CursorMessage` to a `TranscriptMessage`: `thinking`
 * collapses into the assistant turn, and a `tool` call is synthesized into a
 * single readable assistant line so it isn't invisible in the tail.
 */
function messageFromCursor(message: CursorMessage): TranscriptMessage {
  switch (message.kind) {
    case "user":
      return { role: "user", text: message.text };
    case "assistant":
    case "thinking":
      return { role: "assistant", text: message.text };
    case "tool":
      return {
        role: "assistant",
        text: message.status
          ? `[tool: ${message.name} (${message.status})]`
          : `[tool: ${message.name}]`,
      };
  }
}

function cursorTail(locator: string, limit: number | undefined): TranscriptMessage[] {
  const bounded = typeof limit === "number" && limit > 0 ? limit : DEFAULT_TAIL_LIMIT;
  return readComposerTail(composerIdFromLocator(locator), bounded).map(
    messageFromCursor,
  );
}

// The composer's own title is the natural session name, so head/readHead read
// it through the reader (a single keyed lookup, no bubble scan) rather than the
// first user message. Best-effort: a missing composer yields no messages.
function cursorHead(locator: string): TranscriptMessage[] {
  let session: CursorSession;
  try {
    session = readComposer(composerIdFromLocator(locator));
  } catch {
    return [];
  }
  const title = session.title?.trim();
  return title ? [{ role: "user", text: title }] : [];
}

export const cursorTranscriptAdapter: TranscriptAdapter = {
  tool: "cursor",
  parse(input: TranscriptParseInput): ParsedTranscript {
    return parsedFromSession(
      readComposer(composerIdFromLocator(input.transcriptPath)),
      input.transcriptPath,
    );
  },
  parseFile(transcriptPath: string): ParsedTranscript {
    return parsedFromSession(
      readComposer(composerIdFromLocator(transcriptPath)),
      transcriptPath,
    );
  },
  head(input: TranscriptHeadInput): TranscriptMessage[] {
    return cursorHead(input.transcript);
  },
  readHead(input: ReadTranscriptHeadInput): TranscriptMessage[] {
    return cursorHead(input.transcriptPath);
  },
  tail(input: TranscriptTailInput): TranscriptMessage[] {
    return cursorTail(input.transcript, input.limit);
  },
  readTail(input: ReadTranscriptTailInput): TranscriptMessage[] {
    return cursorTail(input.transcriptPath, input.limit);
  },
};
