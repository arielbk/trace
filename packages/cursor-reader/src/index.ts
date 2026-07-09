// @trace/cursor-reader — reads Cursor sessions. GUI composers come from the
// state.vscdb SQLite store; cursor-agent (CLI) chats from the JSONL mirror
// under ~/.cursor/projects. Depends only on node:sqlite + node:fs; zero trace
// coupling.
//
// See docs/cursor-reader-design.md for the verified storage schema.

import { basename, dirname } from "node:path";
import { statSync } from "node:fs";
import {
  readAgentChatEnrichment,
  type AgentChatStoreOptions,
} from "./agent-chat-store.ts";
import {
  findAgentTranscript,
  readAgentTranscriptMessages,
  resolveLatestAgentChat,
  type AgentChat,
  type AgentTranscriptOptions,
} from "./agent-transcripts.ts";
import {
  defaultStorageRoot,
  globalStateDbPath,
  listWorkspaces,
  openReadOnly,
  readJsonValue,
} from "./storage.ts";
import type { DatabaseSync } from "./node-sqlite.ts";
import type { CursorMessage, CursorSession, ReaderOptions } from "./types.ts";

export type { CursorSession, CursorMessage, ReaderOptions } from "./types.ts";
export {
  cursorProjectKey,
  defaultProjectsRoot,
  findAgentTranscript,
  readAgentTranscriptMessages,
  resolveLatestAgentChat,
  type AgentChat,
  type AgentTranscriptOptions,
} from "./agent-transcripts.ts";
export {
  readAgentChatEnrichment,
  type AgentChatEnrichment,
  type AgentChatStoreOptions,
} from "./agent-chat-store.ts";

export type FocusedComposer = {
  composerId: string;
  workspaceHash: string;
};

/**
 * Map a repo path → its Cursor workspace → the currently focused composer
 * (`composer.composerData.lastFocusedComposerIds[0]`). Returns null when no
 * workspace matches the path or no composer is focused.
 */
export function resolveFocusedComposer(
  repoPath: string,
  opts?: ReaderOptions,
): FocusedComposer | null {
  const storageRoot = opts?.storageRoot ?? defaultStorageRoot();
  const workspace = listWorkspaces(storageRoot).find(
    (ws) => ws.folder === repoPath,
  );
  if (!workspace) return null;

  const db = openReadOnly(workspace.stateDbPath);
  if (!db) return null;
  try {
    const data = readJsonValue(db, "ItemTable", "composer.composerData") as {
      lastFocusedComposerIds?: unknown;
    } | null;
    const focused = Array.isArray(data?.lastFocusedComposerIds)
      ? data.lastFocusedComposerIds
      : [];
    const composerId = focused[0];
    if (typeof composerId !== "string") return null;
    return { composerId, workspaceHash: workspace.hash };
  } finally {
    db.close();
  }
}

export type ResolvedCursorSession = {
  id: string;
  // Absolute JSONL path when the chat resolved through the agent-transcript
  // mirror (the cursor-agent CLI flavor); null when it resolved as a focused
  // GUI composer and should be read through state.vscdb.
  transcriptPath: string | null;
};

/**
 * The current Cursor session for a repo, across both flavors: the focused GUI
 * composer and the newest cursor-agent (CLI) chat. When both exist and
 * disagree, the fresher one wins — the CLI chat's transcript mtime against the
 * composer's `lastUpdatedAt` — because either surface can be the one the user
 * is actually driving. Ties (and an unreadable composer record) keep the
 * focused composer, the richer source.
 */
export function resolveCursorSession(
  repoPath: string,
  opts?: ReaderOptions & AgentTranscriptOptions,
): ResolvedCursorSession | null {
  const focused = resolveFocusedComposer(repoPath, opts);
  const latestChat = resolveLatestAgentChat(repoPath, opts);

  if (!focused && !latestChat) return null;
  if (focused && (!latestChat || latestChat.chatId === focused.composerId)) {
    return { id: focused.composerId, transcriptPath: null };
  }
  if (!focused && latestChat) return agentChatSession(latestChat, opts);

  // Both present, different ids: freshest wins.
  const composerUpdatedAt = (() => {
    try {
      return readComposer(focused!.composerId, opts).lastUpdatedAt ?? 0;
    } catch {
      return 0;
    }
  })();
  return latestChat!.lastUpdatedAt > composerUpdatedAt
    ? agentChatSession(latestChat!, opts)
    : { id: focused!.composerId, transcriptPath: null };
}

