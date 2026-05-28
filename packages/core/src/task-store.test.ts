import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { openTraceStore } from "./index.ts";

test("task entity persists and reads back through the store interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const created = store.createTask("checkout");
    store.close();

    const reopened = openTraceStore(databasePath);
    expect(reopened.getTask(created.id)).toEqual(created);
    expect(reopened.listTasks()).toEqual([created]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store opens in WAL mode and applies migrations idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    store.close();

    const reopened = openTraceStore(databasePath);
    reopened.close();

    const database = new Database(databasePath);

    try {
      const journalMode = database
        .prepare("PRAGMA journal_mode")
        .get() as { journal_mode: string };
      expect(journalMode.journal_mode).toBe("wal");

      const userTables = tableNames(database).filter(
        (name) => !name.startsWith("__drizzle"),
      );
      expect(userTables).toEqual(["sessions", "task_docs", "tasks"]);

      expect(sessionColumnNames(database)).toEqual([
        "id",
        "transcript_path",
        "tool",
        "task_id",
        "created_at",
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "total_tokens",
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session register and assign lifecycle keeps one task per session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const firstTask = store.createTask("checkout");
    const secondTask = store.createTask("review");
    const session = store.registerSession({
      id: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      tool: "codex",
    });

    expect(session.taskId).toBe(null);
    expect(store.listUnassignedSessions()).toEqual([session]);

    const assigned = store.assignSession(session.id, firstTask.id);
    expect(assigned.taskId).toBe(firstTask.id);
    expect(store.listUnassignedSessions()).toEqual([]);
    expect(store.listSessionsForTask(firstTask.id)).toEqual([assigned]);

    const moved = store.assignSession(session.id, secondTask.id);
    expect(moved.taskId).toBe(secondTask.id);
    expect(store.listSessionsForTask(firstTask.id)).toEqual([]);
    expect(store.listSessionsForTask(secondTask.id)).toEqual([moved]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task doc associations can be added, read, and removed through the store interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

    const doc = store.addTaskDoc(task.id, "/tmp/spec.md");

    expect(doc.taskId).toBe(task.id);
    expect(doc.path).toBe("/tmp/spec.md");
    expect(store.listDocsForTask(task.id)).toEqual([doc]);

    store.removeTaskDoc(task.id, "/tmp/spec.md");
    expect(store.listDocsForTask(task.id)).toEqual([]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task timeline aggregates assigned sessions, docs, and token totals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const emptyTask = store.createTask("empty");

    const claudeSession = store.registerSession({
      id: "claude-session",
      transcriptPath: "/tmp/claude.jsonl",
      tool: "claude",
      tokenTotals: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        totalTokens: 35,
      },
    });
    store.assignSession(claudeSession.id, task.id);

    waitForNextMillisecond();
    const doc = store.addTaskDoc(task.id, "/tmp/spec.md");

    waitForNextMillisecond();
    const codexSession = store.registerSession({
      id: "codex-session",
      transcriptPath: "/tmp/codex.jsonl",
      tool: "codex",
      tokenTotals: {
        inputTokens: 7,
        outputTokens: 11,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 5,
        totalTokens: 23,
      },
    });
    store.assignSession(codexSession.id, task.id);

    store.registerSession({
      id: "unassigned-session",
      transcriptPath: "/tmp/unassigned.jsonl",
      tool: "codex",
      tokenTotals: {
        inputTokens: 100,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 200,
      },
    });

    expect(store.getTaskTimeline(task.id)).toEqual({
      task,
      items: [
        {
          type: "session",
          createdAt: claudeSession.createdAt,
          session: { ...claudeSession, taskId: task.id },
        },
        { type: "doc", createdAt: doc.createdAt, doc },
        {
          type: "session",
          createdAt: codexSession.createdAt,
          session: { ...codexSession, taskId: task.id },
        },
      ],
      tokenTotals: {
        inputTokens: 17,
        outputTokens: 31,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 8,
        totalTokens: 58,
      },
    });

    expect(store.getTaskTimeline(emptyTask.id)).toEqual({
      task: emptyTask,
      items: [],
      tokenTotals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 0,
      },
    });

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitForNextMillisecond(): void {
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    // SQLite stores ISO timestamps with millisecond precision; the timeline
    // ordering assertion needs distinct timestamps without relying on timers.
  }
}

function tableNames(database: Database.Database): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name ASC",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function sessionColumnNames(database: Database.Database): string[] {
  return database
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .map((row) => (row as { name: string }).name);
}
