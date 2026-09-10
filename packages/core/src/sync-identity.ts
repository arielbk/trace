import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Which cloud account this store's synced work belongs to, persisted beside the
 * database as `sync-identity.json`.
 *
 * A store is one account's work. Without this record the only thing a machine
 * knows at sign-in is that it holds *a* document key — and possession of a key
 * is not identity: a machine previously signed into one account would otherwise
 * sign into a second and push the first account's tasks into it. So the record
 * is written at the moment credentials are persisted, and read before the next
 * sign-in is allowed to persist any.
 *
 * `identity` is the display label the account was signed in under, kept only so
 * a refusal can name the account the user is already in rather than saying "a
 * different account" and leaving them nowhere to go.
 */
export interface SyncIdentityFile {
  /** The sync server this account lives on, normalized as `config.ts` does. */
  serverUrl: string;
  /** The account's stable id on that server. */
  accountId: string;
  /** Presentational: `name <email>` / name / email, as recorded at sign-in. */
  identity?: string;
}

/** Location of the identity file: `sync-identity.json` beside the database. */
export function resolveSyncIdentityPath(databasePath: string): string {
  return join(dirname(resolve(databasePath)), "sync-identity.json");
}

/**
 * The account this store is bound to, or `null` when it is bound to none — a
 * fresh machine, or one that last synced before this record existed. A
 * malformed file reads as `null` rather than throwing: it is answered by the
 * same "unbound store" handling, which is conservative rather than permissive.
 */
export function readSyncIdentity(databasePath: string): SyncIdentityFile | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolveSyncIdentityPath(databasePath), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const identity = parsed as SyncIdentityFile;
    if (
      typeof identity.serverUrl !== "string" ||
      typeof identity.accountId !== "string" ||
      !identity.serverUrl ||
      !identity.accountId
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

/** Atomically bind this store to an account. */
export function writeSyncIdentity(
  databasePath: string,
  identity: SyncIdentityFile,
): void {
  const path = resolveSyncIdentityPath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

/**
 * Whether `candidate` is the account this store is already bound to. Both
 * halves matter: the same account id on a different server is a different
 * account, because ids are only unique within the server that issued them.
 */
export function isSameSyncAccount(
  recorded: SyncIdentityFile,
  candidate: { serverUrl: string; accountId: string },
): boolean {
  return (
    recorded.serverUrl === candidate.serverUrl &&
    recorded.accountId === candidate.accountId
  );
}
