export type SyncTaskRow = {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  projectRoot: string;
  archivedAt: string | null;
  description: string | null;
  updatedAt: string;
  machineId: string;
};

export type SyncSessionRow = {
  id: string;
  transcriptPath: string;
  tool: "claude" | "codex" | "cursor";
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
};

export type SyncPayload = { tasks: SyncTaskRow[]; sessions: SyncSessionRow[] };

export type SyncDocManifest = {
  taskId: string;
  filesCiphertext: string;
  updatedAt: string;
  machineId: string;
};

export type SyncBlob = { hash: string; content: Uint8Array };

export interface SyncDocumentStore {
  snapshot(): Promise<{ manifests: SyncDocManifest[]; blobs: SyncBlob[] }>;
  apply(
    manifests: SyncDocManifest[],
    download: (hash: string) => Promise<Uint8Array | null>,
  ): Promise<{ pulled: number; downloaded: number }>;
}

export interface SyncStore {
  syncSnapshot(): SyncPayload;
  mergeSyncPayload(payload: SyncPayload): { pulled: number };
}

export interface SyncTransport {
  push(payload: SyncPayload): Promise<{ accepted: number }>;
  pull(): Promise<SyncPayload>;
  pushDocuments?(
    manifests: SyncDocManifest[],
    blobs: SyncBlob[],
  ): Promise<{ accepted: number; uploaded: number }>;
  pullDocumentManifests?(): Promise<SyncDocManifest[]>;
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
): Promise<{
  pushed: number;
  pulled: number;
  pushedManifests?: number;
  pulledManifests?: number;
  uploadedBlobs?: number;
  downloadedBlobs?: number;
}> {
  const before = store.syncSnapshot();
  const pushed = await transport.push(before);
  const pulled = store.mergeSyncPayload(await transport.pull());
  if (!documents) return { pushed: pushed.accepted, pulled: pulled.pulled };
  if (
    !transport.pushDocuments ||
    !transport.pullDocumentManifests ||
    !transport.missingBlobs ||
    !transport.downloadBlob
  ) {
    throw new Error("sync transport does not support document synchronization");
  }

  const snapshot = await documents.snapshot();
  const missing = new Set(
    await transport.missingBlobs(snapshot.blobs.map((blob) => blob.hash)),
  );
  const pushedDocuments = await transport.pushDocuments(
    snapshot.manifests,
    snapshot.blobs.filter((blob) => missing.has(blob.hash)),
  );
  const pulledDocuments = await documents.apply(
    await transport.pullDocumentManifests(),
    (hash) => transport.downloadBlob!(hash),
  );
  return {
    pushed: pushed.accepted,
    pulled: pulled.pulled,
    pushedManifests: pushedDocuments.accepted,
    pulledManifests: pulledDocuments.pulled,
    uploadedBlobs: pushedDocuments.uploaded,
    downloadedBlobs: pulledDocuments.downloaded,
  };
}
