import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readOrCreateBridgeCredential,
  resolveBridgeCredentialPath,
} from "./bridge-credential.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the installation credential is generated once and stored owner-only", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-bridge-credential-"));
  homes.push(home);
  const env = { HOME: home };

  const first = readOrCreateBridgeCredential(env);
  const second = readOrCreateBridgeCredential(env);
  const path = resolveBridgeCredentialPath(env);

  expect(first).toBe(second);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: first });
  expect(statSync(join(home, ".trace")).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
