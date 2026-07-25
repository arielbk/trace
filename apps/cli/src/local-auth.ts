import { randomUUID } from "node:crypto";
import {
  generateTaskKey,
  type LocalAuthService,
  type LoginAttemptView,
  type LoginProvider,
} from "@trace/core";
import {
  clearStoredCredentials,
  DeviceCodeExpiredError,
  fetchDocManifests,
  pollForAccessToken,
  recordSignedIn,
  requestDeviceAuthorization,
  requireServerUrl,
  writeAuthToken,
  type AuthFetch,
  type DeviceAuthorization,
} from "./auth-service.ts";
import { readStoredDocCryptoKey, writeStoredDocCryptoKey } from "./commands/key.ts";
import type { Env } from "./commands/seam.ts";

/**
 * The board adapter over the machine-local auth service: it runs the same
 * device authorization sequence as `trace login`, but instead of prompting a
 * terminal it parks the attempt in memory as a {@link LoginAttemptView} the
 * board can poll through `trace serve`.
 *
 * Attempts live only in the serving process's memory. Restarting `trace serve`
 * abandons any in-flight login, which is the right trade: an attempt is a
 * short-lived foreground interaction, and nothing about it is worth persisting
 * beside the credentials it may produce.
 */

export interface LocalAuthDependencies {
  fetch: AuthFetch;
  sleep: (milliseconds: number) => Promise<void>;
}

/** An attempt in flight, plus the parts of it the board must never see. */
interface LoginAttempt {
  view: LoginAttemptView;
  cancelled: boolean;
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

  const attempts = new Map<string, LoginAttempt>();

  return {
    async startLogin(provider: LoginProvider): Promise<LoginAttemptView> {
      const serverUrl = requireServerUrl(env);
      const device = await requestDeviceAuthorization(serverUrl, fetch, provider);
      const attempt: LoginAttempt = {
        view: {
          attemptId: randomUUID(),
          state: "waiting-for-approval",
          provider,
          verificationUrl: device.verificationUrl,
          userCode: device.userCode,
        },
        cancelled: false,
      };
      attempts.set(attempt.view.attemptId, attempt);

      // The board polls `GET /api/local-auth/login/:attemptId` for progress, so
      // the sequence runs detached from the request that started it. Every
      // outcome is recorded on the attempt; nothing is thrown into the void.
      void completeLogin(env, serverUrl, fetch, sleep, device, attempt);

      return attempt.view;
    },

    readLogin(attemptId: string): LoginAttemptView | null {
      return attempts.get(attemptId)?.view ?? null;
    },

    acknowledgeGeneratedKey(attemptId: string): LoginAttemptView | null {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      if (attempt.view.state !== "showing-generated-key") return attempt.view;
      // Credentials were stored when the key was generated; acknowledgement is
      // purely about having shown the key once, so it just drops it.
      const shown = { ...attempt.view };
      delete shown.generatedKey;
      attempt.view = { ...shown, state: "complete" };
      return attempt.view;
    },

    cancelLogin(attemptId: string): LoginAttemptView | null {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      attempt.cancelled = true;
      if (!SETTLED_STATES.includes(attempt.view.state)) {
        attempt.view = { ...attempt.view, state: "cancelled" };
      }
      return attempt.view;
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
 */
async function setUpDocumentKey(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
  attempt: LoginAttempt,
): Promise<void> {
  if (readStoredDocCryptoKey(env)) {
    const identity = await persistCredentials(env, serverUrl, fetch, accessToken);
    settle(attempt, "complete", identity);
    return;
  }

  const { manifests } = await fetchDocManifests(serverUrl, fetch, accessToken);
  if (manifests.length > 0) {
    attempt.view = { ...attempt.view, state: "waiting-for-existing-key" };
    return;
  }

  const masterKey = generateTaskKey();
  writeStoredDocCryptoKey(env, masterKey);
  const identity = await persistCredentials(env, serverUrl, fetch, accessToken);
  // The attempt goes straight to `showing-generated-key` — never through
  // `complete` — so a poll cannot land between the two and rob the user of the
  // one showing of their key. Acknowledging it is what completes the login.
  settle(attempt, "showing-generated-key", identity, masterKey);
}

/** Store the bearer token and record the signed-in identity, returning it. */
async function persistCredentials(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
): Promise<string | null> {
  writeAuthToken(env, { accessToken });
  return recordSignedIn(env, serverUrl, fetch, accessToken);
}

function settle(
  attempt: LoginAttempt,
  state: LoginAttemptView["state"],
  identity: string | null,
  generatedKey?: string,
): void {
  attempt.view = {
    ...attempt.view,
    state,
    ...(identity ? { identity } : {}),
    ...(generatedKey ? { generatedKey } : {}),
  };
}

/** States an attempt never leaves once it reaches them. */
const SETTLED_STATES: readonly LoginAttemptView["state"][] = [
  "complete",
  "failed",
  "expired",
  "cancelled",
];

export const LOGIN_EXPIRED_MESSAGE =
  "The sign-in request expired before it was approved. Start again to sign in.";

function settleFailure(attempt: LoginAttempt, error: unknown): void {
  // A cancelled attempt tears the polling loop down by throwing; the user's
  // explicit cancellation is the outcome that matters, not the interruption.
  if (attempt.cancelled) return;
  if (error instanceof DeviceCodeExpiredError) {
    attempt.view = {
      ...attempt.view,
      state: "expired",
      error: LOGIN_EXPIRED_MESSAGE,
    };
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  attempt.view = { ...attempt.view, state: "failed", error: message };
}
