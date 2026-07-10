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
import type { CommandResult, Env } from "./seam.ts";

const CLIENT_ID = "trace-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface AuthDependencies {
  fetch: typeof globalThis.fetch;
  sleep: (milliseconds: number) => Promise<void>;
  onOutput?: (output: string) => void;
}

interface AuthToken {
  accessToken: string;
}

const defaultDependencies: AuthDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
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
  { fetch, sleep, onOutput }: AuthDependencies,
): Promise<CommandResult> {
  const serverUrl = resolveServerUrl(env);
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

  const prompt = `Visit ${code.verification_uri}\nCode: ${code.user_code}\n`;
  onOutput?.(prompt);
  let interval = Math.max(code.interval ?? 5, 0);
  while (true) {
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
      writeToken(env, { accessToken: token.access_token });
      return success(`${onOutput ? "" : prompt}Signed in.\n`);
    }

    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error(errorMessage(token));
  }
}

function logout(env: Env): CommandResult {
  rmSync(tokenPath(env), { force: true });
  return success("Signed out.\n");
}

async function whoami(
  env: Env,
  { fetch }: AuthDependencies,
): Promise<CommandResult> {
  const token = readAuthToken(env);
  if (!token) return failure("Not logged in. Run trace login.");

  const response = await fetch(`${resolveServerUrl(env)}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  const session = await readJson<SessionResponse>(response);
  if (!response.ok || !session.user) {
    return failure("Not logged in. Run trace login.");
  }

  const identity = session.user.name ?? session.user.email ?? session.user.id;
  if (!identity) return failure("Auth server returned no user identity.");
  const email = session.user.email ? ` <${session.user.email}>` : "";
  return success(`${identity}${email}\n`);
}

export function resolveServerUrl(env: Env): string {
  return (env.TRACE_SERVER_URL ?? "http://localhost:3000").replace(/\/+$/, "");
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
  interval?: number;
}

interface TokenResponse extends ErrorResponse {
  access_token?: string;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
}

interface SessionResponse {
  user?: { id?: string; name?: string; email?: string };
}
