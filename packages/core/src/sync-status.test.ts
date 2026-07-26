import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  beginSyncRun,
  deriveSyncStatus,
  finalizeSyncRun,
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

test("a logged-in status stays logged-in even when identity was never recorded", () => {
  expect(deriveSyncStatus({ loggedIn: true })).toEqual({ state: "never-synced" });
  expect(
    deriveSyncStatus({ loggedIn: true, lastSyncedAt: "2026-07-10T16:00:00.000Z" }),
  ).toEqual({ state: "synced", lastSyncedAt: "2026-07-10T16:00:00.000Z" });
  expect(deriveSyncStatus({ loggedIn: false })).toEqual({ state: "logged-out" });
});

test("a status with an active run reports syncing and keeps the last successful time", () => {
  expect(
    deriveSyncStatus(
      {
        loggedIn: true,
        identity: "octocat",
        lastSyncedAt: "2026-07-10T15:00:00.000Z",
        activeRun: { id: "run-1", startedAt: "2026-07-10T16:00:00.000Z" },
      },
      new Date("2026-07-10T16:00:05.000Z"),
    ),
  ).toEqual({
    state: "syncing",
    identity: "octocat",
    startedAt: "2026-07-10T16:00:00.000Z",
    lastSyncedAt: "2026-07-10T15:00:00.000Z",
  });
});

test("an abandoned run stops rendering as syncing without losing the last outcome", () => {
  const file = {
    loggedIn: true,
    identity: "octocat",
    lastSyncedAt: "2026-07-10T15:00:00.000Z",
    activeRun: { id: "run-1", startedAt: "2026-07-10T16:00:00.000Z" },
  };
  // A killed sync process never clears its own run; an hour later the board
  // must show the last real sync rather than an indefinite spinner.
  expect(deriveSyncStatus(file, new Date("2026-07-10T17:00:00.000Z"))).toEqual({
    state: "synced",
    identity: "octocat",
    lastSyncedAt: "2026-07-10T15:00:00.000Z",
  });
  // A run whose timestamp cannot be read can never age out, so it is not
  // trusted at all.
  expect(
    deriveSyncStatus(
      { ...file, activeRun: { id: "run-1", startedAt: "not a date" } },
      new Date("2026-07-10T16:00:05.000Z"),
    ),
  ).toMatchObject({ state: "synced" });
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

test("a started run reports syncing until its own finalizer records the outcome", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeSyncStatusFile(databasePath, { loggedIn: true, identity: "octocat" });

    beginSyncRun(databasePath, {
      id: "run-1",
      startedAt: "2026-07-10T16:00:00.000Z",
    });
    expect(readSyncStatus(databasePath, new Date("2026-07-10T16:00:01.000Z"))).toEqual({
      state: "syncing",
      identity: "octocat",
      startedAt: "2026-07-10T16:00:00.000Z",
    });

    expect(
      finalizeSyncRun(databasePath, "run-1", {
        lastSyncedAt: "2026-07-10T16:00:02.000Z",
        lastError: undefined,
      }),
    ).toBe(true);
    expect(readSyncStatus(databasePath, new Date("2026-07-10T16:00:03.000Z"))).toEqual({
      state: "synced",
      identity: "octocat",
      lastSyncedAt: "2026-07-10T16:00:02.000Z",
    });
  } finally {
    cleanup();
  }
});

test("a late finalizer cannot overwrite the run that replaced it", () => {
  const { databasePath, cleanup } = tempDatabasePath();
  try {
    writeSyncStatusFile(databasePath, { loggedIn: true });
    beginSyncRun(databasePath, {
      id: "slow-run",
      startedAt: "2026-07-10T16:00:00.000Z",
    });
    beginSyncRun(databasePath, {
      id: "newer-run",
      startedAt: "2026-07-10T16:00:10.000Z",
    });

    // The slow run finally fails, long after a newer run took ownership.
    expect(
      finalizeSyncRun(databasePath, "slow-run", { lastError: "server returned 500" }),
    ).toBe(false);
    expect(readSyncStatus(databasePath, new Date("2026-07-10T16:00:11.000Z"))).toEqual({
      state: "syncing",
      startedAt: "2026-07-10T16:00:10.000Z",
    });

    expect(
      finalizeSyncRun(databasePath, "newer-run", {
        lastSyncedAt: "2026-07-10T16:00:12.000Z",
      }),
    ).toBe(true);
    expect(readSyncStatus(databasePath, new Date("2026-07-10T16:00:13.000Z"))).toEqual({
      state: "synced",
      lastSyncedAt: "2026-07-10T16:00:12.000Z",
    });
  } finally {
    cleanup();
  }
});