/**
 * Resolve a session already identified by id (e.g. from
 * `CURSOR_CONVERSATION_ID`) to its flavor. A composer record wins over a JSONL
 * mirror — current GUI builds mirror every chat to JSONL too, so the mirror
 * proves nothing, while a composer record carries the real model and marks the
 * chat as GUI-owned (no CLI resume). A record-less id is a cursor-agent chat,
 * located by its transcript; when even that is absent (a brand-new chat racing
 * its first write) the composer flavor is the safe default — reads through it
 * fail missing, not wrong.
 */
export function resolveCursorSessionById(
  sessionId: string,
  opts?: ReaderOptions & AgentTranscriptOptions & { cwd?: string },
): ResolvedCursorSession {
  if (hasComposerRecord(sessionId, opts)) {
    return { id: sessionId, transcriptPath: null };
  }
  return { id: sessionId, transcriptPath: findAgentTranscript(sessionId, opts) };
}

/** A GUI-mirrored chat resolves as its composer; see resolveCursorSessionById. */
function agentChatSession(
  chat: AgentChat,
  opts?: ReaderOptions,
): ResolvedCursorSession {
  return hasComposerRecord(chat.chatId, opts)
    ? { id: chat.chatId, transcriptPath: null }
    : { id: chat.chatId, transcriptPath: chat.transcriptPath };
}

/** Whether the global store holds a `composerData:<id>` record. */
function hasComposerRecord(
  composerId: string,
  opts?: ReaderOptions,
): boolean {
  const storageRoot = opts?.storageRoot ?? defaultStorageRoot();
  const db = openReadOnly(globalStateDbPath(storageRoot));
  if (!db) return false;
  try {
    return (
      readJsonValue(db, "cursorDiskKV", `composerData:${composerId}`) !== null
    );
  } finally {
    db.close();
  }
}

/**
 * Reconstruct a session from an agent transcript JSONL, enriched from the
 * chat's private store under `~/.cursor/chats` — the path for cursor-agent
 * chats whose id has no `composerData` record (no GUI on the machine, or a
 * CLI-only chat). The JSONL alone carries only messages and file times; the
 * chat store adds the model and project root when present. Token data exists
 * in neither, so it stays null. Throws when the transcript does not exist.
 */
export function readAgentSession(
  transcriptPath: string,
  opts?: AgentChatStoreOptions,
): CursorSession {
  const stat = statSync(transcriptPath);
  const messages = readAgentTranscriptMessages(transcriptPath);
  const chatId = chatIdFromTranscriptPath(transcriptPath);
  const enrichment = readAgentChatEnrichment(chatId, opts);
  return {
    composerId: chatId,
    projectRoot: enrichment.cwd,
    title: null,
    model: enrichment.model,
    createdAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : enrichment.createdAt,
    lastUpdatedAt: stat.mtimeMs,
    messageCount: messages.length,
    tokenTotals: null,
    contextTokens: null,
  };
}

/** `<chatId>.jsonl` → chatId, tolerating a bare directory-style path. */
export function chatIdFromTranscriptPath(transcriptPath: string): string {
  const base = basename(transcriptPath);
  return base.endsWith(".jsonl")
    ? base.slice(0, -".jsonl".length)
    : basename(dirname(transcriptPath));
}

type ComposerData = {
  name?: unknown;
  modelConfig?: { modelName?: unknown };
  createdAt?: unknown;
  lastUpdatedAt?: unknown;
  usageData?: unknown;
  contextTokensUsed?: unknown;
  contextTokenLimit?: unknown;
  fullConversationHeadersOnly?: unknown;
  subagentInfo?: {
    parentComposerId?: unknown;
    subagentTypeName?: unknown;
  };
};

type TokenTotals = { inputTokens: number; outputTokens: number };
type ContextTokens = { used: number; limit: number };

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Current context-window occupancy from the composer. Requires a numeric
 * `contextTokensUsed`; the limit falls back to 0 when Cursor omits it. Null when
 * usage is absent, so callers can distinguish "0 tokens used" from "unknown".
 */
