import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import type { ContextTokens, TokenTotals } from "./types.ts";

export type CodexTokenTotals = TokenTotals;

// Parent-side spawn record: one per in-process subagent the session fanned
// out to (the `spawn_agent` collaboration tool). Recovered from either of the
// two shapes Codex writes — a `collab_agent_spawn_end` event_msg, or (Codex
// Desktop 0.142+) a `spawn_agent` function_call/function_call_output pair in
// response_item records, where the call carries the role and the output
// carries the child thread id and nickname.
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
  contextTokens?: ContextTokens | null;
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
  cached_input_tokens?: number;
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
    // turn_context: the model serving the turn (session_meta carries none)
    model?: string;
    // event_msg thread_settings_applied: the thread's configured model
    thread_settings?: {
      model?: string;
    };
    info?: {
      total_token_usage?: CodexDesktopUsage;
      last_token_usage?: CodexDesktopUsage;
      model_context_window?: number;
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
    // response_item function calls: Codex Desktop records spawns as a
    // spawn_agent call/output pair correlated by call_id; arguments and
    // output are JSON-encoded strings
    name?: string;
    call_id?: string;
    arguments?: string;
    output?: string;
    // event_msg sub_agent_activity (Codex Desktop 0.144+, multi-agent v2):
    // the spawn's thread id lives here, keyed back to the spawn_agent call
    // by event_id; agent_path is "/root/<task_name>"
    kind?: string;
    event_id?: string;
    agent_thread_id?: string;
    agent_path?: string;
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
  let previousDesktopContextTokens = 0;
  let desktopContextGrowthTokens = 0;
  let canRealignDesktopTotals = true;
  let lastDesktopContextTokens: ContextTokens | null = null;
  const subagentSpawns: CodexSubagentSpawn[] = [];
  // Both spawn shapes can name the same child; first record wins.
  const addSpawn = (spawn: CodexSubagentSpawn) => {
    if (!subagentSpawns.some((known) => known.threadId === spawn.threadId)) {
      subagentSpawns.push(spawn);
    }
  };
  // spawn_agent calls whose output hasn't streamed yet, call_id → role
  const pendingSpawnRoles = new Map<string, string | null>();
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

    // Codex Desktop format: session_meta names no model. Model-bearing events
    // can change during a session, so the latest observed setting wins.
    if (event.type === "turn_context") {
      model = event.payload?.model ?? model;
    }
    if (
      event.type === "event_msg" &&
      event.payload?.type === "thread_settings_applied"
    ) {
      model = event.payload.thread_settings?.model ?? model;
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
      addSpawn({
        threadId: event.payload.new_thread_id,
        role: event.payload.new_agent_role ?? null,
        nickname: event.payload.new_agent_nickname ?? null,
      });
    }

    // Codex Desktop 0.142+ emits no collab_agent_spawn_end; the spawn lives in
    // the response_item stream as a spawn_agent function_call (role in its
    // arguments) answered by a function_call_output (child id and nickname in
    // its output), matched by call_id.
    if (event.type === "response_item") {
      if (
        event.payload?.type === "function_call" &&
        event.payload.name === "spawn_agent" &&
        event.payload.call_id
      ) {
        pendingSpawnRoles.set(
          event.payload.call_id,
          spawnAgentRole(event.payload.arguments),
        );
      }
      if (
        event.payload?.type === "function_call_output" &&
        event.payload.call_id &&
        pendingSpawnRoles.has(event.payload.call_id)
      ) {
        const role = pendingSpawnRoles.get(event.payload.call_id) ?? null;
        pendingSpawnRoles.delete(event.payload.call_id);
        const spawned = spawnedAgentFromOutput(event.payload.output);
        if (spawned) {
          addSpawn({ ...spawned, role });
        }
      }
    }

    // Codex Desktop 0.144+ (multi-agent v2): the spawn_agent output carries
    // only the task name — the child thread id is announced in a
    // sub_agent_activity "started" event, correlated by event_id = call_id.
    if (
      event.type === "event_msg" &&
      event.payload?.type === "sub_agent_activity" &&
      event.payload.kind === "started" &&
      event.payload.agent_thread_id
    ) {
      const eventId = event.payload.event_id;
      const role = eventId ? (pendingSpawnRoles.get(eventId) ?? null) : null;
      if (eventId) pendingSpawnRoles.delete(eventId);
      addSpawn({
        threadId: event.payload.agent_thread_id,
        role,
        nickname: nicknameFromAgentPath(event.payload.agent_path),
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
      const info = event.payload.info;
      const usage = info?.total_token_usage;
      const usedContextTokens =
        info?.last_token_usage?.total_tokens ??
        info?.last_token_usage?.input_tokens;
      if (
        usedContextTokens !== undefined &&
        info?.model_context_window !== undefined
      ) {
        lastDesktopContextTokens = {
          used: usedContextTokens,
          limit: info.model_context_window,
        };
      }
      if (usage) {
        lastDesktopTotals = desktopTokenTotals(usage);
        const currentContextTokens =
          info.last_token_usage?.input_tokens ??
          info.last_token_usage?.total_tokens;
        if (currentContextTokens === undefined) {
          canRealignDesktopTotals = false;
        } else {
          desktopContextGrowthTokens += Math.max(
            0,
            currentContextTokens - previousDesktopContextTokens,
          );
          previousDesktopContextTokens = currentContextTokens;
        }
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
    // The rollout itself carries no conversation name; Codex keeps thread
    // names next door in <codexHome>/session_index.jsonl.
    title: codexThreadTitleFromIndex(input.transcriptPath, id),
    tokenTotals:
      lastDesktopTotals && canRealignDesktopTotals
        ? realignDesktopTokenTotals(
            lastDesktopTotals,
            desktopContextGrowthTokens,
          )
        : (lastDesktopTotals ?? turnCompletedTotals),
    ...(lastDesktopContextTokens
      ? { contextTokens: lastDesktopContextTokens }
      : {}),
    subagentSpawns,
    subagentSource,
  };
}

/**
 * The Codex home holding a rollout file: rollouts are filed under
 * `<codexHome>/sessions/YYYY/MM/DD/`, so walk up to the `sessions` segment.
 * Null for paths outside any sessions tree (fixtures, synthetic locators).
 */
function codexHomeFromTranscriptPath(transcriptPath: string): string | null {
  let dir = dirname(resolve(transcriptPath));
  while (true) {
    if (basename(dir) === "sessions") return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Thread name for a rollout, from the sibling `session_index.jsonl` — rows of
 * `{id, thread_name, updated_at}`, appended on rename, so the last matching
 * row wins. Best-effort: no index, no matching row, or a blank name is null.
 */
function codexThreadTitleFromIndex(
  transcriptPath: string,
  threadId: string,
): string | null {
  const codexHome = codexHomeFromTranscriptPath(transcriptPath);
  if (!codexHome) return null;
  const indexPath = join(codexHome, "session_index.jsonl");
  let content: string;
  try {
    content = readFileSync(indexPath, "utf8");
  } catch {
    return null;
  }
  let title: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes(threadId)) continue;
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string };
      if (entry.id === threadId && entry.thread_name?.trim()) {
        title = entry.thread_name.trim();
      }
    } catch {
      // Live index files can end in a half-written line; skip it.
    }
  }
  return title;
}

function desktopTokenTotals(usage: CodexDesktopUsage): TokenTotals {
  const rawInputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadInputTokens = usage.cached_input_tokens ?? 0;
  // OpenAI's input_tokens INCLUDES cached input; Trace's inputTokens is fresh
  // input only (the Anthropic convention the rest of the app assumes), so
  // cached reads move to cacheReadInputTokens instead of inflating "in".
  const inputTokens = Math.max(0, rawInputTokens - cacheReadInputTokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
    totalTokens: usage.total_tokens ?? rawInputTokens + outputTokens,
  };
}

function realignDesktopTokenTotals(
  totals: TokenTotals,
  contextGrowthTokens: number,
): TokenTotals {
  const inputTokens = Math.min(totals.inputTokens, contextGrowthTokens);
  return {
    ...totals,
    inputTokens,
    cacheCreationInputTokens: totals.inputTokens - inputTokens,
  };
}

/** "/root/test_codex_update" → "test_codex_update"; null for a blank path. */
function nicknameFromAgentPath(agentPath: string | undefined): string | null {
  if (!agentPath) return null;
  const segments = agentPath.split("/").filter(Boolean);
  return segments.at(-1) ?? null;
}

function spawnAgentRole(rawArguments: string | undefined): string | null {
  if (!rawArguments) return null;
  try {
    const parsed = JSON.parse(rawArguments) as { agent_type?: string };
    return parsed.agent_type ?? null;
  } catch {
    return null;
  }
}

function spawnedAgentFromOutput(
  rawOutput: string | undefined,
): { threadId: string; nickname: string | null } | null {
  if (!rawOutput) return null;
  try {
    const parsed = JSON.parse(rawOutput) as {
      agent_id?: string;
      nickname?: string;
    };
    return parsed.agent_id
      ? { threadId: parsed.agent_id, nickname: parsed.nickname ?? null }
      : null;
  } catch {
    // A failed spawn's output is an error string, not an agent handle.
    return null;
  }
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
