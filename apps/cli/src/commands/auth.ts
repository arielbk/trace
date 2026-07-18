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
import { createInterface } from "node:readline/promises";
import {
  createKeyWrapper,
  generateTaskKey,
  resolveConfiguredServerUrl,
  resolveDatabasePath,
  updateSyncStatusFile,
  writeSyncStatusFile,
  type SyncDocManifest,
  type SyncWrappedKey,
} from "@trace/core";
import { openBrowser } from "../open-browser.ts";
import {
  readStoredDocCryptoKey,
  writeStoredDocCryptoKey,
} from "./key.ts";
import type { CommandResult, Env } from "./seam.ts";

const CLIENT_ID = "trace-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// RFC 8628 makes expires_in required, but a server that omits it must not
// grant us an immortal polling loop; Better Auth's default lifetime is 30min.
const DEVICE_CODE_LIFETIME_FALLBACK_SECONDS = 30 * 60;

export interface AuthDependencies {
  fetch: typeof globalThis.fetch;
  sleep: (milliseconds: number) => Promise<void>;
  openBrowser: (url: string) => void;
  onOutput?: (output: string) => void;
  prompt: (message: string) => Promise<string>;
}

interface AuthToken {
  accessToken: string;
}

const defaultDependencies: AuthDependencies = {
  fetch: globalThis.fetch,
  openBrowser,
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  prompt: async (message) => {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await readline.question(message);
    } finally {
      readline.close();
    }
  },
};

