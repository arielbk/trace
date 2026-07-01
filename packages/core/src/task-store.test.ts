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
        "parent_session_id",
        "origin",
        "subagent_type",
        "agent_id",
        "title",
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

test("assignSession cascades the task_id to NULL-only descendants", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const otherTask = store.createTask("review");

    const parent = store.registerSession({
      id: "parent",
      transcriptPath: "/tmp/parent.jsonl",
      tool: "claude",
    });
    // (a) a child discovered before the parent bind — still NULL.
    store.registerSession({
      id: "child",
      transcriptPath: "/tmp/child.jsonl",
      tool: "claude",
      parentSessionId: parent.id,
      origin: "subagent",
    });
    // (b) a grandchild down a spawned chain — also NULL.
    store.registerSession({
      id: "grandchild",
      transcriptPath: "/tmp/grandchild.jsonl",
      tool: "claude",
      parentSessionId: "child",
      origin: "spawned",
    });
    // (c) a descendant already assigned to another task — left untouched.
    store.registerSession({
      id: "foreign-child",
      transcriptPath: "/tmp/foreign-child.jsonl",
      tool: "claude",
      parentSessionId: parent.id,
      origin: "subagent",
    });
    store.assignSession("foreign-child", otherTask.id);

    store.assignSession(parent.id, task.id);

    expect(store.getSession(parent.id)!.taskId).toBe(task.id);
    expect(store.getSession("child")!.taskId).toBe(task.id);
    expect(store.getSession("grandchild")!.taskId).toBe(task.id);
    expect(store.getSession("foreign-child")!.taskId).toBe(otherTask.id);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assignSession with no descendants is a no-op for the rest of the tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const leaf = store.registerSession({
      id: "leaf",
      transcriptPath: "/tmp/leaf.jsonl",
      tool: "claude",
    });
    const unrelated = store.registerSession({
      id: "unrelated",
      transcriptPath: "/tmp/unrelated.jsonl",
      tool: "claude",
    });

    const assigned = store.assignSession(leaf.id, task.id);

    expect(assigned.taskId).toBe(task.id);
    expect(store.getSession(unrelated.id)!.taskId).toBe(null);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session set-parent cascades a bound parent's task_id to the attached child and NULL descendants", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const otherTask = store.createTask("review");

    const parent = store.registerSession({
      id: "parent",
      transcriptPath: "/tmp/parent.jsonl",
      tool: "claude",
    });
    store.assignSession(parent.id, task.id);

    // A child discovered before it was attached to the parent — still NULL.
    const child = store.registerSession({
      id: "child",
      transcriptPath: "/tmp/child.jsonl",
      tool: "claude",
    });
    // A NULL grandchild already hanging off the child.
    store.registerSession({
      id: "grandchild",
      transcriptPath: "/tmp/grandchild.jsonl",
      tool: "claude",
      parentSessionId: child.id,
      origin: "spawned",
    });
    // A descendant already bound to another task — must stay put.
    store.registerSession({
      id: "foreign-grandchild",
      transcriptPath: "/tmp/foreign-grandchild.jsonl",
      tool: "claude",
      parentSessionId: child.id,
      origin: "subagent",
    });
    store.assignSession("foreign-grandchild", otherTask.id);

    const attached = store.setSessionParent({
      id: child.id,
      parentSessionId: parent.id,
      origin: "subagent",
    });

    expect(attached.taskId).toBe(task.id);
    expect(store.getSession("child")!.taskId).toBe(task.id);
    expect(store.getSession("grandchild")!.taskId).toBe(task.id);
    expect(store.getSession("foreign-grandchild")!.taskId).toBe(otherTask.id);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session set-parent leaves a child already on another task untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const otherTask = store.createTask("review");

    const parent = store.registerSession({
      id: "parent",
      transcriptPath: "/tmp/parent.jsonl",
      tool: "claude",
    });
    store.assignSession(parent.id, task.id);

    const child = store.registerSession({
      id: "child",
      transcriptPath: "/tmp/child.jsonl",
      tool: "claude",
    });
    store.assignSession(child.id, otherTask.id);

    const attached = store.setSessionParent({
      id: child.id,
      parentSessionId: parent.id,
      origin: "subagent",
    });

    expect(attached.taskId).toBe(otherTask.id);
    expect(store.getSession("child")!.taskId).toBe(otherTask.id);

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

test("session register round-trips explicit and absent titles", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const withTitle = store.registerSession({
      id: "with-title",
      transcriptPath: "/tmp/with-title.jsonl",
      tool: "claude",
      title: "Refactor the checkout flow",
    });
    const withoutTitle = store.registerSession({
      id: "without-title",
      transcriptPath: "/tmp/without-title.jsonl",
      tool: "codex",
    });

    expect(withTitle.title).toBe("Refactor the checkout flow");
    expect(withoutTitle.title).toBe(null);
    expect(store.getSession("with-title")!.title).toBe(
      "Refactor the checkout flow",
    );
    expect(store.getSession("without-title")!.title).toBe(null);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session register round-trips parent attribution fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: "parent-session",
      transcriptPath: "/tmp/parent-session.jsonl",
      tool: "claude",
    });
    const child = store.registerSession({
      id: "child-session",
      transcriptPath: "/tmp/child-session.jsonl",
      tool: "claude",
      parentSessionId: parent.id,
      origin: "subagent",
      subagentType: "general-purpose",
      agentId: "agent-123",
    });

    expect(parent).toMatchObject({
      parentSessionId: null,
      origin: "root",
      subagentType: null,
      agentId: null,
    });
    expect(child).toMatchObject({
      parentSessionId: parent.id,
      origin: "subagent",
      subagentType: "general-purpose",
      agentId: "agent-123",
    });
    expect(store.getSession(child.id)).toEqual(child);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session set-parent promotes an existing root session without clobbering registration fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: "parent-session",
      transcriptPath: "/tmp/parent-session.jsonl",
      tool: "claude",
    });
    const registered = store.registerSession({
      id: "child-session",
      transcriptPath: "/tmp/child-session.jsonl",
      tool: "claude",
      model: "claude-opus-4-7",
      tokenTotals: { inputTokens: 12, totalTokens: 12 },
    });

    const promoted = store.setSessionParent({
      id: registered.id,
      parentSessionId: parent.id,
      origin: "spawned",
    });

    expect(promoted).toMatchObject({
      id: registered.id,
      transcriptPath: "/tmp/child-session.jsonl",
      tool: "claude",
      model: "claude-opus-4-7",
      parentSessionId: parent.id,
      origin: "spawned",
    });
    expect(promoted.tokenTotals.inputTokens).toBe(12);
    expect(store.getSession(registered.id)).toEqual(promoted);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session set-parent creates an unknown child as a codex virtual session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: "parent-session",
      transcriptPath: "/tmp/parent-session.jsonl",
      tool: "claude",
    });

    const child = store.setSessionParent({
      id: "codex-thread-1",
      parentSessionId: parent.id,
      origin: "spawned",
    });

    expect(child).toMatchObject({
      id: "codex-thread-1",
      transcriptPath: "codex:codex-thread-1",
      tool: "codex",
      model: null,
      parentSessionId: parent.id,
      origin: "spawned",
      subagentType: null,
      agentId: null,
    });
    expect(store.getSession(child.id)).toEqual(child);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session set-parent creates an unknown child with the given tool and transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: "parent-session",
      transcriptPath: "/tmp/parent-session.jsonl",
      tool: "claude",
    });

    const child = store.setSessionParent({
      id: "claude-child-1",
      parentSessionId: parent.id,
      origin: "spawned",
      tool: "claude",
      transcriptPath: "/tmp/claude-child-1.jsonl",
    });

    expect(child).toMatchObject({
      id: "claude-child-1",
      transcriptPath: "/tmp/claude-child-1.jsonl",
      tool: "claude",
      parentSessionId: parent.id,
      origin: "spawned",
    });
    expect(store.getSession(child.id)).toEqual(child);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session set-parent creates an unknown child with an explicit codex tool and transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: "parent-session",
      transcriptPath: "/tmp/parent-session.jsonl",
      tool: "claude",
    });

    const child = store.setSessionParent({
      id: "codex-thread-2",
      parentSessionId: parent.id,
      origin: "spawned",
      tool: "codex",
      transcriptPath: "/tmp/codex-thread-2-rollout.jsonl",
    });

    expect(child).toMatchObject({
      id: "codex-thread-2",
      transcriptPath: "/tmp/codex-thread-2-rollout.jsonl",
      tool: "codex",
      parentSessionId: parent.id,
      origin: "spawned",
    });

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session register enriches a set-parent-created child without wiping its attribution", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: "parent-session",
      transcriptPath: "/tmp/parent-session.jsonl",
      tool: "claude",
    });
    store.setSessionParent({
      id: "codex-thread-1",
      parentSessionId: parent.id,
      origin: "spawned",
    });

    const registered = store.registerSession({
      id: "codex-thread-1",
      transcriptPath: "/tmp/codex-thread-1.jsonl",
      tool: "codex",
      model: "gpt-5-codex",
      tokenTotals: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });

    expect(registered).toMatchObject({
      id: "codex-thread-1",
      transcriptPath: "/tmp/codex-thread-1.jsonl",
      tool: "codex",
      model: "gpt-5-codex",
      parentSessionId: parent.id,
      origin: "spawned",
    });
    expect(registered.tokenTotals).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
    expect(store.getSession(registered.id)).toEqual(registered);

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
        title: null,
        taskId: "task-1",
        parentSessionId: null,
        origin: "root",
        subagentType: null,
        agentId: null,
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