function asContextTokens(data: ComposerData): ContextTokens | null {
  const used = asNumberOrNull(data.contextTokensUsed);
  if (used === null) return null;
  return { used, limit: asNumberOrNull(data.contextTokenLimit) ?? 0 };
}

/**
 * Reconstruct a composer's session metadata from the global `cursorDiskKV`
 * store. `projectRoot` is reverse-resolved by finding the workspace whose
 * focused/selected composer ids reference this composer (Cursor stores no folder
 * on the composer itself). Throws if the composer is not found.
 */
export function readComposer(
  composerId: string,
  opts?: ReaderOptions,
): CursorSession {
  const storageRoot = opts?.storageRoot ?? defaultStorageRoot();
  const db = openReadOnly(globalStateDbPath(storageRoot));
  if (!db) {
    throw new Error(`Cursor composer not found: ${composerId}`);
  }
  try {
    const data = readJsonValue(
      db,
      "cursorDiskKV",
      `composerData:${composerId}`,
    ) as ComposerData | null;

    if (!data) {
      throw new Error(`Cursor composer not found: ${composerId}`);
    }

    const headers = headerList(data);

    return {
      composerId,
      projectRoot: findProjectRoot(storageRoot, composerId),
      title: asStringOrNull(data.name),
      model: asStringOrNull(data.modelConfig?.modelName),
      createdAt: asNumberOrNull(data.createdAt),
      lastUpdatedAt: asNumberOrNull(data.lastUpdatedAt),
      messageCount: headers.length,
      tokenTotals: computeTokenTotals(db, composerId, headers, data.usageData),
      contextTokens: asContextTokens(data),
    };
  } finally {
    db.close();
  }
}

export type CursorSubagentInfo = {
  parentComposerId: string;
  subagentType: string | null;
};

/**
 * A subagent chat's linkage back to the composer that spawned it, from
 * `composerData.subagentInfo` (present on GUI-spawned subagents; the parent's
 * `Task` tool call is mirrored there as `parentComposerId` +
 * `subagentTypeName`). Null for anything that isn't a subagent chat, and on
 * machines with no GUI store (fail missing, not wrong).
 */
export function readComposerSubagentInfo(
  composerId: string,
  opts?: ReaderOptions,
): CursorSubagentInfo | null {
  const storageRoot = opts?.storageRoot ?? defaultStorageRoot();
  const db = openReadOnly(globalStateDbPath(storageRoot));
  if (!db) return null;
  try {
    const data = readJsonValue(
      db,
      "cursorDiskKV",
      `composerData:${composerId}`,
    ) as ComposerData | null;

    const parentComposerId = asStringOrNull(
      data?.subagentInfo?.parentComposerId ?? null,
    );
    if (!parentComposerId) return null;

    return {
      parentComposerId,
      subagentType: asStringOrNull(data?.subagentInfo?.subagentTypeName ?? null),
    };
  } finally {
    db.close();
  }
}

/**
 * Reconstruct the last `limit` messages of a composer as neutral
 * `CursorMessage`s, projecting Cursor's polymorphic bubbles: thinking
 * (`capabilityType` 30) → `thinking`, tool calls (`capabilityType` 15) → `tool`,
 * everything else → `user`/`assistant` by bubble `type`. Blank turns are
 * dropped. Returns `[]` when the store or composer is absent (fail missing).
 *
 * Reads are key-targeted and bounded by `limit` — the 25k+ `bubbleId` rows are
 * never scanned.
 */
export function readComposerTail(
  composerId: string,
  limit: number,
  opts?: ReaderOptions,
): CursorMessage[] {
  const storageRoot = opts?.storageRoot ?? defaultStorageRoot();
  const db = openReadOnly(globalStateDbPath(storageRoot));
  if (!db) return [];
  try {
    const data = readJsonValue(
      db,
      "cursorDiskKV",
      `composerData:${composerId}`,
    ) as ComposerData | null;
    if (!data) return [];

    const tail = limit <= 0 ? [] : headerList(data).slice(-limit);
    const messages: CursorMessage[] = [];
    for (const bubbleId of tail) {
      const bubble = readBubble(db, composerId, bubbleId);
      if (!bubble) continue;
      const message = projectBubble(bubble);
      if (message) messages.push(message);
    }
    return messages;
  } finally {
    db.close();
  }
}

