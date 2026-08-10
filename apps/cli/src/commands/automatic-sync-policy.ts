import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { openTraceStore } from "@trace/core";

/**
 * The scheduling policy for *implicit* syncs — the second half of the decision
 * `requestAutomaticSync` makes, after AutoSync itself is known to be on.
 *
 * Automatic syncs fire on every task mutation, on board startup and focus, and
 * on a periodic board timer, so an agent working in a loop can trigger dozens
 * of them a minute. Almost all of those find nothing to push and nothing to
 * pull. This module answers "would that sync learn anything?" from local state
 * alone, without touching the network.
 */

/**
 * The unconditional gap between automatic syncs. It applies even to a machine
 * with unpushed changes: a burst of mutations coalesces into one sync a moment
 * later rather than one sync each. Explicit `trace sync` never comes through
 * here, so the floor can never delay a sync the user asked for.
 */
export const AUTOMATIC_SYNC_FLOOR_MS = 60_000;

/**
 * How long a machine with nothing to push may stay off the network before it
 * syncs anyway. Skipping a sync skips the *pull* too, so a clean machine that
 * only ever suppressed would never learn about another machine's pushes. This
 * bounds that: remote changes arrive within this window at worst.
 */
export const AUTOMATIC_SYNC_QUIET_MS = 10 * 60_000;

/**
 * Persisted beside the Trace database as `auto-sync.json`. It has to be on disk
 * rather than in memory because the triggers live in separate, short-lived
 * processes — each `trace` invocation is a fresh process, so an in-memory
 * timestamp would never see the previous request.
 */
export type AutomaticSyncState = {
  /** When an automatic sync was last spawned, for the floor. */
  lastRequestedAt?: string;
  /** When a sync last completed successfully. */
  lastSyncedAt?: string;
  /** {@link localSyncFingerprint} as of that successful sync. */
  fingerprint?: string;
};

/** Location of the policy's state file: `auto-sync.json` beside the database. */
export function resolveAutomaticSyncStatePath(databasePath: string): string {
  return join(dirname(resolve(databasePath)), "auto-sync.json");
}

/** Read the state file, or an empty state when it is absent or malformed. */
export function readAutomaticSyncState(databasePath: string): AutomaticSyncState {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolveAutomaticSyncStatePath(databasePath), "utf8"),
    );
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as AutomaticSyncState;
    }
    return {};
  } catch {
    return {};
  }
}

/** Merge a patch into the state file. Best-effort: a write failure just costs a sync. */
export function updateAutomaticSyncState(
  databasePath: string,
  patch: AutomaticSyncState,
): void {
  try {
    const path = resolveAutomaticSyncStatePath(databasePath);
    mkdirSync(dirname(path), { recursive: true });
    const next = { ...readAutomaticSyncState(databasePath), ...patch };
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(next));
    renameSync(temporaryPath, path);
  } catch {
    // Losing the state only means the next automatic sync runs when it could
    // have been skipped — never a correctness problem.
  }
}

/**
 * What the local machine currently holds, as one comparable string: the shape
 * of the syncable rows plus the document metadata the last push published.
 *
 * The document half comes from `doc-sync.json`, which is only rewritten *by* a
 * sync — so an edit to a doc file on disk does not move this fingerprint on its
 * own. That is deliberate: detecting it would mean walking every task's docs
 * directory on every task mutation. {@link AUTOMATIC_SYNC_QUIET_MS} is what
 * catches those edits, on the same bounded delay as a remote change.
 */
export function localSyncFingerprint(databasePath: string): string {
  return `${storeFingerprint(databasePath)}|${documentFingerprint(databasePath)}`;
}

function storeFingerprint(databasePath: string): string {
  // A database that does not exist yet has nothing to sync — and must not be
  // created as a side effect of asking whether to sync.
  if (!existsSync(resolve(databasePath))) return "absent";
  const store = openTraceStore(databasePath);
  try {
    return store.syncFingerprint();
  } finally {
    store.close();
  }
}

function documentFingerprint(databasePath: string): string {
  try {
    const path = join(dirname(resolve(databasePath)), "doc-sync.json");
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return "absent";
  }
}

/**
 * Whether an automatic sync would learn anything, given what the machine looks
 * like now and what it looked like at the last successful sync.
 */
export function shouldRequestAutomaticSync(input: {
  state: AutomaticSyncState;
  fingerprint: string;
  now: number;
}): boolean {
  const { state, fingerprint, now } = input;
  if (withinWindow(state.lastRequestedAt, now, AUTOMATIC_SYNC_FLOOR_MS)) return false;
  // Never synced, or synced from a machine state that no longer matches — there
  // is something to push.
  if (!state.lastSyncedAt || state.fingerprint !== fingerprint) return true;
  // Clean. Sync only once the last one is old enough that a remote change could
  // be waiting.
  return !withinWindow(state.lastSyncedAt, now, AUTOMATIC_SYNC_QUIET_MS);
}

/**
 * Whether `timestamp` is in the last `window` milliseconds. A timestamp in the
 * future is not — a clock that jumped backwards must not suppress syncs until
 * it catches up.
 */
function withinWindow(
  timestamp: string | undefined,
  now: number,
  window: number,
): boolean {
  if (!timestamp) return false;
  const elapsed = now - Date.parse(timestamp);
  return elapsed >= 0 && elapsed < window;
}
