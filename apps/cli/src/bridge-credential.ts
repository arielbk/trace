import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The installation-wide bridge credential written by versions before browsers
 * got their own credentials. Nothing creates this file any more; it is read
 * once, migrated into the connection state as a revocable legacy browser, and
 * otherwise left alone.
 */
export function resolveBridgeCredentialPath(env: Env): string {
  return join(env.HOME ?? homedir(), ".trace", "bridge.json");
}

/** The stored installation credential, or null when this installation never
 * created one (or the file no longer holds a usable token). */
export function readBridgeCredential(env: Env): string | null {
  try {
    const value = JSON.parse(
      readFileSync(resolveBridgeCredentialPath(env), "utf8"),
    ) as { token?: unknown };
    return typeof value.token === "string" && TOKEN_PATTERN.test(value.token)
      ? value.token
      : null;
  } catch {
    return null;
  }
}