test("addTaskDoc persists and reads back an optional description", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

    const described = store.addTaskDoc(task.id, "/tmp/spec.md", {
      description: "The spec",
    });
    expect(described.description).toBe("The spec");

    const undescribed = store.addTaskDoc(task.id, "/tmp/notes.md");
    expect("description" in undescribed).toBe(false);

    const reread = store.listDocsForTask(task.id);
    expect(reread.find((d) => d.path === "/tmp/spec.md")).toEqual(described);
    expect(reread.find((d) => d.path === "/tmp/notes.md")).toEqual(undescribed);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addTaskDoc persists and reads back an optional title", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

    const titled = store.addTaskDoc(task.id, "/tmp/spec.md", {
      title: "Checkout Spec",
      description: "The spec",
    });
    expect(titled.title).toBe("Checkout Spec");
    expect(titled.description).toBe("The spec");

    const untitled = store.addTaskDoc(task.id, "/tmp/notes.md");
    expect("title" in untitled).toBe(false);

    const reread = store.listDocsForTask(task.id);
    expect(reread.find((d) => d.path === "/tmp/spec.md")).toEqual(titled);
    expect(reread.find((d) => d.path === "/tmp/notes.md")).toEqual(untitled);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTaskDoc sets title and description on an existing registered doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    store.addTaskDoc(task.id, "/tmp/spec.md");

    const updated = store.updateTaskDoc(task.id, "/tmp/spec.md", {
      title: "Checkout Spec",
      description: "The spec",
    });
    expect(updated.title).toBe("Checkout Spec");
    expect(updated.description).toBe("The spec");

    const reread = store.listDocsForTask(task.id);
    expect(reread.find((d) => d.path === "/tmp/spec.md")).toEqual(updated);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTaskDoc leaves an omitted field untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    store.addTaskDoc(task.id, "/tmp/spec.md", {
      title: "Original Title",
      description: "Original description",
    });

    // Only --title given; description must survive untouched.
    const updated = store.updateTaskDoc(task.id, "/tmp/spec.md", {
      title: "New Title",
    });
    expect(updated.title).toBe("New Title");
    expect(updated.description).toBe("Original description");

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTaskDoc clears a field when given an empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    store.addTaskDoc(task.id, "/tmp/spec.md", {
      title: "Original Title",
      description: "Original description",
    });

    const updated = store.updateTaskDoc(task.id, "/tmp/spec.md", {
      description: "",
    });
    expect(updated.title).toBe("Original Title");
    expect("description" in updated).toBe(false);

    const reread = store.listDocsForTask(task.id);
    expect(reread.find((d) => d.path === "/tmp/spec.md")).toEqual(updated);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTaskDoc inserts a row for a doc that was never registered", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

    // No prior addTaskDoc — mirrors a filesystem-discovered native doc that
    // has no task_docs row yet.
    const updated = store.updateTaskDoc(task.id, "/tmp/state.md", {
      title: "Session state",
      description: "Where the work stands",
    });
    expect(updated.title).toBe("Session state");
    expect(updated.description).toBe("Where the work stands");

    const reread = store.listDocsForTask(task.id);
    expect(reread.find((d) => d.path === "/tmp/state.md")).toEqual(updated);

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

test("task timeline surfaces a stored session title as the session name", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const session = store.registerSession({
      id: "titled-timeline-session",
      transcriptPath: "/tmp/titled-timeline.jsonl",
      tool: "claude",
      title: "Wire up the payment provider",
    });
    store.assignSession(session.id, task.id);

    const timeline = store.getTaskTimeline(task.id)!;
    const item = timeline.items.find((i) => i.type === "session");
    expect(item).toMatchObject({
      type: "session",
      sessionName: "Wire up the payment provider",
    });

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
          sessionName: null,
        },
        { type: "doc", createdAt: doc.createdAt, doc, sizeBytes: null },
        {
          type: "session",
          createdAt: codexSession.createdAt,
          session: { ...codexSession, taskId: task.id },
          sessionName: null,
        },
      ],
      lastActivityAt: codexSession.createdAt,
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
      taskDocsDir: join(dir, ".trace", "tasks", task.slug, "docs"),
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
      taskDocsDir: join(dir, ".trace", "tasks", task.slug, "docs"),
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

