import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { openTraceStore, readProjectFingerprints } from "./index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "trace@example.com");
  git(root, "config", "user.name", "Trace Tests");
  writeFileSync(join(root, "README.md"), "trace\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "initial");
}

function createLegacyDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
    INSERT INTO "__drizzle_migrations" (hash, created_at)
      VALUES ('0011-task-pin', 1780259700000);

    CREATE TABLE tasks (
      id text PRIMARY KEY NOT NULL,
      title text NOT NULL,
      slug text NOT NULL UNIQUE,
      created_at text NOT NULL,
      project_root text DEFAULT '' NOT NULL,
      archived_at text,
      description text,
      pinned_at text
    );
    CREATE TABLE sessions (
      id text PRIMARY KEY NOT NULL,
      transcript_path text NOT NULL,
      tool text NOT NULL,
      model text,
      title text,
      task_id text REFERENCES tasks(id) ON DELETE set null,
      parent_session_id text REFERENCES sessions(id) ON DELETE set null,
      origin text DEFAULT 'root' NOT NULL,
      subagent_type text,
      agent_id text,
      created_at text NOT NULL,
      input_tokens integer DEFAULT 0 NOT NULL,
      output_tokens integer DEFAULT 0 NOT NULL,
      cache_creation_input_tokens integer DEFAULT 0 NOT NULL,
      cache_read_input_tokens integer DEFAULT 0 NOT NULL,
      total_tokens integer DEFAULT 0 NOT NULL,
      context_tokens_used integer,
      context_tokens_limit integer
    );
    CREATE TABLE task_docs (
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE cascade,
      path text NOT NULL,
      created_at text NOT NULL,
      title text,
      description text,
      PRIMARY KEY(task_id, path)
    );
  `);
  return database;
}

test("migration backfills a path-only project and exposes project getters", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-store-"));
  const databasePath = join(dir, "trace.sqlite");
  const staleRoot = join(dir, "missing", "checkout");

  try {
    const database = createLegacyDatabase(databasePath);
    database
      .prepare(
        `INSERT INTO tasks
          (id, title, slug, created_at, project_root)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "task-1",
        "Checkout",
        "checkout",
        "2026-07-01T00:00:00.000Z",
        staleRoot,
      );
    database.close();

    const store = openTraceStore(databasePath);
    const project = store.getProjectByRoot(staleRoot);

    expect(project).toMatchObject({
      slug: "checkout",
      remoteUrl: null,
      rootCommit: null,
    });
    expect(store.getProject(project!.id)).toEqual(project);
    expect(store.getProjectBySlug("checkout")).toEqual(project);
    expect(store.getProjectByFingerprint({})).toBeNull();
    expect(store.getTask("task-1")?.projectId).toBe(project?.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration merges a repository and its worktree into one project", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-store-"));
  const databasePath = join(dir, "trace.sqlite");
  const mainRoot = join(dir, "trace");
  const worktreeRoot = join(dir, "trace-worktree");

  try {
    createRepository(mainRoot);
    git(mainRoot, "worktree", "add", "--quiet", "--detach", worktreeRoot);

    const database = createLegacyDatabase(databasePath);
    const insert = database.prepare(
      `INSERT INTO tasks
        (id, title, slug, created_at, project_root)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      "task-main",
      "Main task",
      "main-task",
      "2026-07-01T00:00:00.000Z",
      mainRoot,
    );
    insert.run(
      "task-worktree",
      "Worktree task",
      "worktree-task",
      "2026-07-01T00:00:01.000Z",
      worktreeRoot,
    );
    database.close();

    const store = openTraceStore(databasePath);
    const mainProject = store.getProjectByRoot(mainRoot);
    const worktreeProject = store.getProjectByRoot(worktreeRoot);
    expect(worktreeProject).toEqual(mainProject);
    expect(
      store.getProjectByFingerprint(readProjectFingerprints(worktreeRoot)),
    ).toEqual(mainProject);
    expect(store.getTask("task-main")?.projectId).toBe(mainProject?.id);
    expect(store.getTask("task-worktree")?.projectId).toBe(mainProject?.id);
    store.close();

    const migrated = new DatabaseSync(databasePath);
    expect(
      (migrated.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
        count: number;
      }).count,
    ).toBe(1);
    expect(
      (
        migrated
          .prepare("SELECT COUNT(*) AS count FROM project_roots")
          .get() as { count: number }
      ).count,
    ).toBe(2);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall candidates follow project identity across sibling worktrees", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-recall-"));
  const databasePath = join(dir, "trace.sqlite");
  const mainRoot = join(dir, "trace");
  const worktreeRoot = join(dir, "trace-worktree");
  const unrelatedRoot = join(dir, "unrelated");

  try {
    createRepository(mainRoot);
    git(mainRoot, "worktree", "add", "--quiet", "--detach", worktreeRoot);
    createRepository(unrelatedRoot);
    git(unrelatedRoot, "commit", "--amend", "--quiet", "-m", "unrelated");

    const store = openTraceStore(databasePath);
    const target = store.createTask("Shared checkout", mainRoot);
    store.createTask("Unrelated work", unrelatedRoot);

    expect(store.recallCandidates(worktreeRoot)).toEqual([
      { title: target.title, slug: target.slug },
    ]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("most-recent task follows project identity across sibling worktrees", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-active-task-"));
  const databasePath = join(dir, "trace.sqlite");
  const mainRoot = join(dir, "trace");
  const worktreeRoot = join(dir, "trace-worktree");
  const unrelatedRoot = join(dir, "unrelated");

  try {
    createRepository(mainRoot);
    git(mainRoot, "worktree", "add", "--quiet", "--detach", worktreeRoot);
    createRepository(unrelatedRoot);
    git(unrelatedRoot, "commit", "--amend", "--quiet", "-m", "unrelated");

    const store = openTraceStore(databasePath);
    const target = store.createTask("Shared checkout", mainRoot);
    store.createTask("Newer unrelated work", unrelatedRoot);
    store.registerSession({
      id: "session-worktree",
      transcriptPath: join(worktreeRoot, "session.jsonl"),
      tool: "codex",
    });

    expect(store.resolveActiveTask("session-worktree", worktreeRoot)).toEqual({
      kind: "re-enter",
      task: target,
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task summaries expose stable project identity alongside the root path", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-summary-"));
  const databasePath = join(dir, "trace.sqlite");
  const projectRoot = join(dir, "checkout-app");

  try {
    createRepository(projectRoot);

    const store = openTraceStore(databasePath);
    const task = store.createTask("Shared checkout", projectRoot);
    const summary = store
      .listTaskSummaries()
      .find((candidate) => candidate.id === task.id);

    expect(summary).toMatchObject({
      projectRoot,
      projectId: task.projectId,
      projectSlug: "checkout-app",
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration allocates stable unique slugs for same-named stale roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-store-"));
  const databasePath = join(dir, "trace.sqlite");
  const firstRoot = join(dir, "one", "checkout");
  const secondRoot = join(dir, "two", "checkout");

  try {
    const database = createLegacyDatabase(databasePath);
    const insert = database.prepare(
      `INSERT INTO tasks
        (id, title, slug, created_at, project_root)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      "task-1",
      "First",
      "first",
      "2026-07-01T00:00:00.000Z",
      firstRoot,
    );
    insert.run(
      "task-2",
      "Second",
      "second",
      "2026-07-01T00:00:01.000Z",
      secondRoot,
    );
    database.close();

    const store = openTraceStore(databasePath);
    const first = store.getProjectByRoot(firstRoot)!;
    const second = store.getProjectByRoot(secondRoot)!;
    expect([first.slug, second.slug]).toEqual(["checkout", "checkout-2"]);
    store.close();

    const reopened = openTraceStore(databasePath);
    expect(reopened.getProjectByRoot(firstRoot)).toEqual(first);
    expect(reopened.getProjectByRoot(secondRoot)).toEqual(second);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project resolution creates once and returns the known mapping thereafter", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-resolution-"));
  const databasePath = join(dir, "trace.sqlite");
  const root = join(dir, "checkout");
  mkdirSync(root);

  try {
    const store = openTraceStore(databasePath);
    const created = store.resolveProject(root);
    const known = store.resolveProject(root);

    expect(created).toMatchObject({
      kind: "created",
      project: { slug: "checkout" },
    });
    expect(known).toEqual({ kind: "known", project: created.project });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project resolution links an unrecognized worktree by fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-resolution-"));
  const databasePath = join(dir, "trace.sqlite");
  const mainRoot = join(dir, "trace");
  const worktreeRoot = join(dir, "trace-worktree");

  try {
    createRepository(mainRoot);
    git(mainRoot, "worktree", "add", "--quiet", "--detach", worktreeRoot);

    const store = openTraceStore(databasePath);
    const created = store.resolveProject(mainRoot);
    const linked = store.resolveProject(worktreeRoot);

    expect(created.kind).toBe("created");
    expect(linked).toEqual({ kind: "linked", project: created.project });
    expect(store.getProjectByRoot(worktreeRoot)).toEqual(created.project);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project resolution hints how to merge a same-named fingerprint miss", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-resolution-"));
  const databasePath = join(dir, "trace.sqlite");
  const firstRoot = join(dir, "one", "checkout");
  const secondRoot = join(dir, "two", "checkout");
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });

  try {
    const store = openTraceStore(databasePath);
    const canonical = store.resolveProject(firstRoot);
    const duplicate = store.resolveProject(secondRoot);

    expect(duplicate).toMatchObject({
      kind: "created",
      project: { slug: "checkout-2" },
      collisionHint: {
        duplicateSlug: "checkout-2",
        canonicalSlug: canonical.project.slug,
      },
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project merge moves tasks and roots, unions fingerprints, and deletes the duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-merge-"));
  const databasePath = join(dir, "trace.sqlite");
  const canonicalRoot = join(dir, "one", "checkout");
  const duplicateRoot = join(dir, "two", "checkout");
  mkdirSync(canonicalRoot, { recursive: true });

  try {
    createRepository(duplicateRoot);
    git(duplicateRoot, "remote", "add", "origin", "git@github.com:Trace/Checkout.git");

    const store = openTraceStore(databasePath);
    const canonicalTask = store.createTask("Canonical task", canonicalRoot);
    const duplicateTask = store.createTask("Duplicate task", duplicateRoot);
    const canonical = store.getProjectByRoot(canonicalRoot)!;
    const duplicate = store.getProjectByRoot(duplicateRoot)!;
    const duplicateFingerprints = readProjectFingerprints(duplicateRoot);

    const merged = store.mergeProjects(duplicate.slug, canonical.slug);

    expect(merged).toEqual({
      duplicateSlug: duplicate.slug,
      canonicalSlug: canonical.slug,
      tasksMoved: 1,
      rootsMoved: 1,
      fingerprintsAdded: ["remote URL", "root commit"],
    });
    expect(store.getProjectBySlug(duplicate.slug)).toBeNull();
    expect(store.getTask(canonicalTask.id)?.projectId).toBe(canonical.id);
    expect(store.getTask(duplicateTask.id)?.projectId).toBe(canonical.id);
    expect(store.getProjectByRoot(canonicalRoot)?.id).toBe(canonical.id);
    expect(store.getProjectByRoot(duplicateRoot)?.id).toBe(canonical.id);
    expect(store.getProject(canonical.id)).toMatchObject({
      remoteUrl: duplicateFingerprints.remoteUrl,
      rootCommit: duplicateFingerprints.rootCommit,
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project merge rejects an unknown slug and names near candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-merge-missing-"));
  const databasePath = join(dir, "trace.sqlite");
  const canonicalRoot = join(dir, "one", "checkout");
  const duplicateRoot = join(dir, "two", "checkout");
  mkdirSync(canonicalRoot, { recursive: true });
  mkdirSync(duplicateRoot, { recursive: true });

  try {
    const store = openTraceStore(databasePath);
    const canonical = store.resolveProject(canonicalRoot).project;
    const duplicate = store.resolveProject(duplicateRoot).project;

    expect(() => store.mergeProjects("check", canonical.slug)).toThrow(
      `Project not found: check\nNear candidates:\n  ${canonical.slug}\n  ${duplicate.slug}`,
    );
    expect(() => store.mergeProjects(duplicate.slug, "check")).toThrow(
      `Project not found: check\nNear candidates:\n  ${canonical.slug}\n  ${duplicate.slug}`,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project merge rejects merging a project into itself without changing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-merge-self-"));
  const databasePath = join(dir, "trace.sqlite");
  const root = join(dir, "checkout");
  mkdirSync(root);

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("Keep me", root);
    const project = store.getProjectByRoot(root)!;

    expect(() => store.mergeProjects(project.slug, project.slug)).toThrow(
      `Cannot merge project ${project.slug} into itself`,
    );
    expect(store.getProjectBySlug(project.slug)).toEqual(project);
    expect(store.getTask(task.id)?.projectId).toBe(project.id);
    expect(store.getProjectByRoot(root)?.id).toBe(project.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
