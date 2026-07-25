import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createKeyWrapper,
  resolveConfiguredServerUrl,
  resolveDatabasePath,
  updateSyncStatusFile,
  writeSyncStatusFile,
  type SyncDocManifest,
  type SyncWrappedKey,
} from "@trace/core";
import type { Env } from "./commands/seam.ts";

/**
 * The machine-local auth service: the device authorization sequence, document
 * manifest lookup, and credential persistence, with no presentation attached.
 *
 * Two adapters drive it — the terminal (`trace login`, in `commands/auth.ts`)
 * and the board (`local-auth.ts`, behind `trace serve`'s `/api/local-auth`
 * endpoints). Both must reach the same hosted endpoints and write the same
 * files, so the sequence lives here once rather than being reimplemented per
 * surface.
 */

export const CLIENT_ID = "trace-cli";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// RFC 8628 makes expires_in required, but a server that omits it must not
// grant us an immortal polling loop; Better Auth's default lifetime is 30min.
export const DEVICE_CODE_LIFETIME_FALLBACK_SECONDS = 30 * 60;

/**
 * Cloud features are flagged off until a server URL is configured
 * (`TRACE_SERVER_URL` or `trace config set server-url`); auth entry points fail
 * with this message rather than guessing at a server.
 */
export const NO_SERVER_CONFIGURED_MESSAGE =
  "No sync server configured. Run trace config set server-url <url>.";

export function requireServerUrl(env: Env): string {
  const serverUrl = resolveConfiguredServerUrl(env);
  if (!serverUrl) throw new Error(NO_SERVER_CONFIGURED_MESSAGE);
  return serverUrl;
}

export type AuthFetch = typeof globalThis.fetch;

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  /** The URL the user must visit — `verification_uri_complete` when the server
   * offers it, so the code is pre-filled. */
  verificationUrl: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

/** Ask the hosted server for a device code to approve. */
export async function requestDeviceAuthorization(
  serverUrl: string,
  fetch: AuthFetch,
  provider?: string,
): Promise<DeviceAuthorization> {
  const response = await fetch(`${serverUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      ...(provider ? { provider } : {}),
    }),
  });
  const code = await readJson<DeviceCodeResponse>(response);

  if (!response.ok) throw new Error(errorMessage(code));
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new Error("Auth server returned an invalid device code response");
  }

  return {
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUrl: code.verification_uri_complete ?? code.verification_uri,
    // RFC 8628: poll no faster than every 5 seconds.
    intervalSeconds: Math.max(code.interval ?? 5, 5),
    expiresInSeconds: code.expires_in ?? DEVICE_CODE_LIFETIME_FALLBACK_SECONDS,
  };
}

export const DEVICE_CODE_EXPIRED_MESSAGE =
  "Device code expired before the login was approved. Run trace login to try again.";

/** Thrown when the device code's lifetime runs out unapproved. Distinguished
 * from any other failure so an adapter can word the outcome for its own surface
 * (the board has no terminal to run `trace login` in). */
export class DeviceCodeExpiredError extends Error {
  constructor() {
    super(DEVICE_CODE_EXPIRED_MESSAGE);
    this.name = "DeviceCodeExpiredError";
  }
}

/**
 * Poll the token endpoint until the user approves, the attempt is refused, the
 * device code expires, or `shouldStop` asks us to give up (the board's cancel
 * action). Returns the bearer token; every other outcome throws.
 */
export async function pollForAccessToken(
  serverUrl: string,
  fetch: AuthFetch,
  sleep: (milliseconds: number) => Promise<void>,
  device: DeviceAuthorization,
  shouldStop?: () => boolean,
): Promise<string> {
  let interval = device.intervalSeconds;
  // Stop once the device code expires instead of polling forever on an
  // abandoned browser flow.
  for (let waited = 0; waited < device.expiresInSeconds; waited += interval) {
    await sleep(interval * 1_000);
    if (shouldStop?.()) throw new Error("Login cancelled");
    const response = await fetch(`${serverUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    });
    const token = await readJson<TokenResponse>(response);

    if (response.ok && token.access_token) return token.access_token;
    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error(errorMessage(token));
  }
  throw new DeviceCodeExpiredError();
}

/**
 * The `/api/sync/docs/manifests` response: manifests paired with the wrapped
 * DEK for each task (parallel arrays, keyed by `taskId`). Login only needs a
 * wrapped key to validate a master key by unwrapping it — and the manifest
 * count to tell an empty account from one holding synced documents.
 */
export interface DocManifests {
  manifests: SyncDocManifest[];
  wrappedKeys: SyncWrappedKey[];
}