test("re-entry manifest puts state.md in state: field and excludes it from docs:", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("my-feature", "/repo");
    const docsDir = join(dir, ".trace", "tasks", task.slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    const statePath = join(docsDir, "state.md");
    const otherDocPath = join(docsDir, "notes.md");
    writeFileSync(statePath, "# State\n");
    writeFileSync(otherDocPath, "# Notes\n");

    const manifest = store.getReEntryManifest(task.id);

    expect(manifest?.state).toEqual(expect.objectContaining({ path: statePath }));
    const docPaths = manifest?.docs.map((d) => d.path) ?? [];
    expect(docPaths).not.toContain(statePath);
    expect(docPaths).toContain(otherDocPath);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entry manifest carries taskDocsDir derived from the database path and task slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("docs-dir-feature", "/repo");

    const manifest = store.getReEntryManifest(task.id);

    expect(manifest?.taskDocsDir).toBe(
      join(dir, ".trace", "tasks", task.slug, "docs"),
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entry manifest omits state: field when no state.md exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("no-state", "/repo");
    const docsDir = join(dir, ".trace", "tasks", task.slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "plan.md"), "# Plan\n");

    const manifest = store.getReEntryManifest(task.id);

    expect("state" in (manifest ?? {})).toBe(false);
    expect(manifest?.docs.map((d) => d.path)).toContain(join(docsDir, "plan.md"));

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
      agentTools: ["claude", "codex"],
      hasDocs: true,
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
      agentTools: [],
      hasDocs: false,
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
      agentTools: [],
      hasDocs: true,
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

test("getSession refreshes a stored title when the transcript's title changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "ai-title",
      sessionId: "titled-session",
      aiTitle: "First generated name",
    })}\n`,
  );

  try {
    const store = openTraceStore(databasePath);
    const session = store.registerSession({
      id: "titled-session",
      transcriptPath,
      tool: "claude",
    });
    expect(session.title).toBe(null);

    // First read refreshes the title from the transcript and persists it.
    expect(store.getSession(session.id)!.title).toBe("First generated name");

    // Claude re-emits ai-title when it renames the conversation; the refresh
    // path should pick up the new name.
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "ai-title",
        sessionId: "titled-session",
        aiTitle: "Renamed conversation",
      })}\n`,
    );
    expect(store.getSession(session.id)!.title).toBe("Renamed conversation");

    // Deleting the transcript falls back to the persisted (refreshed) title.
    unlinkSync(transcriptPath);
    expect(store.getSession(session.id)!.title).toBe("Renamed conversation");

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

