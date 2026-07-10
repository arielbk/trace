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

export interface SyncStore {
  syncSnapshot(): SyncPayload;
  mergeSyncPayload(payload: SyncPayload): { pulled: number };
}

export interface SyncTransport {
  push(payload: SyncPayload): Promise<{ accepted: number }>;
  pull(): Promise<SyncPayload>;
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
): Promise<{ pushed: number; pulled: number }> {
  const before = store.syncSnapshot();
  const pushed = await transport.push(before);
  const pulled = store.mergeSyncPayload(await transport.pull());
  return { pushed: pushed.accepted, pulled: pulled.pulled };
}
