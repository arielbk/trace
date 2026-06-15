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
import type { CursorSession, ReaderOptions } from "./types.ts";

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
  fullConversationHeadersOnly?: unknown;
};

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
  const data = db
    ? (readJsonValue(
        db,
        "cursorDiskKV",
        `composerData:${composerId}`,
      ) as ComposerData | null)
    : null;
  db?.close();

  if (!data) {
    throw new Error(`Cursor composer not found: ${composerId}`);
  }

  const headers = data.fullConversationHeadersOnly;
  const messageCount = Array.isArray(headers) ? headers.length : 0;

  return {
    composerId,
    projectRoot: findProjectRoot(storageRoot, composerId),
    title: asStringOrNull(data.name),
    model: asStringOrNull(data.modelConfig?.modelName),
    createdAt: asNumberOrNull(data.createdAt),
    lastUpdatedAt: asNumberOrNull(data.lastUpdatedAt),
    messageCount,
    tokenTotals: null,
  };
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
