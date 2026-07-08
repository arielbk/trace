import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabaseSync, type DatabaseSync } from "./node-sqlite.ts";

/** Default macOS Cursor user-storage root. */
export function defaultStorageRoot(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
  );
}

/**
 * Open a Cursor `.vscdb` read-only. Cursor holds these DBs open while running,
 * so we use `file:<path>?mode=ro&immutable=1` plus `{ readOnly: true }` for safe
 * concurrent reads. Returns null if the file is absent (fail missing, not wrong).
 */
export function openReadOnly(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  const DatabaseSync = getDatabaseSync();
  return new DatabaseSync(`file:${path}?mode=ro&immutable=1`, {
    readOnly: true,
  });
}

/** Read and JSON-parse a single key from a key/value `.vscdb` table. */
export function readJsonValue(
  db: DatabaseSync,
  table: "ItemTable" | "cursorDiskKV",
  key: string,
): unknown {
  const row = db
    .prepare(`SELECT value FROM ${table} WHERE key = ?`)
    .get(key) as { value?: string | Buffer | Uint8Array } | undefined;
  if (!row || row.value == null) return null;
  const raw =
    typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type WorkspaceEntry = {
  hash: string;
  folder: string | null;
  stateDbPath: string;
};

/** Enumerate workspace storage dirs, resolving each `workspace.json` folder. */
export function listWorkspaces(storageRoot: string): WorkspaceEntry[] {
  const wsRoot = join(storageRoot, "workspaceStorage");
  if (!existsSync(wsRoot)) return [];
  const entries: WorkspaceEntry[] = [];
  for (const dirent of readdirSync(wsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const hash = dirent.name;
    const dir = join(wsRoot, hash);
    entries.push({
      hash,
      folder: readWorkspaceFolder(join(dir, "workspace.json")),
      stateDbPath: join(dir, "state.vscdb"),
    });
  }
  return entries;
}

function readWorkspaceFolder(workspaceJsonPath: string): string | null {
  if (!existsSync(workspaceJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(workspaceJsonPath, "utf8")) as {
      folder?: unknown;
    };
    if (typeof parsed.folder !== "string") return null;
    return parsed.folder.startsWith("file:")
      ? fileURLToPath(parsed.folder)
      : parsed.folder;
  } catch {
    return null;
  }
}

export function globalStateDbPath(storageRoot: string): string {
  return join(storageRoot, "globalStorage", "state.vscdb");
}
