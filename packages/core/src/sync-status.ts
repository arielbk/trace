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
  /**
   * The sync run currently believed to be in flight. Written when a run starts
   * and cleared by that same run's finalizer — see {@link beginSyncRun} and
   * {@link finalizeSyncRun}. The `id` is what makes a late finalizer harmless:
   * only the owner of the recorded run may write its outcome. A run left behind
   * by a killed process is recovered by age, not by cleanup — see
   * {@link STALE_SYNC_RUN_MS}.
   */
  activeRun?: { id: string; startedAt: string };
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
  | {
      state: "syncing";
      identity?: string;
      startedAt: string;
      lastSyncedAt?: string;
    }
  | { state: "synced"; identity?: string; lastSyncedAt: string }
  | {
      state: "failed";
      identity?: string;
      lastError: string;
      lastSyncedAt?: string;
    };

/**
 * What `GET /api/sync/status` actually returns: the derived status plus the
 * serving process's effective AutoSync mode. The mode rides along with status
 * so the board can say "AutoSync is off" without reading `config.json` from the
 * browser.
 */
export type SyncStatusResponse = SyncStatus & { autoSync?: boolean };

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

/**
 * Record the start of a sync run, taking ownership of the status file's active
 * run. A run started while another is recorded simply replaces it: the older
 * run's finalizer is then locked out by {@link finalizeSyncRun}, so the newest
 * run is always the one whose outcome the board will see.
 */
export function beginSyncRun(
  databasePath: string,
  run: { id: string; startedAt: string },
): void {
  updateSyncStatusFile(databasePath, { loggedIn: true, activeRun: run });
}

/**
 * Record the outcome of `runId` and clear the active run — but only if `runId`
 * still owns it. Returns whether the write happened, so a caller can tell a
 * finalized run from one that a newer run has already superseded. This is what
 * stops a slow sync that finishes after a newer one from replacing the newer
 * result with its own stale outcome.
 */
export function finalizeSyncRun(
  databasePath: string,
  runId: string,
  outcome: Pick<SyncStatusFile, "lastSyncedAt" | "lastError">,
): boolean {
  const current = readSyncStatusFile(databasePath);
  if (current?.activeRun?.id !== runId) return false;
  writeSyncStatusFile(databasePath, {
    ...current,
    ...outcome,
    activeRun: undefined,
  });
  return true;
}

/** Collapse a raw status file into the discriminated status the board renders. */
export function deriveSyncStatus(
  file: SyncStatusFile | null,
  now: Date = new Date(),
): SyncStatus {
  if (!file || !file.loggedIn) {
    return { state: "logged-out" };
  }
  const identity = file.identity ? { identity: file.identity } : {};
  if (isRunningNow(file.activeRun, now)) {
    return {
      state: "syncing",
      ...identity,
      startedAt: file.activeRun.startedAt,
      ...(file.lastSyncedAt ? { lastSyncedAt: file.lastSyncedAt } : {}),
    };
  }
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
export function readSyncStatus(
  databasePath: string,
  now: Date = new Date(),
): SyncStatus {
  return deriveSyncStatus(readSyncStatusFile(databasePath), now);
}

/**
 * How long a recorded run may stay unfinalized before the board stops calling
 * it active. A sync process that is killed (or crashes) never clears its own
 * `activeRun`, and an indefinite spinner is worse than a slightly stale
 * timestamp — past this age the status falls back to the last real outcome,
 * which is still on file. Comfortably longer than any healthy sync and shorter
 * than the periodic board interval's own retry rhythm feels forever.
 */
export const STALE_SYNC_RUN_MS = 10 * 60_000;

/** Whether a recorded run should still render as in flight at `now`. */
function isRunningNow(
  run: SyncStatusFile["activeRun"],
  now: Date,
): run is { id: string; startedAt: string } {
  if (!run) return false;
  const startedAt = Date.parse(run.startedAt);
  // An unparsable timestamp cannot be aged out, so it is never trusted.
  if (Number.isNaN(startedAt)) return false;
  return now.getTime() - startedAt < STALE_SYNC_RUN_MS;
}
