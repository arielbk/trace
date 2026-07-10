import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  deriveSyncStatus,
  readSyncStatus,
  resolveSyncStatusPath,
  updateSyncStatusFile,
  writeSyncStatusFile,
} from "./sync-status.ts";

function tempDatabasePath(): { databasePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trace-sync-status-"));
  return {
    databasePath: join(dir, "trace.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("resolveSyncStatusPath places the file beside the database", () => {
  const path = resolveSyncStatusPath("/tmp/some/trace.sqlite");
  expect(path).toBe("/tmp/some/sync-status.json");
});

test("readSyncStatus reports logged-out when no status file exists", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    expect(readSyncStatus(databasePath)).toEqual({ state: "logged-out" });
  } finally {
    cleanup();
  }
});

test("readSyncStatus reports logged-out for a malformed status file", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  writeFileSync(resolveSyncStatusPath(databasePath), "not json");
  try {
    expect(readSyncStatus(databasePath)).toEqual({ state: "logged-out" });
  } finally {
    cleanup();
  }
});

test("writeSyncStatusFile then readSyncStatus reports the synced identity and timestamp", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeSyncStatusFile(databasePath, {
      loggedIn: true,
      identity: "octocat <octocat@github.com>",
      lastSyncedAt: "2026-07-10T16:00:00.000Z",
    });
    expect(readSyncStatus(databasePath)).toEqual({
      state: "synced",
      identity: "octocat <octocat@github.com>",
      lastSyncedAt: "2026-07-10T16:00:00.000Z",
    });
  } finally {
    cleanup();
  }
});

test("a logged-in status with no sync yet reports never-synced", () => {
  expect(
    deriveSyncStatus({ loggedIn: true, identity: "octocat" }),
  ).toEqual({ state: "never-synced", identity: "octocat" });
});

test("a status carrying a last error reports failed and keeps any prior sync time", () => {
  expect(
    deriveSyncStatus({
      loggedIn: true,
      identity: "octocat",
      lastSyncedAt: "2026-07-10T15:00:00.000Z",
      lastError: "server returned 500",
    }),
  ).toEqual({
    state: "failed",
    identity: "octocat",
    lastError: "server returned 500",
    lastSyncedAt: "2026-07-10T15:00:00.000Z",
  });
});

test("a logged-in status without an identity is treated as logged-out", () => {
  expect(deriveSyncStatus({ loggedIn: true })).toEqual({ state: "logged-out" });
  expect(deriveSyncStatus({ loggedIn: false })).toEqual({ state: "logged-out" });
});

test("updateSyncStatusFile merges into an existing file and can clear the last error", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    updateSyncStatusFile(databasePath, {
      loggedIn: true,
      identity: "octocat",
      lastError: "server returned 500",
    });
    expect(readSyncStatus(databasePath)).toMatchObject({ state: "failed" });

    // A subsequent successful sync sets the time and clears the error.
    updateSyncStatusFile(databasePath, {
      lastSyncedAt: "2026-07-10T16:00:00.000Z",
      lastError: undefined,
    });
    expect(readSyncStatus(databasePath)).toEqual({
      state: "synced",
      identity: "octocat",
      lastSyncedAt: "2026-07-10T16:00:00.000Z",
    });
  } finally {
    cleanup();
  }
});
