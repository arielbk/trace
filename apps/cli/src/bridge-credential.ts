import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

type Env = Record<string, string | undefined>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function resolveBridgeCredentialPath(env: Env): string {
  return join(env.HOME ?? homedir(), ".trace", "bridge.json");
}

export function readOrCreateBridgeCredential(env: Env): string {
  const path = resolveBridgeCredentialPath(env);
  const existing = readCredential(path);
  if (existing) return existing;
  if (existsSync(path)) {
    throw new Error(`Invalid Trace bridge credential at ${path}`);
  }

  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const token = randomBytes(32).toString("base64url");
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ token }), { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
  return token;
}

function readCredential(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
    return typeof value.token === "string" && TOKEN_PATTERN.test(value.token)
      ? value.token
      : null;
  } catch {
    return null;
  }
}
