import {
  chatIdFromTranscriptPath,
  readAgentSession,
  readAgentTranscriptMessages,
  readComposer,
  readComposerTail,
} from "@trace/cursor-reader";
import type { CursorMessage, CursorSession } from "@trace/cursor-reader";
import { emptyTokenTotals } from "./token-totals.ts";
import {
  composerIdFromLocator,
  cursorLocatorFlavor,
} from "./transcript-locator.ts";
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

// The two cursor locator flavors (GUI composer vs cursor-agent CLI chat) are
// defined in transcript-locator.ts. A chatId shares the composer keyspace, so
// an agent-transcript chat is still enriched from state.vscdb when a composer
// record exists (current GUI builds mirror every chat to JSONL too); a
// record-less chat parses from the JSONL alone.
//
// Every entry point resolves through @trace/cursor-reader rather than a
// string/file. This module is the only place the reader's neutral vocabulary
// (CursorSession/CursorMessage) meets trace's transcript vocabulary.
const DEFAULT_TAIL_LIMIT = 8;

function isAgentTranscriptLocator(locator: string): boolean {
  return cursorLocatorFlavor(locator) === "agent-transcript";
}

function readSessionForLocator(locator: string): CursorSession {
  if (!isAgentTranscriptLocator(locator)) {
    return readComposer(composerIdFromLocator(locator));
  }
  const chatId = chatIdFromTranscriptPath(locator);
  try {
    return readComposer(chatId);
  } catch {
    return readAgentSession(locator);
  }
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
    title: session.title?.trim() || null,
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
  if (isAgentTranscriptLocator(locator)) {
    return readAgentTranscriptMessages(locator)
      .slice(-bounded)
      .map(messageFromCursor);
  }
  return readComposerTail(composerIdFromLocator(locator), bounded).map(
    messageFromCursor,
  );
}

// The composer's own title is the natural session name, so head/readHead read
// it through the reader (a single keyed lookup, no bubble scan) rather than the
// first user message. An agent-transcript chat with no composer record has no
// title, so its first user message stands in — the same signal the claude/codex
// adapters name sessions from. Best-effort: a missing session yields no messages.
function cursorHead(locator: string): TranscriptMessage[] {
  let session: CursorSession;
  try {
    session = readSessionForLocator(locator);
  } catch {
    return [];
  }
  const title = session.title?.trim();
  if (title) return [{ role: "user", text: title }];
  if (isAgentTranscriptLocator(locator)) {
    const firstUser = readAgentTranscriptMessages(locator).find(
      (message) => message.kind === "user",
    );
    if (firstUser && firstUser.kind === "user") {
      return [{ role: "user", text: firstUser.text }];
    }
  }
  return [];
}

export const cursorTranscriptAdapter: TranscriptAdapter = {
  tool: "cursor",
  parse(input: TranscriptParseInput): ParsedTranscript {
    return parsedFromSession(
      readSessionForLocator(input.transcriptPath),
      input.transcriptPath,
    );
  },
  parseFile(transcriptPath: string): ParsedTranscript {
    return parsedFromSession(
      readSessionForLocator(transcriptPath),
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