/** Ordered bubble ids from `fullConversationHeadersOnly`. */
function headerList(data: ComposerData): string[] {
  const headers = data.fullConversationHeadersOnly;
  if (!Array.isArray(headers)) return [];
  const ids: string[] = [];
  for (const header of headers) {
    const bubbleId = (header as { bubbleId?: unknown }).bubbleId;
    if (typeof bubbleId === "string") ids.push(bubbleId);
  }
  return ids;
}

type Bubble = {
  type?: unknown;
  capabilityType?: unknown;
  text?: unknown;
  thinking?: { text?: unknown };
  toolFormerData?: { name?: unknown; status?: unknown };
  tokenCount?: unknown;
};

const CAPABILITY_THINKING = 30;
const CAPABILITY_TOOL = 15;

function readBubble(
  db: DatabaseSync,
  composerId: string,
  bubbleId: string,
): Bubble | null {
  return readJsonValue(
    db,
    "cursorDiskKV",
    `bubbleId:${composerId}:${bubbleId}`,
  ) as Bubble | null;
}

/** Project one raw bubble into a `CursorMessage`, or null to drop it. */
function projectBubble(bubble: Bubble): CursorMessage | null {
  if (bubble.capabilityType === CAPABILITY_TOOL) {
    const tool = bubble.toolFormerData ?? {};
    const name = asStringOrNull(tool.name) ?? "tool";
    const status = asStringOrNull(tool.status);
    return status === null
      ? { kind: "tool", name }
      : { kind: "tool", name, status };
  }
  if (bubble.capabilityType === CAPABILITY_THINKING) {
    const text = asStringOrNull(bubble.thinking?.text);
    return text ? { kind: "thinking", text } : null;
  }
  const text = asStringOrNull(bubble.text) ?? "";
  if (text.length === 0) return null; // skip blank user/assistant turns
  return bubble.type === 1
    ? { kind: "user", text }
    : { kind: "assistant", text };
}

/** Coerce a `{inputTokens?, outputTokens?}`-shaped value to a `TokenTotals`. */
function asTokenTotals(value: unknown): TokenTotals | null {
  if (!value || typeof value !== "object") return null;
  const { inputTokens, outputTokens } = value as {
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number") {
    return null;
  }
  return {
    inputTokens: typeof inputTokens === "number" ? inputTokens : 0,
    outputTokens: typeof outputTokens === "number" ? outputTokens : 0,
  };
}

/**
 * Token totals for a composer: the aggregate `usageData` when present,
 * otherwise the sum of per-bubble `tokenCount`. Null when neither exists.
 */
function computeTokenTotals(
  db: DatabaseSync,
  composerId: string,
  bubbleIds: string[],
  usageData: unknown,
): TokenTotals | null {
  const aggregate = asTokenTotals(usageData);
  if (aggregate) return aggregate;

  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const bubbleId of bubbleIds) {
    const totals = asTokenTotals(
      readBubble(db, composerId, bubbleId)?.tokenCount,
    );
    if (totals) {
      inputTokens += totals.inputTokens;
      outputTokens += totals.outputTokens;
      found = true;
    }
  }
  return found ? { inputTokens, outputTokens } : null;
}

/** Find the folder of the workspace that references this composer, if any. */
function findProjectRoot(
  storageRoot: string,
  composerId: string,
): string | null {
  for (const ws of listWorkspaces(storageRoot)) {
    const db = openReadOnly(ws.stateDbPath);
    if (!db) continue;
    try {
      const data = readJsonValue(db, "ItemTable", "composer.composerData") as {
        lastFocusedComposerIds?: unknown;
        selectedComposerIds?: unknown;
      } | null;
      const ids = [
        ...(Array.isArray(data?.lastFocusedComposerIds)
          ? data.lastFocusedComposerIds
          : []),
        ...(Array.isArray(data?.selectedComposerIds)
          ? data.selectedComposerIds
          : []),
      ];
      if (ids.includes(composerId)) return ws.folder;
    } finally {
      db.close();
    }
  }
  return null;
}
