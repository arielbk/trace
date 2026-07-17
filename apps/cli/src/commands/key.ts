import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

type StoredDocCryptoKey = {
  masterKey: string;
};

export function resolveStoredDocCryptoKeyPath(env: Env): string {
  return join(env.HOME ?? homedir(), ".trace", "key.json");
}

export function writeStoredDocCryptoKey(env: Env, masterKey: string): void {
  const path = resolveStoredDocCryptoKeyPath(env);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ masterKey }), { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

export function readStoredDocCryptoKey(env: Env): string | null {
  try {
    const stored = JSON.parse(
      readFileSync(resolveStoredDocCryptoKeyPath(env), "utf8"),
    ) as StoredDocCryptoKey;
    return typeof stored.masterKey === "string" ? stored.masterKey : null;
  } catch {
    return null;
  }
}

export function keyShowOperation(env: Env): CommandResult {
  const masterKey = readStoredDocCryptoKey(env);
  if (!masterKey) {
    return failure(
      "No document encryption key found. Run trace login to set one up.",
      1,
    );
  }
  return success(`${masterKey}\n`);
}
