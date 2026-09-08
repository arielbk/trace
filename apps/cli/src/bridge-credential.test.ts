import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readBridgeCredential,
  resolveBridgeCredentialPath,
} from "./bridge-credential.ts";

const homes: string[] = [];

function homeWithBridgeFile(contents?: string): { HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "trace-bridge-credential-"));
  homes.push(home);
  if (contents !== undefined) {
    mkdirSync(join(home, ".trace"), { recursive: true });
    writeFileSync(resolveBridgeCredentialPath({ HOME: home }), contents);
  }
  return { HOME: home };
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a previous installation's bridge credential is readable for migration", () => {
  const token = "a".repeat(43);

  expect(readBridgeCredential(homeWithBridgeFile(`{"token":"${token}"}`))).toBe(
    token,
  );
});

test("an absent or unusable bridge file yields no credential to migrate", () => {
  expect(readBridgeCredential(homeWithBridgeFile())).toBeNull();
  expect(readBridgeCredential(homeWithBridgeFile("{ not json"))).toBeNull();
  expect(readBridgeCredential(homeWithBridgeFile('{"token":"short"}'))).toBeNull();
});
