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

/** A missing record is a legacy/fresh store; a damaged record must fail closed. */
export function readSyncIdentity(
  databasePath: string,
): SyncIdentityFile | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolveSyncIdentityPath(databasePath), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null)
      throw new Error("invalid record");
    const identity = parsed as SyncIdentityFile;
    if (
      typeof identity.serverUrl !== "string" ||
      !identity.serverUrl.trim() ||
      typeof identity.accountId !== "string" ||
      !identity.accountId.trim() ||
      (identity.identity !== undefined && typeof identity.identity !== "string")
    )
      throw new Error("invalid record");
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "This store's account record could not be read. Restore its sync-identity.json backup before signing in.",
      { cause: error },
    );
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
