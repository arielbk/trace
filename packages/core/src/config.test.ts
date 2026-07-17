import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  readConfigFile,
  resolveConfigPath,
  resolveConfiguredServerUrl,
  updateConfigFile,
  writeConfigFile,
} from "./config.ts";

function tempDatabasePath(): { databasePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trace-config-"));
  return {
    databasePath: join(dir, "trace.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("resolveConfigPath places the file beside the database", () => {
  expect(resolveConfigPath("/tmp/some/trace.sqlite")).toBe(
    "/tmp/some/config.json",
  );
});

test("readConfigFile returns null when no config file exists", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    expect(readConfigFile(databasePath)).toBeNull();
  } finally {
    cleanup();
  }
});

test("readConfigFile returns null for a malformed config file", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeFileSync(resolveConfigPath(databasePath), "not json");
    expect(readConfigFile(databasePath)).toBeNull();
    writeFileSync(
      resolveConfigPath(databasePath),
      JSON.stringify({ serverUrl: 42 }),
    );
    expect(readConfigFile(databasePath)).toBeNull();
  } finally {
    cleanup();
  }
});

test("writeConfigFile round-trips and ends with a newline", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeConfigFile(databasePath, { serverUrl: "https://sync.test" });
    expect(readConfigFile(databasePath)).toEqual({
      serverUrl: "https://sync.test",
    });
    expect(readFileSync(resolveConfigPath(databasePath), "utf8")).toMatch(
      /\n$/,
    );
  } finally {
    cleanup();
  }
});

test("updateConfigFile clears a key patched to undefined", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeConfigFile(databasePath, { serverUrl: "https://sync.test" });
    updateConfigFile(databasePath, { serverUrl: undefined });
    expect(readConfigFile(databasePath)).toEqual({});
  } finally {
    cleanup();
  }
});

test("resolveConfiguredServerUrl prefers the env var over the config file", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeConfigFile(databasePath, { serverUrl: "https://from-config.test" });
    expect(
      resolveConfiguredServerUrl({
        TRACE_DB: databasePath,
        TRACE_SERVER_URL: "https://from-env.test/",
      }),
    ).toBe("https://from-env.test");
  } finally {
    cleanup();
  }
});

test("resolveConfiguredServerUrl falls back to the config file", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeConfigFile(databasePath, { serverUrl: "https://from-config.test//" });
    expect(resolveConfiguredServerUrl({ TRACE_DB: databasePath })).toBe(
      "https://from-config.test",
    );
  } finally {
    cleanup();
  }
});

test("resolveConfiguredServerUrl is undefined with no env var and no config", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    expect(
      resolveConfiguredServerUrl({ TRACE_DB: databasePath }),
    ).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("resolveConfiguredServerUrl is undefined when no database path resolves", () => {
  expect(resolveConfiguredServerUrl({})).toBeUndefined();
});
