import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  collectTranscriptHead,
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

// Parent-side spawn record: one `collab_agent_spawn_end` event per in-process
// subagent the session fanned out to (the `spawn_agent` collaboration tool).
export type CodexSubagentSpawn = {
  threadId: string;
  role: string | null;
  nickname: string | null;
};

// Child-side self-description: a subagent rollout's own `session_meta` names
// the thread that spawned it via `source.subagent.thread_spawn`.
export type CodexSubagentSource = {
  parentThreadId: string;
  role: string | null;
  nickname: string | null;
};

export type ParsedCodexSession = {
  id: string;
  transcriptPath: string;
  tool: "codex";
  model: string | null;
  title: string | null;
  tokenTotals: CodexTokenTotals;
  subagentSpawns: CodexSubagentSpawn[];
  subagentSource: CodexSubagentSource | null;
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

// Codex Desktop (OpenAI) per-turn cumulative usage — emitted via event_msg/token_count
type CodexDesktopUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
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
  // Codex Desktop payload wrapper
  payload?: {
    id?: string;
    type?: string;
    info?: {
      total_token_usage?: CodexDesktopUsage;
    };
    // session_meta: how this thread came to exist — a plain string for user
    // threads ("cli", "vscode", "exec"), an object for subagent children,
    // which carry their parent linkage here
    source?:
      | string
      | {
          subagent?: {
            thread_spawn?: {
              parent_thread_id?: string;
              agent_role?: string;
              agent_nickname?: string;
            };
          };
        };
    // collab_agent_spawn_end: the parent-side record of a spawned subagent
    new_thread_id?: string;
    new_agent_role?: string;
    new_agent_nickname?: string;
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
  let turnCompletedTotals = emptyTokenTotals();
  // Desktop format: each token_count event carries cumulative session totals;
  // we keep the last one so a live transcript gives the freshest count.
  let lastDesktopTotals: TokenTotals | null = null;
  const subagentSpawns: CodexSubagentSpawn[] = [];
  let subagentSource: CodexSubagentSource | null = null;

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

    // Codex CLI format: thread identity in thread.started
    if (event.type === "thread.started") {
      id ??= event.thread_id ?? event.threadId ?? event.id;
      model ??= event.model;
    }

    // Codex Desktop format: session identity in session_meta payload
    if (event.type === "session_meta") {
      id ??= event.payload?.id;
      const spawn =
        typeof event.payload?.source === "object"
          ? event.payload.source.subagent?.thread_spawn
          : undefined;
      if (spawn?.parent_thread_id) {
        subagentSource ??= {
          parentThreadId: spawn.parent_thread_id,
          role: spawn.agent_role ?? null,
          nickname: spawn.agent_nickname ?? null,
        };
      }
    }

    // Parent-side subagent spawn record (the spawn_agent collaboration tool)
    if (
      event.type === "event_msg" &&
      event.payload?.type === "collab_agent_spawn_end" &&
      event.payload.new_thread_id
    ) {
      subagentSpawns.push({
        threadId: event.payload.new_thread_id,
        role: event.payload.new_agent_role ?? null,
        nickname: event.payload.new_agent_nickname ?? null,
      });
    }

    // Codex CLI format: per-turn usage in turn.completed
    if (event.type === "turn.completed") {
      turnCompletedTotals = addTokenTotals(
        turnCompletedTotals,
        tokenTotalsFromUsage(event.usage ?? event.turn?.usage),
      );
    }

    // Codex Desktop format: cumulative session usage in event_msg/token_count
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      const usage = event.payload.info?.total_token_usage;
      if (usage) {
        lastDesktopTotals = desktopTokenTotals(usage);
      }
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
    // Codex transcripts carry no conversation name; titles are out of scope.
    title: null,
    tokenTotals: lastDesktopTotals ?? turnCompletedTotals,
    subagentSpawns,
    subagentSource,
  };
}

function desktopTokenTotals(usage: CodexDesktopUsage): TokenTotals {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadInputTokens = usage.cached_input_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
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

export function headCodexTranscript(input: {
  transcript: string;
  limit?: number | undefined;
}): TranscriptMessage[] {
  return collectTranscriptHead(
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

  return transcriptPaths.flatMap((entry) => {
    try {
      return [
        parseCodexTranscriptFile(entry.transcriptPath, {
          expectedThreadId: entry.expectedThreadId,
        }),
      ];
    } catch {
      return [];
    }
  });
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
    .flatMap((line) => {
      const entry = JSON.parse(line) as CodexSessionIndexEntry;
      const rawPath =
        entry.path ??
        entry.transcript_path ??
        entry.transcriptPath ??
        entry.rollout_path ??
        entry.rolloutPath;

      if (!rawPath) {
        return [];
      }

      return [
        {
          transcriptPath: resolve(codexHome, rawPath),
          expectedThreadId: entry.thread_id ?? entry.threadId ?? entry.id,
        },
      ];
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

/**
 * Locate the rollout file for a thread id anywhere under a Codex home — the
 * session index first, then the date-partitioned tree (a subagent child is
 * filed by its *own* start time, so it can live in a different day-dir than
 * its parent). Null when no rollout exists yet.
 */
export function resolveCodexTranscriptPathById(
  codexHome: string,
  threadId: string,
): string | null {
  const root = resolve(codexHome);

  for (const entry of readCodexSessionIndex(root)) {
    const entryId =
      entry.expectedThreadId ?? codexThreadIdFromPath(entry.transcriptPath);
    if (entryId === threadId && existsSync(entry.transcriptPath)) {
      return entry.transcriptPath;
    }
  }

  for (const entry of findJsonlFiles(join(root, "sessions"))) {
    if (codexThreadIdFromPath(entry.transcriptPath) === threadId) {
      return entry.transcriptPath;
    }
  }

  return null;
}

function codexThreadIdFromPath(transcriptPath: string): string | undefined {
  const filename = basename(transcriptPath).replace(/\.jsonl$/, "");
  if (!filename.length) return undefined;
  // Codex Desktop filenames: rollout-YYYY-MM-DDThh-mm-ss-{uuid}
  // Extract just the trailing UUID when present.
  const uuidMatch = filename.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (uuidMatch) return uuidMatch[1];
  // Legacy Codex CLI filenames: strip rollout- prefix if present.
  return filename.replace(/^rollout-/, "");
}