export async function fetchDocManifests(
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
): Promise<DocManifests> {
  const response = await fetch(`${serverUrl}/api/sync/docs/manifests`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson<Partial<DocManifests>>(response);
  if (!response.ok) throw new Error(errorMessage(body as ErrorResponse));
  if (!Array.isArray(body.manifests) || !Array.isArray(body.wrappedKeys)) {
    throw new Error("Sync server returned an invalid document manifest response");
  }
  return { manifests: body.manifests, wrappedKeys: body.wrappedKeys };
}

export const INVALID_DOCUMENT_KEY_MESSAGE =
  "That document encryption key could not decrypt your synced documents.";

/**
 * Prove a submitted master key against the account's own data, returning the
 * key in its canonical form.
 *
 * The master key is a KEK: it never opens a manifest directly. So the check is
 * to unwrap any one stored wrapped task key — an AEAD tag failure (or a
 * malformed key) means the wrong master key. Both adapters validate *before*
 * writing anything, so a wrong key leaves the machine exactly as it was.
 */
export function validateDocumentKey(
  entered: string,
  wrappedKeys: SyncWrappedKey[],
): string {
  const candidate = entered.trim();
  const [wrapped] = wrappedKeys;
  try {
    if (typeof wrapped?.wrappedKey !== "string") throw new Error("missing wrapped key");
    createKeyWrapper(candidate).unwrapTaskKey(wrapped.wrappedKey);
  } catch {
    throw new Error(INVALID_DOCUMENT_KEY_MESSAGE);
  }
  return candidate.toLowerCase();
}

export interface AuthToken {
  accessToken: string;
}

export function resolveAuthTokenPath(env: Env): string {
  return join(env.HOME ?? homedir(), ".trace", "auth.json");
}

export function readAuthToken(env: Env): AuthToken | null {
  try {
    const token = JSON.parse(
      readFileSync(resolveAuthTokenPath(env), "utf8"),
    ) as AuthToken;
    return typeof token.accessToken === "string" ? token : null;
  } catch {
    return null;
  }
}

export function writeAuthToken(env: Env, token: AuthToken): void {
  const path = resolveAuthTokenPath(env);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(token), { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

/** Remove the machine's bearer token and reset the board's sync header. The
 * document encryption key is deliberately kept: logging out is not the same as
 * abandoning the ability to read already-synced documents. */
export function clearStoredCredentials(env: Env): void {
  rmSync(resolveAuthTokenPath(env), { force: true });
  // Clear the board's sync header so it falls back to "not logged in".
  try {
    writeSyncStatusFile(resolveDatabasePath(env), { loggedIn: false });
  } catch {
    // Best-effort: a missing database path must not fail logout.
  }
}

/** Resolve a display identity (`name <email>` / name / email / id) from a session. */
export function identityFromSession(session: SessionResponse): string | null {
  const user = session.user;
  if (!user) return null;
  const label = user.name ?? user.email ?? user.id;
  if (!label) return null;
  const email = user.email ? ` <${user.email}>` : "";
  return `${label}${email}`;
}

export async function fetchSession(
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
): Promise<SessionResponse | null> {
  const response = await fetch(`${serverUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const session = await readJson<SessionResponse>(response);
  return response.ok ? session : null;
}

/**
 * Record the signed-in state (and, best-effort, the provider identity) for the
 * board's sync header. Login has already succeeded by this point, so any
 * failure here — an unreachable session endpoint, an unresolvable database
 * path — must be swallowed rather than surfaced to the user. Returns the
 * identity it managed to resolve, for adapters that want to show it.
 */
export async function recordSignedIn(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
): Promise<string | null> {
  let identity: string | null = null;
  try {
    const session = await fetchSession(serverUrl, fetch, accessToken);
    identity = session ? identityFromSession(session) : null;
  } catch {
    // Identity is a nice-to-have; fall through to recording just the login.
  }
  try {
    updateSyncStatusFile(resolveDatabasePath(env), {
      loggedIn: true,
      ...(identity ? { identity } : {}),
      lastError: undefined,
      // A run left behind by an earlier session belongs to that session, not to
      // this one: signing in must not open on a spinner.
      activeRun: undefined,
    });
  } catch {
    // No usable database path — the board simply won't show a header yet.
  }
  return identity;
}

export async function readJson<T>(response: Response): Promise<T & ErrorResponse> {
  try {
    return (await response.json()) as T & ErrorResponse;
  } catch {
    return {} as T & ErrorResponse;
  }
}

export function errorMessage(response: ErrorResponse): string {
  return (
    response.error_description ?? response.error ?? "Authentication request failed"
  );
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface TokenResponse extends ErrorResponse {
  access_token?: string;
}

export interface ErrorResponse {
  error?: string;
  error_description?: string;
}

export interface SessionResponse {
  user?: { id?: string; name?: string; email?: string };
}
