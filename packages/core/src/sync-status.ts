import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Persisted beside the Trace database as `sync-status.json`. This is the
 * board's single source of truth for the sync header: the CLI writes it on
 * login/logout/sync and the local api-handler reads it for
 * `GET /api/sync/status`. Keeping the state on disk (rather than making the
 * board reach the hosted server) means the header renders instantly and works
 * offline. `@trace/core` already touches the filesystem in `api-handler.ts`, so
 * this stays in core beside the code that consumes it.
 */
export interface SyncStatusFile {
  /** Whether a bearer token is currently stored (set on login, cleared on logout). */
  loggedIn: boolean;
  /** The resolved GitHub identity (`name <email>` / name / email / id), recorded at login. */
  identity?: string;
  /** ISO timestamp of the last successful sync, if any. */
  lastSyncedAt?: string;
  /** Message from the last sync that failed, cleared once a sync succeeds. */
  lastError?: string;
}

/**
 * The derived shape returned by `GET /api/sync/status` and consumed by the
 * board header. `identity` is presentational and best-effort — it is only
 * learned at `trace login`, so a token that predates identity recording (or a
 * background sync on a machine that never ran login) still derives as a
 * logged-in state, just without a name to show.
 *
 * `serverConfigured` on the logged-out state says whether the serving process
 * has a sync server to log in to (`TRACE_SERVER_URL` or the `config.json`
 * `serverUrl`, per `resolveConfiguredServerUrl`). It is
 * attached at the API boundary, not derived from the status file — the board
 * hides the sync badge entirely on a machine with no server configured, so
 * merged-but-unused cloud sync leaves no UI trace.
 */
export type SyncStatus =
  | { state: "logged-out"; serverConfigured?: boolean }
  | { state: "never-synced"; identity?: string }
  | { state: "synced"; identity?: string; lastSyncedAt: string }
  | {
      state: "failed";
      identity?: string;
      lastError: string;
      lastSyncedAt?: string;
    };

/** Location of the status file: `sync-status.json` beside the database. */
export function resolveSyncStatusPath(databasePath: string): string {
  return join(dirname(resolve(databasePath)), "sync-status.json");
}

/** Read the raw status file, or `null` when it is absent or malformed. */
export function readSyncStatusFile(databasePath: string): SyncStatusFile | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolveSyncStatusPath(databasePath), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SyncStatusFile).loggedIn === "boolean"
    ) {
      return parsed as SyncStatusFile;
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomically overwrite the status file. */
export function writeSyncStatusFile(
  databasePath: string,
  status: SyncStatusFile,
): void {
  const path = resolveSyncStatusPath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(status));
  renameSync(temporaryPath, path);
}

/**
 * Merge a partial patch into the current status file (or a logged-out base when
 * none exists). `undefined` values in the patch clear the corresponding field,
 * since `JSON.stringify` drops undefined keys — this is how a successful sync
 * clears a prior `lastError`.
 */
export function updateSyncStatusFile(
  databasePath: string,
  patch: Partial<SyncStatusFile>,
): void {
  const current = readSyncStatusFile(databasePath) ?? { loggedIn: false };
  writeSyncStatusFile(databasePath, { ...current, ...patch });
}

/** Collapse a raw status file into the discriminated status the board renders. */
export function deriveSyncStatus(file: SyncStatusFile | null): SyncStatus {
  if (!file || !file.loggedIn) {
    return { state: "logged-out" };
  }
  const identity = file.identity ? { identity: file.identity } : {};
  if (file.lastError) {
    return {
      state: "failed",
      ...identity,
      lastError: file.lastError,
      ...(file.lastSyncedAt ? { lastSyncedAt: file.lastSyncedAt } : {}),
    };
  }
  if (file.lastSyncedAt) {
    return {
      state: "synced",
      ...identity,
      lastSyncedAt: file.lastSyncedAt,
    };
  }
  return { state: "never-synced", ...identity };
}

/** Read and derive the board-facing sync status for a database. */
export function readSyncStatus(databasePath: string): SyncStatus {
  return deriveSyncStatus(readSyncStatusFile(databasePath));
}
