import {
  ACCOUNT_CONFLICT_GUIDANCE,
  assertStoreAccount,
  commitAccountCredentials,
  resolveSyncAccount,
} from "./account-binding.ts";
export { ACCOUNT_CONFLICT_GUIDANCE } from "./account-binding.ts";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  generateTaskKey,
  isSameSyncAccount,
  type LocalAuthService,
  type LoginAttemptView,
  openTraceStore,
  readSyncIdentity,
  REPLACEMENT_KEY_CONFIRMATION,
  resolveDatabasePath,
  type LoginProvider,
  type SyncWrappedKey,
  updateSyncStatusFile,
} from "@trace/core";
import {
  clearStoredCredentials,
  readAuthToken,
  DeviceCodeExpiredError,
  fetchDocManifests,
  pollForAccessToken,
  requestDeviceAuthorization,
  requireServerUrl,
  validateDocumentKey,
  type AuthFetch,
  type DeviceAuthorization,
} from "./auth-service.ts";
import { readStoredDocCryptoKey } from "./commands/key.ts";
import { createKeyTransferRelay } from "./key-transfer-relay.ts";
import {
  createKeyTransferApproverSession,
  startKeyTransferRequest,
  type KeyTransferApproverSession,
  type KeyTransferRequestSession,
} from "./key-transfer-session.ts";
import type { Env } from "./commands/seam.ts";

/**
 * The board adapter over the machine-local auth service: it runs the same
 * device authorization sequence as `eqnx login`, but instead of prompting a
 * terminal it parks the attempt in memory as a {@link LoginAttemptView} the
 * board can poll through `eqnx serve`.
 *
 * Attempts live only in the serving process's memory. Restarting `eqnx serve`
 * abandons any in-flight login, which is the right trade: an attempt is a
 * short-lived foreground interaction, and nothing about it is worth persisting
 * beside the credentials it may produce.
 */

export interface LocalAuthDependencies {
  fetch: AuthFetch;
  sleep: (milliseconds: number) => Promise<void>;
  /**
   * Called once per login that reaches `complete`. The serving process passes
   * its background-sync trigger here: a machine that just signed in has
   * documents waiting for it, and should not have to wait out the periodic
   * interval to see them.
   */
  onLoginComplete: () => void;
}

/** An attempt in flight, plus the parts of it the board must never see. */
interface LoginAttempt {
  view: LoginAttemptView;
  cancelled: boolean;
  /** Fired by {@link setView}, once, when this attempt reaches `complete`. */
  onComplete: () => void;
  /**
   * What a `waiting-for-existing-key` attempt needs to finish once the user
   * supplies their key: the approved bearer token, the server it came from, and
   * the wrapped keys to validate against. Deliberately kept off the view — an
   * approved-but-unfinished login already holds a token, and this is where it
   * waits without ever crossing to the browser.
   */
  keySetup?: {
    serverUrl: string;
    accessToken: string;
    wrappedKeys: SyncWrappedKey[];
    /** The account the token belongs to, resolved once before any key check, so
     * every path that persists credentials binds the store to the same account
     * the identity check was made against. */
    account: { accountId: string; identity?: string };
  };
  /**
   * The live request to be let in by another of this account's machines, when
   * the user chose that over typing their recovery key. Held here rather than
   * on the view: the view is what the browser sees, and this holds an
   * ephemeral private key.
   */
  transfer?: KeyTransferRequestSession;
}

/** The attempt as the board may see it: its own view, plus whatever the
 * transfer request has got to. */
function viewOf(attempt: LoginAttempt): LoginAttemptView {
  return attempt.transfer
    ? { ...attempt.view, transfer: attempt.transfer.view }
    : attempt.view;
}

