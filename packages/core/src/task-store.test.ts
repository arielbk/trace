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
  expect(packageJson.devDependencies).not.toHaveProperty(
    "@types/better-sqlite3",
  );
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
        "slug",
        "archived_at",
        "description",
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

test("archive and unarchive round-trip by id and slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

    const archived = store.archiveTask(task.id);
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(store.getTask(task.id)).toEqual(archived);

    const unarchived = store.unarchiveTask(task.slug);
    expect(unarchived).toEqual({ ...archived, archivedAt: null });
    expect(store.getTaskByRef(task.slug)).toEqual(unarchived);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slug-shaped title is humanized and kept verbatim as the slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("break-stop-and-stale-expiry");

    expect(task.title).toBe("Break stop and stale expiry");
    expect(task.slug).toBe("break-stop-and-stale-expiry");

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary titles pass through createTask unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);

    const sentence = store.createTask("Fix the checkout bug");
    expect(sentence.title).toBe("Fix the checkout bug");
    expect(sentence.slug).toBe("fix-the-checkout-bug");

    // A single lowercase word is an ordinary title, not a slug.
    const word = store.createTask("checkout");
    expect(word.title).toBe("checkout");

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a UUID title gets a placeholder slug so it cannot shadow another task's id", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const original = store.createTask("checkout");

    // A task titled with another task's id used to slugify verbatim; archive
    // by that slug then resolved the *original* task (getTaskByRef checks ids
    // before slugs) and the duplicate was unarchivable.
    const duplicate = store.createTask(original.id);
    expect(duplicate.slug).toBe(`task-${duplicate.id.split("-")[0]}`);
    // UUIDs are kebab-shaped but are not humanized like slug titles.
    expect(duplicate.title).toBe(original.id);

    expect(store.getTaskByRef(original.id)).toEqual(original);
    expect(store.archiveTask(duplicate.slug).id).toBe(duplicate.id);
    expect(store.getTask(original.id)?.archivedAt).toBeNull();

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recallCandidates scopes to project, excludes archived, keeps description-less tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const withDescription = store.createTask(
      "Checkout flow",
      "/repo-a",
      "Rework the checkout into a wizard",
    );
    const withoutDescription = store.createTask("Loose end", "/repo-a");
    store.createTask("Other project", "/repo-b", "elsewhere");
    const archived = store.createTask("Old work", "/repo-a", "shipped");
    store.archiveTask(archived.id);

    const candidates = store
      .recallCandidates("/repo-a")
      .sort((a, b) => a.title.localeCompare(b.title));

    expect(candidates).toEqual([
      {
        title: "Checkout flow",
        slug: withDescription.slug,
        description: "Rework the checkout into a wizard",
      },
      { title: "Loose end", slug: withoutDescription.slug },
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task summaries include archivedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const active = store.createTask("checkout");
    const archived = store.archiveTask(store.createTask("review").slug);

    const archivedAtByTaskId = new Map(
      store
        .listTaskSummaries()
        .map((summary) => [summary.id, summary.archivedAt]),
    );
    expect(archivedAtByTaskId.get(active.id)).toBe(null);
    expect(archivedAtByTaskId.get(archived.id)).toBe(archived.archivedAt);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive operations reject unknown refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);

    expect(() => store.archiveTask("missing")).toThrow(
      "Task not found: missing",
    );
    expect(() => store.unarchiveTask("missing")).toThrow(
      "Task not found: missing",
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive migration applies to an existing database", () => {
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
        ('064d73bdd21ec45f9426da414e3063223941d74ffaa57a91fa291ccfcfda6085', 1779999700000),
        ('415565e0a40c61e50a92f6774d3421e49f978ca93b897581c32fc975ec1fc41a', 1780019700000),
        ('0003-task-slug', 1780099700000);

      CREATE TABLE tasks (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        created_at text NOT NULL,
        project_root text DEFAULT '' NOT NULL,
        slug text
      );
      CREATE UNIQUE INDEX tasks_slug_unique ON tasks (slug);
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
        model text,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE set null
      );
      CREATE TABLE task_docs (
        task_id text NOT NULL,
        path text NOT NULL,
        created_at text NOT NULL,
        PRIMARY KEY(task_id, path),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE cascade
      );
      INSERT INTO tasks (id, title, created_at, project_root, slug)
        VALUES ('task-1', 'checkout', '2026-05-29T00:00:00.000Z', '', 'checkout');
    `);
    database.close();

    const store = openTraceStore(databasePath);
    expect(store.getTask("task-1")).toMatchObject({
      id: "task-1",
      archivedAt: null,
    });
    expect(store.archiveTask("checkout").archivedAt).toEqual(
      expect.any(String),
    );
    store.close();
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
      slug: "checkout",
      createdAt: "2026-05-29T00:00:00.000Z",
      projectRoot: "/repo",
      archivedAt: null,
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
    const docsDir = join(dir, ".trace", "tasks", task.slug, "docs");
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

test("new tasks read native docs from their slug-named directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("Manual Break");
    expect(task.slug).toBe("manual-break");

    const slugDocsDir = join(dir, ".trace", "tasks", task.slug, "docs");
    const nativeDocPath = join(slugDocsDir, "decision.md");
    mkdirSync(slugDocsDir, { recursive: true });
    writeFileSync(nativeDocPath, "# Decision\n");

    expect(store.listDocsForTask(task.id)).toEqual([
      expect.objectContaining({ taskId: task.id, path: nativeDocPath }),
    ]);
    expect(store.listDocsForTask(task.slug)).toEqual([
      expect.objectContaining({ taskId: task.id, path: nativeDocPath }),
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
    const docsDir = join(dir, ".trace", "tasks", task.slug, "docs");
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

test("re-entry manifest surfaces the task description when present, omits it when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const described = store.createTask(
      "archive",
      "/repo",
      "Move finished tasks out of the active board",
    );
    const plain = store.createTask("plain", "/repo");

    expect(store.getReEntryManifest(described.id)?.task).toEqual({
      id: described.id,
      title: "archive",
      projectRoot: "/repo",
      description: "Move finished tasks out of the active board",
    });

    const plainTask = store.getReEntryManifest(plain.id)?.task;
    expect(plainTask).toEqual({
      id: plain.id,
      title: "plain",
      projectRoot: "/repo",
    });
    expect(plainTask && "description" in plainTask).toBe(false);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskSummaries reports last activity and aggregated token totals", () => {
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

    waitForNextMillisecond();
    const doc = store.addTaskDoc(task.id, "/tmp/spec.md");

    const summaries = store.listTaskSummaries();
    expect(summaries.map((summary) => summary.id).sort()).toEqual(
      [task.id, emptyTask.id].sort(),
    );

    expect(summaries.find((summary) => summary.id === task.id)).toEqual({
      ...task,
      lastActivityAt: doc.createdAt,
      tokenTotals: {
        inputTokens: 17,
        outputTokens: 31,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 8,
        totalTokens: 58,
      },
    });

    expect(summaries.find((summary) => summary.id === emptyTask.id)).toEqual({
      ...emptyTask,
      lastActivityAt: emptyTask.createdAt,
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

test("listTaskSummaries falls back to task createdAt when only docs predate it is impossible, and a doc-only task uses the doc time", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("docs-only");

    waitForNextMillisecond();
    const doc = store.addTaskDoc(task.id, "/tmp/only-doc.md");

    const [summary] = store.listTaskSummaries();
    expect(summary).toEqual({
      ...task,
      lastActivityAt: doc.createdAt,
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

test("createTask persists and reads back a description", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const created = store.createTask(
      "Checkout flow",
      "/repo",
      "Rework the checkout into a multi-step wizard",
    );

    expect(created.description).toBe(
      "Rework the checkout into a multi-step wizard",
    );
    expect(store.getTask(created.id)).toEqual(created);
    store.close();

    const reopened = openTraceStore(databasePath);
    expect(reopened.getTask(created.id)).toEqual(created);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tasks created without a description read back with description absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const created = store.createTask("checkout");

    expect(created).not.toHaveProperty("description");
    expect(store.getTask(created.id)).not.toHaveProperty("description");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("description migration applies to an existing pre-description database", () => {
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
        ('064d73bdd21ec45f9426da414e3063223941d74ffaa57a91fa291ccfcfda6085', 1779999700000),
        ('415565e0a40c61e50a92f6774d3421e49f978ca93b897581c32fc975ec1fc41a', 1780019700000),
        ('0003-task-slug', 1780099700000),
        ('0004-task-archive', 1780119700000);

      CREATE TABLE tasks (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        created_at text NOT NULL,
        project_root text DEFAULT '' NOT NULL,
        slug text,
        archived_at text
      );
      CREATE UNIQUE INDEX tasks_slug_unique ON tasks (slug);
      CREATE TABLE sessions (
        id text PRIMARY KEY NOT NULL,
        transcript_path text NOT NULL,
        tool text NOT NULL,
        model text,
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
      INSERT INTO tasks (id, title, created_at, project_root, slug)
        VALUES ('task-1', 'checkout', '2026-05-29T00:00:00.000Z', '', 'checkout');
    `);
    database.close();

    const store = openTraceStore(databasePath);
    // The pre-existing row survives the ALTER and reads back without a description.
    expect(store.getTask("task-1")).not.toHaveProperty("description");
    // New rows can store a description through the migrated column.
    const created = store.createTask("review", "/repo", "Tidy the review flow");
    expect(store.getTask(created.id)?.description).toBe("Tidy the review flow");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTaskDescription sets and replaces a task's description", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const created = store.createTask("checkout");
    expect(created).not.toHaveProperty("description");

    const set = store.updateTaskDescription(created.id, "Rework the checkout");
    expect(set.description).toBe("Rework the checkout");
    expect(store.getTask(created.id)).toEqual(set);

    const replaced = store.updateTaskDescription(
      created.slug,
      "Now a multi-step wizard",
    );
    expect(replaced.description).toBe("Now a multi-step wizard");
    expect(store.getTask(created.id)?.description).toBe(
      "Now a multi-step wizard",
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTaskDescription rejects an unknown ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);

    expect(() => store.updateTaskDescription("missing", "text")).toThrow(
      "Task not found: missing",
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTask derives a slug from the title", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("Manual Break Start & Sounds");
    expect(task.slug).toBe("manual-break-start-sounds");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTask suffixes slugs on collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const first = store.createTask("Checkout");
    const second = store.createTask("checkout");
    const third = store.createTask("CHECKOUT");

    expect(first.slug).toBe("checkout");
    expect(second.slug).toBe("checkout-2");
    expect(third.slug).toBe("checkout-3");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTask gives untitled tasks a placeholder slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("   ");
    expect(task.title).toBe("");
    expect(task.slug).toBe(`task-${task.id.split("-")[0]}`);
    expect(store.getTaskByRef(task.slug)).toEqual(task);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slug column enforces uniqueness at the database level", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    store.createTask("checkout");
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      const indexes = database
        .prepare("PRAGMA index_list(tasks)")
        .all()
        .map((row) => (row as { unique: number }).unique);
      expect(indexes.some((unique) => unique === 1)).toBe(true);
    } finally {
      database.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTaskByRef resolves by uuid then slug and misses cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("Manual Break");

    expect(store.getTaskByRef(task.id)).toEqual(task);
    expect(store.getTaskByRef(task.slug)).toEqual(task);
    expect(store.getTaskByRef("does-not-exist")).toBeNull();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration backfills slugs for existing rows with collision handling", () => {
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
        ('064d73bdd21ec45f9426da414e3063223941d74ffaa57a91fa291ccfcfda6085', 1779999700000),
        ('c0ffee', 1780019700000);

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
        model text,
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
      INSERT INTO tasks (id, title, created_at, project_root) VALUES
        ('task-a', 'Checkout', '2026-05-29T00:00:00.000Z', '/repo'),
        ('task-b', 'checkout', '2026-05-29T00:00:01.000Z', '/repo'),
        ('task-c', '', '2026-05-29T00:00:02.000Z', '/repo');
    `);
    database.close();

    const store = openTraceStore(databasePath);
    expect(store.getTask("task-a")?.slug).toBe("checkout");
    expect(store.getTask("task-b")?.slug).toBe("checkout-2");
    // id "task-c" splits on its dash, so the placeholder short id is "task".
    expect(store.getTask("task-c")?.slug).toBe("task-task");

    // A new task created after backfill still gets a unique slug.
    const created = store.createTask("Checkout");
    expect(created.slug).toBe("checkout-3");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
