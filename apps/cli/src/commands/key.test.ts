import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDocCryptoKey } from "@trace/core";
import { expect, test } from "vitest";
import { runTraceCli } from "../trace.ts";
import {
  resolveStoredDocCryptoKeyPath,
  writeStoredDocCryptoKey,
} from "./key.ts";

function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "trace-key-home-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("a generated document key can be persisted and shown through the CLI", () => {
  const { home, cleanup } = tempHome();
  const env = { HOME: home };

  try {
    const key = generateDocCryptoKey();
    writeStoredDocCryptoKey(env, key);

    expect(runTraceCli(["key", "show"], env)).toEqual({
      exitCode: 0,
      stdout: `${key}\n`,
      stderr: "",
    });
  } finally {
    cleanup();
  }
});

test("the stored document key is private to the current user", () => {
  const { home, cleanup } = tempHome();
  const env = { HOME: home };

  try {
    writeStoredDocCryptoKey(env, generateDocCryptoKey());

    expect(statSync(resolveStoredDocCryptoKeyPath(env)).mode & 0o777).toBe(
      0o600,
    );
  } finally {
    cleanup();
  }
});

test("key show exits non-zero with a login hint when no key is stored", () => {
  const { home, cleanup } = tempHome();

  try {
    expect(runTraceCli(["key", "show"], { HOME: home })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "No document encryption key found. Run trace login to set one up.\n",
    });
  } finally {
    cleanup();
  }
});