export async function runAuthCommand(
  command: "login" | "logout" | "whoami",
  env: Env,
  dependencies: Partial<AuthDependencies> = {},
): Promise<CommandResult> {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  try {
    if (command === "login") return await login(env, resolvedDependencies);
    if (command === "logout") return logout(env);
    return await whoami(env, resolvedDependencies);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

async function login(
  env: Env,
  { fetch, sleep, openBrowser, onOutput, prompt: ask }: AuthDependencies,
): Promise<CommandResult> {
  const serverUrl = requireServerUrl(env);
  const codeResponse = await fetch(`${serverUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const code = await readJson<DeviceCodeResponse>(codeResponse);

  if (!codeResponse.ok) throw new Error(errorMessage(code));
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new Error("Auth server returned an invalid device code response");
  }

  const verificationUrl =
    code.verification_uri_complete ?? code.verification_uri;
  const prompt = `Visit ${verificationUrl}\nCode: ${code.user_code}\n`;
  onOutput?.(prompt);
  openBrowser(verificationUrl);
  // RFC 8628: poll no faster than every 5 seconds, and stop once the device
  // code expires instead of polling forever on an abandoned browser flow.
  let interval = Math.max(code.interval ?? 5, 5);
  const expiresIn = code.expires_in ?? DEVICE_CODE_LIFETIME_FALLBACK_SECONDS;
  for (let waited = 0; waited < expiresIn; waited += interval) {
    await sleep(interval * 1_000);
    const tokenResponse = await fetch(`${serverUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    });
    const token = await readJson<TokenResponse>(tokenResponse);

    if (tokenResponse.ok && token.access_token) {
      const keyOutput = await ensureDocCryptoKey(
        env,
        serverUrl,
        fetch,
        token.access_token,
        ask,
      );
      writeToken(env, { accessToken: token.access_token });
      await recordSignedIn(env, serverUrl, fetch, token.access_token);
      return success(`${onOutput ? "" : prompt}Signed in.\n${keyOutput}`);
    }

    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error(errorMessage(token));
  }
  throw new Error("Device code expired before the login was approved. Run trace login to try again.");
}

async function ensureDocCryptoKey(
  env: Env,
  serverUrl: string,
  fetch: AuthDependencies["fetch"],
  accessToken: string,
  ask: AuthDependencies["prompt"],
): Promise<string> {
  if (readStoredDocCryptoKey(env)) return "";

  const response = await fetch(`${serverUrl}/api/sync/docs/manifests`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson<DocManifestsResponse>(response);
  if (!response.ok) throw new Error(errorMessage(body as ErrorResponse));
  if (!Array.isArray(body.manifests) || !Array.isArray(body.wrappedKeys)) {
    throw new Error("Sync server returned an invalid document manifest response");
  }

  if (body.manifests.length === 0) {
    const masterKey = generateTaskKey();
    writeStoredDocCryptoKey(env, masterKey);
    return (
      "Save this document encryption key somewhere safe. It will only be shown once during setup:\n" +
      `${masterKey}\n`
    );
  }

  const entered = (
    await ask(
      "Enter your 64-character document encryption key, or type NEW to create a fresh key: ",
    )
  ).trim();
  if (entered.toUpperCase() === "NEW") {
    return generateFreshKeyForExistingAccount(env, ask);
  }

  // The master key is a KEK: it never opens a manifest directly. Validate the
  // paste by unwrapping any one stored wrapped key — an AEAD tag failure (or a
  // malformed key) means the wrong master key, caught before any persistence.
  const [wrapped] = body.wrappedKeys;
  try {
    if (typeof wrapped?.wrappedKey !== "string") throw new Error("missing wrapped key");
    createKeyWrapper(entered).unwrapTaskKey(wrapped.wrappedKey);
  } catch {
    throw new Error(
      "That document encryption key could not decrypt your synced documents.",
    );
  }
  writeStoredDocCryptoKey(env, entered.toLowerCase());
  return "Document encryption key saved.\n";
}

async function generateFreshKeyForExistingAccount(
  env: Env,
  ask: AuthDependencies["prompt"],
): Promise<string> {
  const confirmation = await ask(
    "Warning: a fresh key cannot decrypt your existing synced documents. Type GENERATE NEW KEY to continue: ",
  );
  if (confirmation.trim() !== "GENERATE NEW KEY") {
    throw new Error("Fresh document encryption key generation cancelled");
  }
  const masterKey = generateTaskKey();
  writeStoredDocCryptoKey(env, masterKey);
  return (
    "Save this new document encryption key somewhere safe. Existing synced documents require the old key:\n" +
    `${masterKey}\n`
  );
}

function logout(env: Env): CommandResult {
  rmSync(tokenPath(env), { force: true });
  // Clear the board's sync header so it falls back to "not logged in".
  try {
    writeSyncStatusFile(resolveDatabasePath(env), { loggedIn: false });
  } catch {
    // Best-effort: a missing database path must not fail logout.
  }
  return success("Signed out.\n");
}

async function whoami(
  env: Env,
  { fetch }: AuthDependencies,
): Promise<CommandResult> {
  const serverUrl = requireServerUrl(env);
  const token = readAuthToken(env);
  if (!token) return failure("Not logged in. Run trace login.");

  const response = await fetch(`${serverUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  const session = await readJson<SessionResponse>(response);
  if (!response.ok || !session?.user) {
    return failure("Not logged in. Run trace login.");
  }

  const identity = identityFromSession(session);
  if (!identity) return failure("Auth server returned no user identity.");
  return success(`${identity}\n`);
}

/** Resolve a display identity (`name <email>` / name / email / id) from a session. */
function identityFromSession(session: SessionResponse): string | null {
  const user = session.user;
  if (!user) return null;
  const label = user.name ?? user.email ?? user.id;
  if (!label) return null;
  const email = user.email ? ` <${user.email}>` : "";
  return `${label}${email}`;
}

/**
 * Record the signed-in state (and, best-effort, the GitHub identity) for the
 * board's sync header. Login has already succeeded by this point, so any
 * failure here — an unreachable session endpoint, an unresolvable database
 * path — must be swallowed rather than surfaced to the user.
 */
async function recordSignedIn(
  env: Env,
  serverUrl: string,
  fetch: AuthDependencies["fetch"],
  accessToken: string,
): Promise<void> {
  let identity: string | null = null;
  try {
    const response = await fetch(`${serverUrl}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      identity = identityFromSession(await readJson<SessionResponse>(response));
    }
  } catch {
    // Identity is a nice-to-have; fall through to recording just the login.
  }
  try {
    updateSyncStatusFile(resolveDatabasePath(env), {
      loggedIn: true,
      ...(identity ? { identity } : {}),
      lastError: undefined,
    });
  } catch {
    // No usable database path — the board simply won't show a header yet.
  }
}

/**
 * Cloud features are flagged off until a server URL is configured
 * (`TRACE_SERVER_URL` or `trace config set server-url`); auth commands fail
 * with this message rather than guessing at a server.
 */
export const NO_SERVER_CONFIGURED_MESSAGE =
  "No sync server configured. Run trace config set server-url <url>.";

function requireServerUrl(env: Env): string {
  const serverUrl = resolveConfiguredServerUrl(env);
  if (!serverUrl) throw new Error(NO_SERVER_CONFIGURED_MESSAGE);
  return serverUrl;
}

function tokenPath(env: Env): string {
  return join(env.HOME ?? homedir(), ".trace", "auth.json");
}

export function readAuthToken(env: Env): AuthToken | null {
  try {
    const token = JSON.parse(readFileSync(tokenPath(env), "utf8")) as AuthToken;
    return typeof token.accessToken === "string" ? token : null;
  } catch {
    return null;
  }
}

function writeToken(env: Env, token: AuthToken): void {
  const path = tokenPath(env);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(token), { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

async function readJson<T>(response: Response): Promise<T & ErrorResponse> {
  try {
    return (await response.json()) as T & ErrorResponse;
  } catch {
    return {} as T & ErrorResponse;
  }
}

function errorMessage(response: ErrorResponse): string {
  return response.error_description ?? response.error ?? "Authentication request failed";
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string): CommandResult {
  return { exitCode: 1, stdout: "", stderr: `${stderr}\n` };
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

/**
 * The `/api/sync/docs/manifests` response: manifests paired with the wrapped
 * DEK for each task (parallel arrays, keyed by `taskId`). Login only needs a
 * wrapped key to validate the master key by unwrapping it.
 */
interface DocManifestsResponse {
  manifests?: SyncDocManifest[];
  wrappedKeys?: SyncWrappedKey[];
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
}

interface SessionResponse {
  user?: { id?: string; name?: string; email?: string };
}