export function createLocalAuthService(
  env: Env,
  dependencies: Partial<LocalAuthDependencies> = {},
): LocalAuthService {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const onLoginComplete = dependencies.onLoginComplete ?? (() => {});

  const attempts = new Map<string, LoginAttempt>();

  /**
   * This machine's approver, built from the credentials already on disk and
   * kept for the life of the process: `open` and `approve` are two halves of
   * one exchange, and a fresh session between them would offer a second key
   * for a code the user already compared.
   */
  let approver: { serverUrl: string; token: string; session: KeyTransferApproverSession } | undefined;

  async function approverSession(): Promise<KeyTransferApproverSession> {
    const serverUrl = requireServerUrl(env);
    const token = readAuthToken(env)?.accessToken;
    if (!token) throw new Error(NOT_SIGNED_IN_MESSAGE);
    const masterKey = readStoredDocCryptoKey(env);
    if (!masterKey) throw new Error(NO_KEY_TO_SHARE_MESSAGE);
    if (approver && approver.serverUrl === serverUrl && approver.token === token) {
      return approver.session;
    }
    // Who this machine is signed in as is asked of the server, not of the
    // request being approved: the relay names an account in every record it
    // hands over, and believing that is how a machine approves a stranger.
    const account = await resolveSyncAccount(serverUrl, fetch, token);
    assertStoreAccount(env, serverUrl, account);
    const session = createKeyTransferApproverSession({
      relay: createKeyTransferRelay({ serverUrl, fetch, accessToken: token }),
      accountId: account.accountId,
      serviceOrigin: new URL(serverUrl).origin,
      masterKey,
      sleep,
    });
    approver = { serverUrl, token, session };
    return session;
  }

  return {
    async startLogin(provider: LoginProvider): Promise<LoginAttemptView> {
      const serverUrl = requireServerUrl(env);
      const device = await requestDeviceAuthorization(
        serverUrl,
        fetch,
        provider,
      );
      const attempt: LoginAttempt = {
        view: {
          attemptId: randomUUID(),
          state: "waiting-for-approval",
          provider,
          verificationUrl: device.verificationUrl,
          userCode: device.userCode,
        },
        cancelled: false,
        onComplete: onLoginComplete,
      };
      attempts.set(attempt.view.attemptId, attempt);

      // The board polls `GET /api/local-auth/login/:attemptId` for progress, so
      // the sequence runs detached from the request that started it. Every
      // outcome is recorded on the attempt; nothing is thrown into the void.
      void completeLogin(env, serverUrl, fetch, sleep, device, attempt);

      return viewOf(attempt);
    },

    readLogin(attemptId: string): LoginAttemptView | null {
      const attempt = attempts.get(attemptId);
      return attempt ? viewOf(attempt) : null;
    },

    readCurrentLogin(): LoginAttemptView | null {
      // Newest first: starting a second login supersedes whatever the user
      // walked away from, so the one they are standing in front of wins.
      for (const attempt of [...attempts.values()].reverse()) {
        if (!SETTLED_STATES.includes(attempt.view.state)) return viewOf(attempt);
      }
      return null;
    },

    acknowledgeGeneratedKey(attemptId: string): LoginAttemptView | null {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      if (attempt.view.state !== "showing-generated-key") return viewOf(attempt);
      // Credentials were stored when the key was generated; acknowledgement is
      // purely about having shown the key once, so it just drops it.
      const shown = { ...attempt.view };
      delete shown.generatedKey;
      setView(attempt, { ...shown, state: "complete" });
      return viewOf(attempt);
    },

    async submitExistingKey(
      attemptId: string,
      key: string,
    ): Promise<LoginAttemptView | null> {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      const setup = attempt.keySetup;
      if (!setup || attempt.view.state !== "waiting-for-existing-key") {
        return viewOf(attempt);
      }

      let masterKey: string;
      try {
        masterKey = validateDocumentKey(key, setup.wrappedKeys);
      } catch (error) {
        // A wrong key is not a failed login: the user stays on the prompt with
        // the reason, and nothing at all has been written.
        setView(attempt, {
          ...attempt.view,
          error: error instanceof Error ? error.message : String(error),
        });
        return viewOf(attempt);
      }

      setView(attempt, { ...attempt.view, error: undefined });
      finishKeySetup(env, attempt, "complete", undefined, masterKey);
      // The user got there first; the other machine should stop being asked.
      void attempt.transfer?.cancel();
      return viewOf(attempt);
    },

    async generateReplacementKey(
      attemptId: string,
      confirmation: string,
    ): Promise<LoginAttemptView | null> {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      if (
        !attempt.keySetup ||
        attempt.view.state !== "waiting-for-existing-key"
      ) {
        return viewOf(attempt);
      }

      if (confirmation.trim() !== REPLACEMENT_KEY_CONFIRMATION) {
        setView(attempt, {
          ...attempt.view,
          error: `Type ${REPLACEMENT_KEY_CONFIRMATION} to confirm replacing your document encryption key.`,
        });
        return viewOf(attempt);
      }

      const masterKey = generateTaskKey();
      setView(attempt, { ...attempt.view, error: undefined });
      // Shown once, exactly as a fresh account's key is: this key is now the
      // only thing that can read anything this machine syncs from here on.
      finishKeySetup(env, attempt, "showing-generated-key", masterKey);
      return viewOf(attempt);
    },

    async requestKeyTransfer(attemptId: string): Promise<LoginAttemptView | null> {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      const setup = attempt.keySetup;
      if (!setup || attempt.view.state !== "waiting-for-existing-key") {
        return viewOf(attempt);
      }
      // One live request per attempt: a second would mint a second commitment
      // and leave the user comparing a code for an exchange nobody is in.
      if (attempt.transfer && !isSettledTransfer(attempt.transfer)) {
        return viewOf(attempt);
      }

      try {
        attempt.transfer = await startKeyTransferRequest({
          relay: createKeyTransferRelay({
            serverUrl: setup.serverUrl,
            fetch,
            accessToken: setup.accessToken,
          }),
          // Descriptive, never proof: the user is told to compare codes, not
          // names. See docs/key-transfer-protocol.md.
          machineName: hostname(),
          accountId: setup.account.accountId,
          serviceOrigin: new URL(setup.serverUrl).origin,
          wrappedKeys: setup.wrappedKeys,
          sleep,
          // The delivered key has already been proven against this account's
          // wrapped keys by the time this runs, and this is the same commit
          // the typed-key path makes.
          onKey: (masterKey) => {
            setView(attempt, { ...attempt.view, error: undefined });
            finishKeySetup(env, attempt, "complete", undefined, masterKey);
          },
        });
      } catch (error) {
        // Asking failed; the key prompt is still there, which is the whole
        // reason approval is an alternative to it rather than a replacement.
        setView(attempt, {
          ...attempt.view,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return viewOf(attempt);
    },

    async cancelKeyTransfer(attemptId: string): Promise<LoginAttemptView | null> {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      await attempt.transfer?.cancel();
      return viewOf(attempt);
    },

    async listKeyTransfers() {
      return (await approverSession()).list();
    },

    async openKeyTransfer(requestId: string) {
      return (await approverSession()).inspect(requestId);
    },

    async approveKeyTransfer(requestId: string) {
      const session = await approverSession();
      await session.approve(requestId);
      return session.inspect(requestId);
    },

    async denyKeyTransfer(requestId: string) {
      const session = await approverSession();
      await session.deny(requestId);
      return { requestId, locator: "", machineName: "", state: "gone" as const };
    },

    cancelLogin(attemptId: string): LoginAttemptView | null {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      attempt.cancelled = true;
      // The transfer holds a live request on the relay; cancelling the login
      // without cancelling it would leave the other machine looking at a row
      // nobody is waiting on.
      void attempt.transfer?.cancel();
      if (!SETTLED_STATES.includes(attempt.view.state)) {
        setView(attempt, { ...attempt.view, state: "cancelled" });
      }
      return viewOf(attempt);
    },

    logout(): void {
      clearStoredCredentials(env);
    },
  };
}

/** Drive an approved device code through to stored credentials. */
async function completeLogin(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  sleep: LocalAuthDependencies["sleep"],
  device: DeviceAuthorization,
  attempt: LoginAttempt,
): Promise<void> {
  try {
    const accessToken = await pollForAccessToken(
      serverUrl,
      fetch,
      sleep,
      device,
      () => attempt.cancelled,
    );
    await setUpDocumentKey(env, serverUrl, fetch, accessToken, attempt);
  } catch (error) {
    settleFailure(attempt, error);
  }
}

/**
 * Establish the document encryption key this machine needs before its bearer
 * token is worth storing.
 *
 * An empty account gets a fresh key, shown once for the user to save. An
 * account that already holds synced documents needs the existing key, which the
 * board must supply — until then no credentials are persisted, so an abandoned
 * key step leaves the machine fully signed out rather than half signed in.
 *
 * Two questions come before either: is this store already somebody else's, and
 * is the key already on this machine actually this account's? Both are asked
 * here rather than at push time, because credentials written are a push waiting
 * to happen.
 */
async function setUpDocumentKey(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
  attempt: LoginAttempt,
): Promise<void> {
  const account = await resolveSyncAccount(serverUrl, fetch, accessToken);
  if (attempt.cancelled) return;
  const bound = readBoundAccount(env);
  if (
    bound &&
    !isSameSyncAccount(bound, { serverUrl, accountId: account.accountId })
  ) {
    // Terminal, not a key prompt: offering to type the other account's key
    // would merge two accounts' work into one store.
    settleAccountConflict(attempt, bound.identity ?? bound.accountId);
    return;
  }

  const { manifests, wrappedKeys } = await fetchDocManifests(
    serverUrl,
    fetch,
    accessToken,
  );
  if (attempt.cancelled) return;
  attempt.keySetup = { serverUrl, accessToken, wrappedKeys, account };

  // A key already on this machine is a candidate, never a credential. Holding
  // some account's key says nothing about the account that just signed in, so
  // it is put to the same test as one the user types: unwrap this account's own
  // wrapped key, or ask for the right one.
  const stored = readStoredDocCryptoKey(env);
  const storedOpensAccount =
    stored !== null && opensAccount(stored, wrappedKeys);

  // A store that has synced before but records no account predates this binding
  // (or had its record removed). Its work came from *some* account, and the only
  // evidence available that this is that account is its own key opening this
  // account's wrapped keys. Without that evidence, signing in would quietly make
  // this account the new home of work that did not come from it.
  if (!bound && !storedOpensAccount && storeHasSyncHistory(env)) {
    settleAccountConflict(attempt, "another account");
    return;
  }

  if (stored && wrappedKeys.length > 0) {
    if (!storedOpensAccount) {
      setView(attempt, { ...attempt.view, state: "waiting-for-existing-key" });
      return;
    }
    finishKeySetup(env, attempt, "complete");
    return;
  }
  if (stored) {
    // Nothing on the account to check against, and nothing to lose by keeping
    // the key this machine already uses for its own documents.
    finishKeySetup(env, attempt, "complete");
    return;
  }

  if (manifests.length > 0) {
    setView(attempt, { ...attempt.view, state: "waiting-for-existing-key" });
    return;
  }

  const masterKey = generateTaskKey();
  // The attempt goes straight to `showing-generated-key` — never through
  // `complete` — so a poll cannot land between the two and rob the user of the
  // one showing of their key. Acknowledging it is what completes the login.
  finishKeySetup(env, attempt, "showing-generated-key", masterKey);
}

/**
 * Store the credentials this machine has now earned a document key for, and
 * move the attempt to its post-key state. Persisting the bearer token here, and
 * only here, is what makes "no key, no credentials" true of every path.
 */
function finishKeySetup(
  env: Env,
  attempt: LoginAttempt,
  state: LoginAttemptView["state"],
  generatedKey?: string,
  submittedKey?: string,
): void {
  const setup = attempt.keySetup;
  if (!setup || attempt.cancelled) return;
  // No asynchronous work after this point: cancellation cannot interleave with
  // credential persistence and turn a cancelled attempt into a completed one.
  try {
    commitAccountCredentials(
      env,
      setup.serverUrl,
      setup.account,
      setup.accessToken,
      submittedKey ?? generatedKey,
    );
  } catch (error) {
    settleFailure(attempt, error);
    return;
  }
  const identity = setup.account.identity ?? null;
  try {
    updateSyncStatusFile(resolveDatabasePath(env), {
      loggedIn: true,
      ...(identity ? { identity } : {}),
      lastError: undefined,
      activeRun: undefined,
    });
  } catch {
    /* Status is presentational; the credential commit already succeeded. */
  }
  delete attempt.keySetup;
  settle(attempt, state, identity, generatedKey);
}

/**
 * Refuse the login and name what the store already belongs to. Account
 * switching and migration are deliberately out of scope, so the honest answer
 * is to say what is in the way and where a different account can live.
 */
function settleAccountConflict(attempt: LoginAttempt, held: string): void {
  setView(attempt, {
    ...attempt.view,
    state: "failed",
    error: `This machine already holds work synced from ${held}. ${ACCOUNT_CONFLICT_GUIDANCE}`,
  });
}

/** The account this store is bound to, if any. */
function readBoundAccount(env: Env) {
  return readSyncIdentity(resolveDatabasePath(env));
}

/** Whether `key` unwraps one of this account's own wrapped task keys — the only
 * evidence available that a key and an account belong together. */
function opensAccount(key: string, wrappedKeys: SyncWrappedKey[]): boolean {
  if (wrappedKeys.length === 0) return false;
  try {
    validateDocumentKey(key, wrappedKeys);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this store has ever pulled from a sync server. The cursor is the
 * record of that: null means "has never seen one", which is exactly the fresh
 * machine this journey is about. An unreadable store answers `false` — a
 * missing database is a machine with nothing to protect.
 */
function storeHasSyncHistory(env: Env): boolean {
  try {
    const store = openTraceStore(resolveDatabasePath(env));
    try {
      return store.syncCursor("rows") !== null;
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

function settle(
  attempt: LoginAttempt,
  state: LoginAttemptView["state"],
  identity: string | null,
  generatedKey?: string,
): void {
  setView(attempt, {
    ...attempt.view,
    state,
    ...(identity ? { identity } : {}),
    ...(generatedKey ? { generatedKey } : {}),
  });
}

/**
 * The one writer of an attempt's view, and the one place a login is observed to
 * complete. Hanging the completion hook off the *transition* into `complete` —
 * rather than off each of the paths that reaches it — is what makes "one sync
 * per login" true of all of them, and true only once: a later write that leaves
 * the attempt complete does not fire it again.
 */
function setView(attempt: LoginAttempt, view: LoginAttemptView): void {
  const completed =
    view.state === "complete" && attempt.view.state !== "complete";
  attempt.view = view;
  if (completed) attempt.onComplete();
}

/** Whether a transfer request has finished being worth waiting on. */
function isSettledTransfer(transfer: KeyTransferRequestSession): boolean {
  return transfer.view.state !== "waiting-for-approval" &&
    transfer.view.state !== "comparing";
}

/** States an attempt never leaves once it reaches them. */
const SETTLED_STATES: readonly LoginAttemptView["state"][] = [
  "complete",
  "failed",
  "expired",
  "cancelled",
];

export const NOT_SIGNED_IN_MESSAGE =
  "This machine is not signed in, so it cannot approve another machine.";

export const NO_KEY_TO_SHARE_MESSAGE =
  "This machine has no document encryption key to share.";

export const LOGIN_EXPIRED_MESSAGE =
  "The sign-in request expired before it was approved. Start again to sign in.";

function settleFailure(attempt: LoginAttempt, error: unknown): void {
  // A cancelled attempt tears the polling loop down by throwing; the user's
  // explicit cancellation is the outcome that matters, not the interruption.
  if (attempt.cancelled) return;
  if (error instanceof DeviceCodeExpiredError) {
    setView(attempt, {
      ...attempt.view,
      state: "expired",
      error: LOGIN_EXPIRED_MESSAGE,
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  setView(attempt, { ...attempt.view, state: "failed", error: message });
}
