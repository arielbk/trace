import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { openTraceStore } from "./index.ts";

const CLAUDE_FIXTURE = new URL(
  "./fixtures/claude-code-session.jsonl",
  import.meta.url,
).pathname;

test("@trace/core no longer declares the native sqlite driver", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  expect(packageJson.dependencies).not.toHaveProperty("better-sqlite3");
  expect(packageJson.devDependencies).not.toHaveProperty("@types/better-sqlite3");
});

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

test("createTask persists the project root stamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const projectRoot = join(dir, "project");

  try {
    const store = openTraceStore(databasePath);
    const created = store.createTask("checkout", projectRoot);

    expect(created.projectRoot).toBe(projectRoot);
    expect(store.getTask(created.id)).toEqual(created);

    store.close();
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

    const database = new DatabaseSync(databasePath);

    try {
      const journalMode = database.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(journalMode.journal_mode).toBe("wal");

      const userTables = tableNames(database).filter(
        (name) => !name.startsWith("__drizzle"),
      );
      expect(userTables).toEqual(["sessions", "task_docs", "tasks"]);

      expect(taskColumnNames(database)).toEqual([
        "id",
        "title",
        "created_at",
        "project_root",
      ]);

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
        "model",
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
      model: "gpt-5-codex",
    });

    expect(session.taskId).toBe(null);
    expect(session.model).toBe("gpt-5-codex");
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

test("session register round-trips explicit and absent models idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const withModel = store.registerSession({
      id: "with-model",
      transcriptPath: "/tmp/with-model.jsonl",
      tool: "claude",
      model: "claude-opus-4-7",
    });
    const withoutModel = store.registerSession({
      id: "without-model",
      transcriptPath: "/tmp/without-model.jsonl",
      tool: "codex",
    });

    expect(withModel.model).toBe("claude-opus-4-7");
    expect(withoutModel.model).toBe(null);
    expect(
      store.registerSession({
        id: "with-model",
        transcriptPath: "/tmp/changed.jsonl",
        tool: "claude",
        model: "changed-model",
      }),
    ).toEqual(withModel);
    expect(store.listUnassignedSessions()).toEqual([withModel, withoutModel]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration keeps existing session rows readable with a null model", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
      INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES
        ('e865f5c4052e9eefaf5c793f2187c83ef943c808028c87f81767919a93bad7fc', 1779991399241),
        ('064d73bdd21ec45f9426da414e3063223941d74ffaa57a91fa291ccfcfda6085', 1779999700000);

      CREATE TABLE tasks (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        created_at text NOT NULL,
        project_root text DEFAULT '' NOT NULL
      );
      CREATE TABLE sessions (
        id text PRIMARY KEY NOT NULL,
        transcript_path text NOT NULL,
        tool text NOT NULL,
        task_id text,
        created_at text NOT NULL,
        input_tokens integer DEFAULT 0 NOT NULL,
        output_tokens integer DEFAULT 0 NOT NULL,
        cache_creation_input_tokens integer DEFAULT 0 NOT NULL,
        cache_read_input_tokens integer DEFAULT 0 NOT NULL,
        total_tokens integer DEFAULT 0 NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE set null
      );
      CREATE TABLE task_docs (
        task_id text NOT NULL,
        path text NOT NULL,
        created_at text NOT NULL,
        PRIMARY KEY(task_id, path),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE cascade
      );
      INSERT INTO tasks (id, title, created_at, project_root)
        VALUES ('task-1', 'checkout', '2026-05-29T00:00:00.000Z', '');
      INSERT INTO sessions (
        id,
        transcript_path,
        tool,
        task_id,
        created_at,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        total_tokens
      ) VALUES (
        'old-session',
        '/tmp/old-session.jsonl',
        'claude',
        'task-1',
        '2026-05-29T00:00:01.000Z',
        1,
        2,
        3,
        4,
        10
      );
    `);
    database.close();

    const store = openTraceStore(databasePath);
    expect(store.listSessionsForTask("task-1")).toEqual([
      {
        id: "old-session",
        transcriptPath: "/tmp/old-session.jsonl",
        tool: "claude",
        model: null,
        taskId: "task-1",
        createdAt: "2026-05-29T00:00:01.000Z",
        tokenTotals: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
          totalTokens: 10,
        },
      },
    ]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store reads and writes a database created with the old schema through node sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
      INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES
        ('e865f5c4052e9eefaf5c793f2187c83ef943c808028c87f81767919a93bad7fc', 1779991399241),
        ('064d73bdd21ec45f9426da414e3063223941d74ffaa57a91fa291ccfcfda6085', 1779999700000);

      CREATE TABLE tasks (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        created_at text NOT NULL,
        project_root text DEFAULT '' NOT NULL
      );
      CREATE TABLE sessions (
        id text PRIMARY KEY NOT NULL,
        transcript_path text NOT NULL,
        tool text NOT NULL,
        task_id text,
        created_at text NOT NULL,
        input_tokens integer DEFAULT 0 NOT NULL,
        output_tokens integer DEFAULT 0 NOT NULL,
        cache_creation_input_tokens integer DEFAULT 0 NOT NULL,
        cache_read_input_tokens integer DEFAULT 0 NOT NULL,
        total_tokens integer DEFAULT 0 NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE set null
      );
      CREATE TABLE task_docs (
        task_id text NOT NULL,
        path text NOT NULL,
        created_at text NOT NULL,
        PRIMARY KEY(task_id, path),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE cascade
      );
      INSERT INTO tasks (id, title, created_at, project_root)
        VALUES ('task-1', 'checkout', '2026-05-29T00:00:00.000Z', '/repo');
    `);
    database.close();

    const store = openTraceStore(databasePath);
    expect(store.getTask("task-1")).toEqual({
      id: "task-1",
      title: "checkout",
      createdAt: "2026-05-29T00:00:00.000Z",
      projectRoot: "/repo",
    });

    const created = store.createTask("review", "/repo");
    const session = store.registerSession({
      id: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      tool: "codex",
      tokenTotals: { inputTokens: 1, outputTokens: 2 },
    });
    expect(store.listTasks().map((task) => task.id)).toEqual([
      "task-1",
      created.id,
    ]);
    expect(store.listUnassignedSessions()).toEqual([session]);
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

