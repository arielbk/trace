import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  isSameSyncAccount,
  openTraceStore,
  type SyncWrappedKey,
  readSyncIdentity,
  resolveDatabasePath,
  resolveSyncIdentityPath,
  writeSyncIdentity,
} from "@trace/core";
import {
  fetchSession,
  AuthenticationRequiredError,
  validateDocumentKey,
  identityFromSession,
  resolveAuthTokenPath,
  writeAuthToken,
  type AuthFetch,
} from "./auth-service.ts";
import {
  readStoredDocCryptoKey,
  resolveStoredDocCryptoKeyPath,
  writeStoredDocCryptoKey,
} from "./commands/key.ts";
import type { Env } from "./commands/seam.ts";

export interface SyncAccount {
  accountId: string;
  identity?: string;
}
export const ACCOUNT_CONFLICT_GUIDANCE =
  "To use a different account, use a separate HOME and EQNX store for it.";

/** Identity is an authorization prerequisite, not a best-effort display label. */
export async function resolveSyncAccount(
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
): Promise<SyncAccount> {
  let session;
  try {
    session = await fetchSession(serverUrl, fetch, accessToken);
  } catch {
    throw new Error(
      "Could not confirm which account signed in. Try signing in again when the sync service is available.",
    );
  }
  if (session === null) throw new AuthenticationRequiredError();
  const accountId = session?.user?.id;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error(
      "Could not confirm which account signed in. The sync service must return a stable account ID.",
    );
  }
  const identity = identityFromSession(session!);
  return { accountId, ...(identity ? { identity } : {}) };
}

export function assertStoreAccount(
  env: Env,
  serverUrl: string,
  account: SyncAccount,
): void {
  const bound = readSyncIdentity(resolveDatabasePath(env));
  if (
    bound &&
    !isSameSyncAccount(bound, { serverUrl, accountId: account.accountId })
  ) {
    throw new Error(
      `This machine already holds work synced from ${bound.identity ?? bound.accountId}. ${ACCOUNT_CONFLICT_GUIDANCE}`,
    );
  }
}

/** Commit with no await points. Failure rolls back already-written files; a
 * crash can leave a binding before credentials, never credentials before a binding. */
export function commitAccountCredentials(
  env: Env,
  serverUrl: string,
  account: SyncAccount,
  accessToken: string,
  masterKey?: string,
): void {
  assertStoreAccount(env, serverUrl, account);
  const databasePath = resolveDatabasePath(env);
  const writes = [
    {
      path: resolveSyncIdentityPath(databasePath),
      write: () => writeSyncIdentity(databasePath, { serverUrl, ...account }),
    },
    ...(masterKey
      ? [
          {
            path: resolveStoredDocCryptoKeyPath(env),
            write: () => writeStoredDocCryptoKey(env, masterKey),
          },
        ]
      : []),
    {
      path: resolveAuthTokenPath(env),
      write: () => writeAuthToken(env, { accessToken }),
    },
  ];
  // Snapshot every file before the first mutation; unreadable is never absent.
  const snapshots = writes.map(({ path }) => {
    try {
      return readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  let attempted = 0;
  try {
    for (const entry of writes) {
      attempted++;
      entry.write();
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (let i = attempted - 1; i >= 0; i--) {
      const entry = writes[i]!;
      const previous = snapshots[i]!;
      try {
        if (previous === null) rmSync(entry.path, { force: true });
        else {
          const temporary = `${entry.path}.${process.pid}.rollback`;
          writeFileSync(temporary, previous, { mode: 0o600 });
          renameSync(temporary, entry.path);
        }
      } catch (rollback) {
        failures.push(rollback);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Credential commit failed and could not fully roll back. Restore this machine's credential and account-record backup before syncing.",
      );
    throw error;
  }
}

/** A legacy store with sync history needs cryptographic evidence of ownership
 * before its first account binding; an empty remote account supplies none. */
export function assertLegacyStoreAccount(
  env: Env,
  wrappedKeys: SyncWrappedKey[],
): void {
  const databasePath = resolveDatabasePath(env);
  if (readSyncIdentity(databasePath)) return;
  const stored = readStoredDocCryptoKey(env);
  if (stored && wrappedKeys.length > 0) {
    validateDocumentKey(stored, wrappedKeys);
    return;
  }
  const store = openTraceStore(databasePath);
  try {
    if (store.syncCursor("rows") !== null) {
      throw new Error(
        `This legacy store's account could not be proven from its document key. ${ACCOUNT_CONFLICT_GUIDANCE}`,
      );
    }
  } finally {
    store.close();
  }
}
