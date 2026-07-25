import { createInterface } from "node:readline/promises";
import { createKeyWrapper, generateTaskKey } from "@trace/core";
import {
  clearStoredCredentials,
  fetchDocManifests,
  fetchSession,
  identityFromSession,
  pollForAccessToken,
  readAuthToken,
  recordSignedIn,
  requestDeviceAuthorization,
  requireServerUrl,
  writeAuthToken,
  type AuthFetch,
} from "../auth-service.ts";
import { openBrowser } from "../open-browser.ts";
import {
  readStoredDocCryptoKey,
  writeStoredDocCryptoKey,
} from "./key.ts";
import type { CommandResult, Env } from "./seam.ts";

export { readAuthToken } from "../auth-service.ts";
export { NO_SERVER_CONFIGURED_MESSAGE } from "../auth-service.ts";

/**
 * The terminal adapter over the machine-local auth service (`auth-service.ts`).
 * It owns the prompts and printed output of `trace login`/`logout`/`whoami`;
 * the device sequence, credential files, and status writes live in the service
 * so the board adapter (`local-auth.ts`) performs them identically.
 */

export interface AuthDependencies {
  fetch: AuthFetch;
  sleep: (milliseconds: number) => Promise<void>;
  openBrowser: (url: string) => void;
  onOutput?: (output: string) => void;
  prompt: (message: string) => Promise<string>;
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
  const device = await requestDeviceAuthorization(serverUrl, fetch);

  const prompt = `Visit ${device.verificationUrl}\nCode: ${device.userCode}\n`;
  onOutput?.(prompt);
  openBrowser(device.verificationUrl);

  const accessToken = await pollForAccessToken(serverUrl, fetch, sleep, device);
  const keyOutput = await ensureDocCryptoKey(env, serverUrl, fetch, accessToken, ask);
  writeAuthToken(env, { accessToken });
  await recordSignedIn(env, serverUrl, fetch, accessToken);
  return success(`${onOutput ? "" : prompt}Signed in.\n${keyOutput}`);
}

async function ensureDocCryptoKey(
  env: Env,
  serverUrl: string,
  fetch: AuthFetch,
  accessToken: string,
  ask: AuthDependencies["prompt"],
): Promise<string> {
  if (readStoredDocCryptoKey(env)) return "";

  const { manifests, wrappedKeys } = await fetchDocManifests(
    serverUrl,
    fetch,
    accessToken,
  );

  if (manifests.length === 0) {
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
  const [wrapped] = wrappedKeys;
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
  clearStoredCredentials(env);
  return success("Signed out.\n");
}

async function whoami(
  env: Env,
  { fetch }: AuthDependencies,
): Promise<CommandResult> {
  const serverUrl = requireServerUrl(env);
  const token = readAuthToken(env);
  if (!token) return failure("Not logged in. Run trace login.");

  const session = await fetchSession(serverUrl, fetch, token.accessToken);
  if (!session?.user) return failure("Not logged in. Run trace login.");

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
