import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "./index.ts";

function waitForNextMillisecond(): void {
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    // SQLite stores ISO timestamps with millisecond precision.
  }
}

test("assigning a session persists git context and surfaces it on re-entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-last-work-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const session = store.registerSession({
      id: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      tool: "claude",
    });
    store.assignSession(session.id, task.id, {
      branch: "main",
      localPath: "/repo",
    });
    store.close();

    const reopened = openTraceStore(databasePath);
    const persisted = reopened.getSession("session-1");
    expect(persisted?.gitBranch).toBe("main");
    expect(persisted?.gitWorktreePath).toBe("/repo");
    expect(persisted?.gitWorktreeLabel).toBeUndefined();
    expect(reopened.getReEntryManifest(task.id)?.lastWorkedOn).toEqual({
      branch: "main",
    });
    expect(JSON.stringify(reopened.getReEntryManifest(task.id))).not.toMatch(
      /[0-9a-f]{40}/i,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entry last-worked-on follows the latest session with git context", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-last-work-latest-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const older = store.registerSession({
      id: "older",
      transcriptPath: "/tmp/older.jsonl",
      tool: "claude",
    });
    store.assignSession(older.id, task.id, { branch: "main" });

    waitForNextMillisecond();
    const newer = store.registerSession({
      id: "newer",
      transcriptPath: "/tmp/newer.jsonl",
      tool: "codex",
    });
    store.assignSession(newer.id, task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
      localPath: "/tmp/feature-checkout",
    });

    expect(store.getReEntryManifest(task.id)?.lastWorkedOn).toEqual({
      branch: "feature-branch",
      worktree: "feature-checkout",
    });
    expect(store.getReEntryManifest(task.id)?.lastWorkedOn).not.toHaveProperty(
      "localPath",
    );

    waitForNextMillisecond();
    const newestWithoutGit = store.registerSession({
      id: "newest",
      transcriptPath: "/tmp/newest.jsonl",
      tool: "cursor",
    });
    store.assignSession(newestWithoutGit.id, task.id);

    expect(store.getReEntryManifest(task.id)?.lastWorkedOn).toEqual({
      branch: "feature-branch",
      worktree: "feature-checkout",
    });

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
