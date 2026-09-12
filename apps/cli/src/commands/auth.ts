import {
  assertLegacyStoreAccount,
  assertStoreAccount,
  commitAccountCredentials,
  resolveSyncAccount,
} from "../account-binding.ts";
import { createInterface } from "node:readline/promises";
import {
  generateTaskKey,
  resolveDatabasePath,
  updateSyncStatusFile,
  REPLACEMENT_KEY_CONFIRMATION,
  REPLACEMENT_KEY_WARNING,
} from "@trace/core";
import {
  clearStoredCredentials,
  fetchDocManifests,
  fetchSession,
  identityFromSession,
  pollForAccessToken,
  readAuthToken,
  requestDeviceAuthorization,
  requireServerUrl,
  validateDocumentKey,
  type AuthFetch,
} from "../auth-service.ts";
import { openBrowser } from "../open-browser.ts";
import { readStoredDocCryptoKey } from "./key.ts";
import type { CommandResult, Env } from "./seam.ts";

export { readAuthToken } from "../auth-service.ts";
export { NO_SERVER_CONFIGURED_MESSAGE } from "../auth-service.ts";

/**
 * The terminal adapter over the machine-local auth service (`auth-service.ts`).
 * It owns the prompts and printed output of `eqnx login`/`logout`/`whoami`;
 * the device sequence, credential files, and status writes live in the service
 * so the board adapter (`local-auth.ts`) performs them identically.
 */

export interface AuthDependencies {
  fetch: AuthFetch;
  sleep: (milliseconds: number) => Promise<void>;
  openBrowser: (url: string) => void;
  onOutput?: (output: string) => void;
  onLoginComplete: () => void;
  prompt: (message: string) => Promise<string>;
}

const defaultDependencies: AuthDependencies = {
  fetch: globalThis.fetch,
  onLoginComplete: () => {},
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
  { fetch, sleep, openBrowser, onOutput, prompt: ask, onLoginComplete }: AuthDependencies,
): Promise<CommandResult> {
  const serverUrl = requireServerUrl(env);
  const device = await requestDeviceAuthorization(serverUrl, fetch);

  const prompt = `Visit ${device.verificationUrl}\nCode: ${device.userCode}\n`;
  onOutput?.(prompt);
  openBrowser(device.verificationUrl);

  const accessToken = await pollForAccessToken(serverUrl, fetch, sleep, device);
  const account = await resolveSyncAccount(serverUrl, fetch, accessToken);
  assertStoreAccount(env, serverUrl, account);
  const key = await ensureDocCryptoKey(env, serverUrl, fetch, accessToken, ask);
  commitAccountCredentials(env, serverUrl, account, accessToken, key.masterKey);
  try {
    updateSyncStatusFile(resolveDatabasePath(env), {
      loggedIn: true,
      identity: account.identity,
      lastError: undefined,
      activeRun: undefined,
      restore: { phase: "metadata" },
    });
  } catch {
    /* The header is best-effort after credentials commit. */
  }
  onLoginComplete();
  return success(`${onOutput ? "" : prompt}Signed in.\n${key.output}`);
}

async function ensureDocCryptoKey(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
  ask: AuthDependencies["prompt"],
): Promise<{ masterKey?: string; output: string }> {
  const stored = readStoredDocCryptoKey(env);
  const { manifests, wrappedKeys } = await fetchDocManifests(
    serverUrl,
    fetch,
    accessToken,
  );

  assertLegacyStoreAccount(env, wrappedKeys);
  if (stored) {
    if (wrappedKeys.length > 0) validateDocumentKey(stored, wrappedKeys);
    return { output: "" };
  }
  if (manifests.length === 0) {
    const masterKey = generateTaskKey();
    return {
      masterKey,
      output:
        "Save this document encryption key somewhere safe. It will only be shown once during setup:\n" +
        `${masterKey}\n`,
    };
  }

  const entered = (
    await ask(
      "Enter your 64-character document encryption key, or type NEW to create a fresh key: ",
    )
  ).trim();
  if (entered.toUpperCase() === "NEW") {
    return generateFreshKeyForExistingAccount(ask);
  }

  // Validated against the account's own wrapped key, by the same helper the
  // board's login uses, so neither surface can be the lenient one.
  return {
    masterKey: validateDocumentKey(entered, wrappedKeys),
    output: "Document encryption key saved.\n",
  };
}

async function generateFreshKeyForExistingAccount(
  ask: AuthDependencies["prompt"],
): Promise<{ masterKey: string; output: string }> {
  const confirmation = await ask(
    `Warning: ${REPLACEMENT_KEY_WARNING} Type ${REPLACEMENT_KEY_CONFIRMATION} to continue: `,
  );
  if (confirmation.trim() !== REPLACEMENT_KEY_CONFIRMATION) {
    throw new Error("Fresh document encryption key generation cancelled");
  }
  const masterKey = generateTaskKey();
  return {
    masterKey,
    output:
      "Save this new document encryption key somewhere safe. Existing synced documents require the old key:\n" +
      `${masterKey}\n`,
  };
}

function logout(env: Env): CommandResult {
  clearStoredCredentials(env);
  return success("Signed out.\n");
}

async function whoami(
  env: Env,
  { fetch }: AuthDependencies,
): Promise<CommandResult> {
  const serverUrl = requireServerUrl(env);
  const token = readAuthToken(env);
  if (!token) {
    clearStoredCredentials(env);
    return failure("Not logged in. Run eqnx login.");
  }

  const session = await fetchSession(serverUrl, fetch, token.accessToken);
  if (!session?.user) {
    if (readAuthToken(env)?.accessToken === token.accessToken) clearStoredCredentials(env);
    return failure("Not logged in. Run eqnx login.");
  }

  const identity = identityFromSession(session);
  if (!identity) return failure("Auth server returned no user identity.");
  return success(`${identity}\n`);
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string): CommandResult {
  return { exitCode: 1, stdout: "", stderr: `${stderr}\n` };
}