test("listTaskSummaries agentTools: none when task has no sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    store.createTask("no-sessions");

    const [summary] = store.listTaskSummaries();
    expect(summary?.agentTools).toEqual([]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskSummaries agentTools: claude-only when only claude sessions exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("claude-only");
    const s1 = store.registerSession({ id: "s1", transcriptPath: "/t1.jsonl", tool: "claude" });
    const s2 = store.registerSession({ id: "s2", transcriptPath: "/t2.jsonl", tool: "claude" });
    store.assignSession(s1.id, task.id);
    store.assignSession(s2.id, task.id);

    const [summary] = store.listTaskSummaries();
    expect(summary?.agentTools).toEqual(["claude"]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskSummaries agentTools: codex-only when only codex sessions exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("codex-only");
    const s1 = store.registerSession({ id: "s1", transcriptPath: "/t1.jsonl", tool: "codex" });
    store.assignSession(s1.id, task.id);

    const [summary] = store.listTaskSummaries();
    expect(summary?.agentTools).toEqual(["codex"]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskSummaries agentTools: both tools sorted when both claude and codex sessions exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("both-tools");
    const claude = store.registerSession({ id: "c1", transcriptPath: "/c1.jsonl", tool: "claude" });
    const codex = store.registerSession({ id: "cx1", transcriptPath: "/cx1.jsonl", tool: "codex" });
    store.assignSession(claude.id, task.id);
    store.assignSession(codex.id, task.id);

    const [summary] = store.listTaskSummaries();
    expect(summary?.agentTools).toEqual(["claude", "codex"]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskSummaries hasDocs: false when no task_docs entries exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    store.createTask("no-docs");

    const [summary] = store.listTaskSummaries();
    expect(summary?.hasDocs).toBe(false);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskSummaries hasDocs: true when task_docs entries exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("has-docs");
    store.addTaskDoc(task.id, "/tmp/spec.md");

    const [summary] = store.listTaskSummaries();
    expect(summary?.hasDocs).toBe(true);

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
