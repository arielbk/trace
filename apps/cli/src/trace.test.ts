import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("task create --project keys the task to the override repo's git root", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const projectParent = tmp("trace-cli-project-");
  const projectRepo = join(projectParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    // The flag points at a nested dir of an unrelated repo, run from a sandbox
    // cwd that is not inside that repo — the stored root must be the repo root.
    const nested = join(projectRepo, "packages", "core");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(projectRepo, ".git"));

    const created = runTraceCli(
      ["task", "create", "Override task", "--project", nested],
      env,
      sandbox,
    );
    expect(created.exitCode).toBe(0);
    const slug = created.stdout.trim();

    const shown = runTraceCli(["task", "show", slug], env, sandbox);
    expect(shown.stdout).toContain(`projectRoot: ${projectRepo}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(projectParent, { recursive: true, force: true });
  }
});

test("task capture --project keys the task to the override repo's git root", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const projectParent = tmp("trace-cli-project-");
  const projectRepo = join(projectParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const nested = join(projectRepo, "packages", "core");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(projectRepo, ".git"));

    const docPath = join(sandbox, "capture.md");
    writeFileSync(docPath, "# Captured\n");

    const captured = runTraceCli(
      ["task", "capture", "Captured task", "--doc", docPath, "--project", nested],
      env,
      sandbox,
    );
    expect(captured.exitCode).toBe(0);
    const id = captured.stdout.trim();

    const shown = runTraceCli(["task", "show", id], env, sandbox);
    expect(shown.stdout).toContain(`projectRoot: ${projectRepo}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(projectParent, { recursive: true, force: true });
  }
});

test("task capture with a nonexistent --project exits non-zero naming the path", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
  const missing = join(sandbox, "does-not-exist");

  try {
    const docPath = join(sandbox, "capture.md");
    writeFileSync(docPath, "# Captured\n");

    const result = runTraceCli(
      ["task", "capture", "Doomed capture", "--doc", docPath, "--project", missing],
      env,
      sandbox,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(missing);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill work-on-task --project keys a new task to the override repo's git root", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const projectParent = tmp("trace-cli-project-");
  const projectRepo = join(projectParent, "repo");
  const transcript = join(sandbox, "session.jsonl");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const nested = join(projectRepo, "packages", "core");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(projectRepo, ".git"));
    writeFileSync(transcript, "");

    const result = runTraceCli(
      [
        "skill",
        "work-on-task",
        "Bound task",
        "--id",
        "sess-1",
        "--transcript",
        transcript,
        "--tool",
        "claude",
        "--project",
        nested,
      ],
      env,
      sandbox,
    );
    expect(result.exitCode).toBe(0);

    const reentered = runTraceCli(
      ["skill", "re-enter", "Bound task"],
      env,
      sandbox,
    );
    expect(reentered.stdout).toContain(`projectRoot: ${projectRepo}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(projectParent, { recursive: true, force: true });
  }
});

test("skill work-on-task with a nonexistent --project exits non-zero naming the path", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const transcript = join(sandbox, "session.jsonl");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
  const missing = join(sandbox, "does-not-exist");

  try {
    writeFileSync(transcript, "");

    const result = runTraceCli(
      [
        "skill",
        "work-on-task",
        "Doomed bind",
        "--id",
        "sess-1",
        "--transcript",
        transcript,
        "--tool",
        "claude",
        "--project",
        missing,
      ],
      env,
      sandbox,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(missing);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill recall-candidates --project scopes the pool to the override repo's git root", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const projectParent = tmp("trace-cli-project-");
  const projectRepo = join(projectParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const nested = join(projectRepo, "packages", "core");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(projectRepo, ".git"));

    // Create a task keyed to the override repo, run from an unrelated sandbox cwd.
    const created = runTraceCli(
      ["task", "create", "Recall target", "--project", nested],
      env,
      sandbox,
    );
    expect(created.exitCode).toBe(0);

    // With --project pointing at that repo, the task is in the candidate pool.
    const scoped = runTraceCli(
      ["skill", "recall-candidates", "--project", nested],
      env,
      sandbox,
    );
    expect(scoped.exitCode).toBe(0);
    const scopedCandidates = JSON.parse(scoped.stdout) as Array<{
      title: string;
    }>;
    expect(scopedCandidates.map((c) => c.title)).toContain("Recall target");

    // A plain run from the sandbox cwd resolves a different project root, so
    // the task is absent.
    const plain = runTraceCli(
      ["skill", "recall-candidates"],
      env,
      sandbox,
    );
    expect(plain.exitCode).toBe(0);
    const plainCandidates = JSON.parse(plain.stdout) as Array<{
      title: string;
    }>;
    expect(plainCandidates.map((c) => c.title)).not.toContain("Recall target");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(projectParent, { recursive: true, force: true });
  }
});

test("skill recall-candidates with a nonexistent --project exits non-zero naming the path", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
  const missing = join(sandbox, "does-not-exist");

  try {
    const result = runTraceCli(
      ["skill", "recall-candidates", "--project", missing],
      env,
      sandbox,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(missing);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("task create without --project resolves the cwd's git root (unchanged)", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const cwd = join(repo, "src");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repo, ".git"));

    const created = runTraceCli(["task", "create", "Local task"], env, cwd);
    expect(created.exitCode).toBe(0);
    const slug = created.stdout.trim();

    const shown = runTraceCli(["task", "show", slug], env, cwd);
    expect(shown.stdout).toContain(`projectRoot: ${repo}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("task create with a nonexistent --project exits non-zero naming the path", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
  const missing = join(sandbox, "does-not-exist");

  try {
    const result = runTraceCli(
      ["task", "create", "Doomed task", "--project", missing],
      env,
      sandbox,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(missing);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});
