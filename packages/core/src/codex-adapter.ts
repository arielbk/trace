import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  collectTranscriptTail,
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

export type CodexTokenTotals = TokenTotals;

export type ParsedCodexSession = {
  id: string;
  transcriptPath: string;
  tool: "codex";
  model: string | null;
  tokenTotals: CodexTokenTotals;
};

export type CodexTranscriptInput = {
  transcript: string;
  transcriptPath: string;
  expectedThreadId?: string | undefined;
};

type CodexUsage = {
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_creation_input_tokens?: number;
  cacheCreationInputTokens?: number;
  cache_read_input_tokens?: number;
  cacheReadInputTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
};

type CodexJsonlEvent = {
  type?: string;
  thread_id?: string;
  threadId?: string;
  id?: string;
  model?: string;
  usage?: CodexUsage;
  turn?: {
    usage?: CodexUsage;
  };
};

type CodexSessionIndexEntry = {
  thread_id?: string;
  threadId?: string;
  id?: string;
  path?: string;
  transcript_path?: string;
  transcriptPath?: string;
  rollout_path?: string;
  rolloutPath?: string;
};

export function parseCodexTranscript(
  input: CodexTranscriptInput,
): ParsedCodexSession {
  let id: string | undefined;
  let model: string | undefined;
  const filenameId = codexThreadIdFromPath(input.transcriptPath);
  let tokenTotals = emptyTokenTotals();

  for (const line of input.transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let event: CodexJsonlEvent;
    try {
      event = JSON.parse(line) as CodexJsonlEvent;
    } catch {
      // Live transcripts routinely end in a half-written line; skip it.
      continue;
    }

    if (event.type === "thread.started") {
      id ??= event.thread_id ?? event.threadId ?? event.id;
      model ??= event.model;
    }

    if (event.type === "turn.completed") {
      tokenTotals = addTokenTotals(
        tokenTotals,
        tokenTotalsFromUsage(event.usage ?? event.turn?.usage),
      );
    }
  }

  if (!id) {
    throw new Error("Codex transcript does not include a thread.started id");
  }

  if (filenameId && filenameId !== id) {
    throw new Error(
      `Codex transcript id ${id} does not match filename id ${filenameId}`,
    );
  }

  if (input.expectedThreadId && input.expectedThreadId !== id) {
    throw new Error(
      `Codex transcript id ${id} does not match expected thread id ${input.expectedThreadId}`,
    );
  }

  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "codex",
    model: model ?? null,
    tokenTotals,
  };
}

export function parseCodexTranscriptFile(
  transcriptPath: string,
  options: { expectedThreadId?: string | undefined } = {},
): ParsedCodexSession {
  return parseCodexTranscript({
    transcript: readFileSync(transcriptPath, "utf8"),
    transcriptPath,
    expectedThreadId: options.expectedThreadId,
  });
}

export function tailCodexTranscript(input: {
  transcript: string;
  limit?: number | undefined;
}): TranscriptMessage[] {
  return collectTranscriptTail(
    input.transcript,
    input.limit,
    messageFromCodexEvent,
  );
}

function messageFromCodexEvent(event: JsonObject): TranscriptMessage | null {
  const type = typeof event.type === "string" ? event.type : "";
  const role =
    normalizeRole(event.role) ??
    (type === "turn.started" || type === "user_message" ? "user" : undefined) ??
    (type === "agent_message" || type === "assistant_message"
      ? "assistant"
      : undefined);

  if (!role) {
    return null;
  }

  const text = textFromContent(
    event.message ?? event.prompt ?? event.content ?? event.text,
  );
  return text ? { role, text } : null;
}

export function scanCodexSessions(codexHome: string): ParsedCodexSession[] {
  const root = resolve(codexHome);
  const indexedPaths = readCodexSessionIndex(root);
  const transcriptPaths =
    indexedPaths.length > 0
      ? indexedPaths
      : findJsonlFiles(join(root, "sessions"));

  return transcriptPaths.map((entry) =>
    parseCodexTranscriptFile(entry.transcriptPath, {
      expectedThreadId: entry.expectedThreadId,
    }),
  );
}

function readCodexSessionIndex(
  codexHome: string,
): Array<{ transcriptPath: string; expectedThreadId?: string }> {
  const indexPath = join(codexHome, "session_index.jsonl");

  if (!existsSync(indexPath)) {
    return [];
  }

  return readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry = JSON.parse(line) as CodexSessionIndexEntry;
      const rawPath =
        entry.path ??
        entry.transcript_path ??
        entry.transcriptPath ??
        entry.rollout_path ??
        entry.rolloutPath;

      if (!rawPath) {
        throw new Error(
          "Codex session index entry is missing a transcript path",
        );
      }

      return {
        transcriptPath: resolve(codexHome, rawPath),
        expectedThreadId: entry.thread_id ?? entry.threadId ?? entry.id,
      };
    });
}

function findJsonlFiles(
  directoryPath: string,
): Array<{ transcriptPath: string; expectedThreadId?: string }> {
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath, { withFileTypes: true })
    .flatMap(
      (
        entry: Dirent,
      ): Array<{ transcriptPath: string; expectedThreadId?: string }> => {
        const fullPath = join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          return findJsonlFiles(fullPath);
        }

        return entry.isFile() && entry.name.endsWith(".jsonl")
          ? [{ transcriptPath: fullPath }]
          : [];
      },
    )
    .sort((left, right) =>
      left.transcriptPath.localeCompare(right.transcriptPath),
    );
}

function codexThreadIdFromPath(transcriptPath: string): string | undefined {
  const filename = basename(transcriptPath).replace(/\.jsonl$/, "");
  return filename.length > 0 ? filename.replace(/^rollout-/, "") : undefined;
}
