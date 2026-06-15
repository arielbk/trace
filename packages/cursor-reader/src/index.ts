// @trace/cursor-reader — reads Cursor (GUI) sessions from its state.vscdb SQLite
// store. Depends only on node:sqlite + node:fs; zero trace coupling.
//
// See docs/cursor-reader-design.md for the verified storage schema.

import {
  defaultStorageRoot,
  globalStateDbPath,
  listWorkspaces,
  openReadOnly,
  readJsonValue,
} from "./storage.ts";
import type { DatabaseSync } from "./node-sqlite.ts";
import type {
  CursorMessage,
  CursorSession,
  ReaderOptions,
} from "./types.ts";

export type { CursorSession, CursorMessage, ReaderOptions } from "./types.ts";

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
    const data = readJsonValue(db, "ItemTable", "composer.composerData") as
      | { lastFocusedComposerIds?: unknown }
      | null;
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

type ComposerData = {
  name?: unknown;
  modelConfig?: { modelName?: unknown };
  createdAt?: unknown;
  lastUpdatedAt?: unknown;
  usageData?: unknown;
  fullConversationHeadersOnly?: unknown;
};

type TokenTotals = { inputTokens: number; outputTokens: number };

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
    const totals = asTokenTotals(readBubble(db, composerId, bubbleId)?.tokenCount);
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
      const data = readJsonValue(db, "ItemTable", "composer.composerData") as
        | { lastFocusedComposerIds?: unknown; selectedComposerIds?: unknown }
        | null;
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