test("task docs include files written to the task docs directory without registration", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const docsDir = join(dir, ".trace", "tasks", task.id, "docs");
    const nativeDocPath = join(docsDir, "decision.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(nativeDocPath, "# Decision\n");

    expect(store.listDocsForTask(task.id)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        path: nativeDocPath,
      }),
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task docs union trace-native files with external docs without duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const docsDir = join(dir, ".trace", "tasks", task.id, "docs");
    const nativeDocPath = join(docsDir, "decision.md");
    const externalDocPath = join(dir, "external.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(nativeDocPath, "# Decision\n");
    writeFileSync(externalDocPath, "# External\n");

    store.addTaskDoc(task.id, externalDocPath);
    store.addTaskDoc(task.id, nativeDocPath);

    expect(
      store
        .listDocsForTask(task.id)
        .map((doc) => doc.path)
        .sort(),
    ).toEqual([externalDocPath, nativeDocPath].sort());

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task docs are empty when the task docs directory does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

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
      model: "claude-opus-4-7",
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

test("re-entry manifest includes task docs and newest-first session pointers", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout", "/repo");
    const docsDir = join(dir, ".trace", "tasks", task.id, "docs");
    const nativeDocPath = join(docsDir, "decision.md");
    const externalDocPath = join(dir, "external.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(nativeDocPath, "# Decision\n");
    writeFileSync(externalDocPath, "# External\n");
    store.addTaskDoc(task.id, externalDocPath);

    const olderSession = store.registerSession({
      id: "older-session",
      transcriptPath: "/tmp/older.jsonl",
      tool: "claude",
    });
    store.assignSession(olderSession.id, task.id);

    waitForNextMillisecond();
    const newestSession = store.registerSession({
      id: "newest-session",
      transcriptPath: "/tmp/newest.jsonl",
      tool: "codex",
      model: "gpt-5-codex",
    });
    store.assignSession(newestSession.id, task.id);

    expect(store.getReEntryManifest(task.id)).toEqual({
      task: {
        id: task.id,
        title: "checkout",
        projectRoot: "/repo",
      },
      docs: expect.arrayContaining([
        expect.objectContaining({ path: nativeDocPath }),
        expect.objectContaining({ path: externalDocPath }),
      ]),
      sessions: [
        {
          id: "newest-session",
          tool: "codex",
          transcriptPath: "/tmp/newest.jsonl",
          model: "gpt-5-codex",
          createdAt: newestSession.createdAt,
          isMostRecent: true,
        },
        {
          id: "older-session",
          tool: "claude",
          transcriptPath: "/tmp/older.jsonl",
          model: null,
          createdAt: olderSession.createdAt,
          isMostRecent: false,
        },
      ],
    });

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entry manifest returns empty sections for tasks without docs or sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("empty");

    expect(store.getReEntryManifest(task.id)).toEqual({
      task: {
        id: task.id,
        title: "empty",
        projectRoot: "",
      },
      docs: [],
      sessions: [],
    });
    expect(store.getReEntryManifest("missing")).toBeNull();

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// refresh-on-read: session reads refresh token totals from transcripts
// ──────────────────────────────────────────────────────────────────────────────

test("getSession refreshes token totals from transcript and persists them", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  // Write a copy of the claude fixture so we can delete it later
  const transcriptPath = join(dir, "session.jsonl");
  writeFileSync(transcriptPath, readFileSync(CLAUDE_FIXTURE, "utf8"));

  try {
    const store = openTraceStore(databasePath);
    // Register with zero totals (simulating registration-time zeros)
    const session = store.registerSession({
      id: "claude-session-1",
      transcriptPath,
      tool: "claude",
    });
    expect(session.tokenTotals.totalTokens).toBe(0);

    // Read back — should refresh from transcript
    const refreshed = store.getSession(session.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.tokenTotals.inputTokens).toBe(13);
    expect(refreshed!.tokenTotals.outputTokens).toBe(25);
    expect(refreshed!.tokenTotals.cacheCreationInputTokens).toBe(4);
    expect(refreshed!.tokenTotals.cacheReadInputTokens).toBe(6);
    expect(refreshed!.tokenTotals.totalTokens).toBe(48);

    // Delete the transcript — should return the persisted (refreshed) values
    unlinkSync(transcriptPath);
    const persisted = store.getSession(session.id);
    expect(persisted!.tokenTotals.totalTokens).toBe(48);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSession returns stored values when transcript is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "nonexistent.jsonl");

  try {
    const store = openTraceStore(databasePath);
    store.registerSession({
      id: "session-missing-transcript",
      transcriptPath,
      tool: "claude",
      tokenTotals: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    });

    const result = store.getSession("session-missing-transcript");
    expect(result).not.toBeNull();
    expect(result!.tokenTotals.totalTokens).toBe(15);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSession returns stored values when transcript is unparseable and does not write", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "broken.jsonl");
  // No valid session-id lines → parseFile will throw
  writeFileSync(transcriptPath, "not-json\nalso-not-json\n");

  try {
    const store = openTraceStore(databasePath);
    store.registerSession({
      id: "session-broken-transcript",
      transcriptPath,
      tool: "claude",
      tokenTotals: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });

    const result = store.getSession("session-broken-transcript");
    expect(result).not.toBeNull();
    // Should return stored values unchanged
    expect(result!.tokenTotals.totalTokens).toBe(10);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSessionsForTask refreshes token totals from transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session.jsonl");
  writeFileSync(transcriptPath, readFileSync(CLAUDE_FIXTURE, "utf8"));

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const session = store.registerSession({
      id: "claude-session-1",
      transcriptPath,
      tool: "claude",
    });
    store.assignSession(session.id, task.id);

    const sessions = store.listSessionsForTask(task.id);
    expect(sessions[0]!.tokenTotals.totalTokens).toBe(48);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listUnassignedSessions refreshes token totals from transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session.jsonl");
  writeFileSync(transcriptPath, readFileSync(CLAUDE_FIXTURE, "utf8"));

  try {
    const store = openTraceStore(databasePath);
    store.registerSession({
      id: "claude-session-1",
      transcriptPath,
      tool: "claude",
    });

    const unassigned = store.listUnassignedSessions();
    expect(unassigned[0]!.tokenTotals.totalTokens).toBe(48);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task timeline tokenTotals aggregates refreshed per-session values", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session.jsonl");
  writeFileSync(transcriptPath, readFileSync(CLAUDE_FIXTURE, "utf8"));

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const session = store.registerSession({
      id: "claude-session-1",
      transcriptPath,
      tool: "claude",
    });
    store.assignSession(session.id, task.id);

    const timeline = store.getTaskTimeline(task.id);
    expect(timeline).not.toBeNull();
    expect(timeline!.tokenTotals.totalTokens).toBe(48);

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

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name ASC",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function sessionColumnNames(database: DatabaseSync): string[] {
  return database
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .map((row) => (row as { name: string }).name);
}

function taskColumnNames(database: DatabaseSync): string[] {
  return database
    .prepare("PRAGMA table_info(tasks)")
    .all()
    .map((row) => (row as { name: string }).name);
}
