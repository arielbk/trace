import type { SessionTool } from "./types.ts";

export type SyncTaskRow = {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  projectRoot: string;
  // Optional on the wire: the project's git identity, used on merge to attach
  // the task to an existing local project even when projectRoot is a path
  // from another machine. Rows from older clients omit them and fall back to
  // path-based project resolution.
  projectRemoteUrl?: string | null;
  projectRootCommit?: string | null;
  archivedAt: string | null;
  description: string | null;
  // Optional on the wire: rows from clients predating pin sync omit it, and
  // absent merges as unpinned.
  pinnedAt?: string | null;
  updatedAt: string;
  machineId: string;
};

export type SyncSessionRow = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model: string | null;
  title: string | null;
  taskId: string | null;
  parentSessionId: string | null;
  origin: "root" | "subagent" | "spawned";
  subagentType: string | null;
  agentId: string | null;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  updatedAt: string;
  machineId: string;
  // Optional on the wire: historical last-worked-on Git labels. Rows from
  // clients predating this field omit them. Absolute worktree paths stay
  // machine-local and never appear here.
  gitBranch?: string | null;
  gitWorktreeLabel?: string | null;
};

export type SyncPayload = {
  tasks: SyncTaskRow[];
  sessions: SyncSessionRow[];
  // The server's watermark for this response: an opaque token the client
  // stores and replays as the next pull's `since`. It is whatever the server
  // computed over the user's rows, never something derived from the rows
  // below — an empty response still has to advance it. Absent when the server
  // predates incremental pull, in which case the response is full state.
  cursor?: string;
};

export type SyncDocManifest = {
  taskId: string;
  filesCiphertext: string;
  updatedAt: string;
  machineId: string;
};

export type SyncBlob = { hash: string; content: Uint8Array };

// A task's data-encryption key, sealed under the account master key (KEK). The
// server stores and returns this opaque value verbatim; only a client holding
// the master key can unwrap it. Paired with a manifest by `taskId`.
export type SyncWrappedKey = { taskId: string; wrappedKey: string };

export interface SyncDocumentStore {
  snapshot(): Promise<{
    manifests: SyncDocManifest[];
    blobs: SyncBlob[];
    wrappedKeys: SyncWrappedKey[];
  }>;
  apply(
    manifests: SyncDocManifest[],
    wrappedKeys: SyncWrappedKey[],
    download: (hash: string) => Promise<Uint8Array | null>,
  ): Promise<{ pulled: number; downloaded: number; deferred?: number }>;
}

/**
 * Rows and documents are pulled from separate endpoints over separate tables,
 * so each keeps its own watermark. Merging them into one would hold both back
 * to whichever endpoint lagged, and silently skip the rows in between.
 */
export type SyncCursorScope = "rows" | "documents";

export interface SyncStore {
  syncSnapshot(): SyncPayload;
  mergeSyncPayload(payload: SyncPayload): { pulled: number };
  /**
   * The last cursor the server handed this machine for `scope`, or null when
   * it has never seen one. Null means "pull everything": dropping the stored
   * cursor is the full-resync escape hatch.
   */
  syncCursor(scope: SyncCursorScope): string | null;
  setSyncCursor(scope: SyncCursorScope, cursor: string): void;
}

export interface SyncTransport {
  push(payload: SyncPayload): Promise<{ accepted: number }>;
  pull(since?: string): Promise<SyncPayload>;
  pushDocuments?(
    manifests: SyncDocManifest[],
    blobs: SyncBlob[],
    wrappedKeys: SyncWrappedKey[],
  ): Promise<{ accepted: number; uploaded: number }>;
  pullDocumentManifests?(since?: string): Promise<{
    manifests: SyncDocManifest[];
    wrappedKeys: SyncWrappedKey[];
    cursor?: string;
  }>;
  missingBlobs?(hashes: string[]): Promise<string[]>;
  downloadBlob?(hash: string): Promise<Uint8Array | null>;
}

export function compareSyncRows(
  left: Pick<SyncTaskRow, "updatedAt" | "machineId">,
  right: Pick<SyncTaskRow, "updatedAt" | "machineId">,
): number {
  const timestamp = left.updatedAt.localeCompare(right.updatedAt);
  return timestamp || left.machineId.localeCompare(right.machineId);
}

export async function synchronize(
  store: SyncStore,
  transport: SyncTransport,
  documents?: SyncDocumentStore,
  onDocumentPhase?: () => void,
): Promise<{
  pushed: number;
  pulled: number;
  pushedManifests?: number;
  pulledManifests?: number;
  uploadedBlobs?: number;
  downloadedBlobs?: number;
  deferredManifests?: number;
}> {
  const before = store.syncSnapshot();
  const pushed = await transport.push(before);
  const payload = await transport.pull(store.syncCursor("rows") ?? undefined);
  const pulled = store.mergeSyncPayload(payload);
  // Only after the merge landed, and only when the server actually sent one:
  // a server that predates incremental pull answers with full state and no
  // cursor, and must leave the watermark exactly where it was.
  if (payload.cursor !== undefined) store.setSyncCursor("rows", payload.cursor);
  if (!documents) return { pushed: pushed.accepted, pulled: pulled.pulled };
  if (
    !transport.pushDocuments ||
    !transport.pullDocumentManifests ||
    !transport.missingBlobs ||
    !transport.downloadBlob
  ) {
    throw new Error("sync transport does not support document synchronization");
  }

  onDocumentPhase?.();
  const snapshot = await documents.snapshot();
  const missing = new Set(
    await transport.missingBlobs(snapshot.blobs.map((blob) => blob.hash)),
  );
  const pushedDocuments = await transport.pushDocuments(
    snapshot.manifests,
    snapshot.blobs.filter((blob) => missing.has(blob.hash)),
    snapshot.wrappedKeys,
  );
  const remote = await transport.pullDocumentManifests(
    store.syncCursor("documents") ?? undefined,
  );
  const pulledDocuments = await documents.apply(
    remote.manifests,
    remote.wrappedKeys,
    (hash) => transport.downloadBlob!(hash),
  );
  if (remote.cursor !== undefined && !pulledDocuments.deferred) {
    store.setSyncCursor("documents", remote.cursor);
  }
  return {
    pushed: pushed.accepted,
    pulled: pulled.pulled,
    pushedManifests: pushedDocuments.accepted,
    pulledManifests: pulledDocuments.pulled,
    uploadedBlobs: pushedDocuments.uploaded,
    downloadedBlobs: pulledDocuments.downloaded,
    ...(pulledDocuments.deferred ? { deferredManifests: pulledDocuments.deferred } : {}),
  };
}
