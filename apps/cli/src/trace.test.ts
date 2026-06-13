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

test("hook session-start registers a Claude session from stdin", () => {
  const home = tmp("trace-cli-hook-home-");
  const project = tmp("trace-cli-hook-project-");
  const transcript = join(project, "session.jsonl");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    writeFileSync(transcript, "");

    const result = runTraceCli(
      ["hook", "session-start"],
      env,
      project,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "hook-session",
        transcript_path: transcript,
        cwd: project,
      }),
    );

    expect(result.exitCode).toBe(0);

    const listed = runTraceCli(["session", "list", "--unassigned"], env, project);
    expect(listed.stdout).toContain(`hook-session\tclaude\t${transcript}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
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
      [
        "task",
        "capture",
        "Captured task",
        "--doc",
        docPath,
        "--project",
        nested,
      ],
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
      [
        "task",
        "capture",
        "Doomed capture",
        "--doc",
        docPath,
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
    const plain = runTraceCli(["skill", "recall-candidates"], env, sandbox);
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

test("skill work-on-task --help prints usage and creates no task", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    for (const flag of ["--help", "-h"]) {
      const result = runTraceCli(["skill", "work-on-task", flag], env, sandbox);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: trace skill work-on-task");
    }

    // The help flag must never be persisted as a task title.
    const candidates = runTraceCli(
      ["skill", "recall-candidates"],
      env,
      sandbox,
    );
    expect(candidates.exitCode).toBe(0);
    expect(JSON.parse(candidates.stdout)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill re-enter --help prints usage and exits 0", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    for (const flag of ["--help", "-h"]) {
      const result = runTraceCli(["skill", "re-enter", flag], env, sandbox);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: trace skill re-enter");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill re-enter with a flag ref exits non-zero with usage", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const result = runTraceCli(["skill", "re-enter", "--bogus"], env, sandbox);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage: trace skill re-enter");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill re-enter binds the current session to the task it re-enters", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const created = runTraceCli(["task", "create", "Reentry binds"], env, repo);
    expect(created.exitCode).toBe(0);

    // Re-enter from a live session: the env carries the session id the way
    // Claude Code exports it. Re-entry must bind that session, not just print
    // docs — that is the whole point of this task.
    const reentered = runTraceCli(
      ["skill", "re-enter", "Reentry binds"],
      { ...env, CLAUDE_CODE_SESSION_ID: "reenter-sess" },
      repo,
    );
    expect(reentered.exitCode).toBe(0);

    const active = runTraceCli(
      ["session", "active-task", "--id", "reenter-sess"],
      env,
      repo,
    );
    expect(JSON.parse(active.stdout)).toEqual({
      kind: "bound",
      task: { title: "Reentry binds", slug: "reentry-binds" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill re-enter without a session env prints the manifest and binds nothing", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const created = runTraceCli(["task", "create", "Manual read"], env, repo);
    expect(created.exitCode).toBe(0);

    // A human running re-enter at a bare terminal to read the docs: no session
    // env. The manifest still prints, and with no live session there is nothing
    // to bind, so no session row is fabricated.
    const reentered = runTraceCli(["skill", "re-enter", "Manual read"], env, repo);
    expect(reentered.exitCode).toBe(0);
    expect(reentered.stdout).toContain("title: Manual read");

    const sessions = runTraceCli(["session", "list", "--unassigned"], env, repo);
    expect(sessions.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("task create with a flag title still rejects with its original usage", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const result = runTraceCli(["task", "create", "--bogus"], env, sandbox);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage: trace task create <title>");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill work-on-task with a flag first arg exits non-zero and creates no task", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const result = runTraceCli(
      ["skill", "work-on-task", "--bogus"],
      env,
      sandbox,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage: trace skill work-on-task");

    const candidates = runTraceCli(
      ["skill", "recall-candidates"],
      env,
      sandbox,
    );
    expect(candidates.exitCode).toBe(0);
    expect(JSON.parse(candidates.stdout)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("session active-task reports a bound session's task as JSON", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const bound = runTraceCli(
      [
        "skill",
        "work-on-task",
        "Checkout flow",
        "--id",
        "session-1",
        "--transcript",
        join(repo, "s1.jsonl"),
        "--tool",
        "claude",
      ],
      env,
      repo,
    );
    expect(bound.exitCode).toBe(0);

    const result = runTraceCli(
      ["session", "active-task", "--id", "session-1"],
      env,
      repo,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      kind: "bound",
      task: { title: "Checkout flow", slug: "checkout-flow" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("session active-task offers re-entry for an unbound session in a known project", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    runTraceCli(["task", "create", "Prior work"], env, repo);
    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "session-2",
        "--transcript",
        join(repo, "s2.jsonl"),
        "--tool",
        "claude",
      ],
      env,
      repo,
    );

    const result = runTraceCli(
      ["session", "active-task", "--id", "session-2"],
      env,
      repo,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      kind: "re-enter",
      task: { title: "Prior work", slug: "prior-work" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("session active-task reports none for an unbound session in a fresh project", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "session-3",
        "--transcript",
        join(repo, "s3.jsonl"),
        "--tool",
        "claude",
      ],
      env,
      repo,
    );

    const result = runTraceCli(
      ["session", "active-task", "--id", "session-3"],
      env,
      repo,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ kind: "none" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("session active-task requires --id", () => {
  const home = tmp("trace-cli-home-");
  const sandbox = tmp("trace-cli-sandbox-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const result = runTraceCli(["session", "active-task"], env, sandbox);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--id");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill docs-dir prints the bound task's slug docs dir", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const bound = runTraceCli(
      [
        "skill",
        "work-on-task",
        "Checkout flow",
        "--id",
        "session-1",
        "--transcript",
        join(repo, "s1.jsonl"),
        "--tool",
        "claude",
      ],
      env,
      repo,
    );
    expect(bound.exitCode).toBe(0);

    const result = runTraceCli(
      ["skill", "docs-dir", "--id", "session-1"],
      env,
      repo,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `taskDocsDir: ${join(home, "tasks", "checkout-flow", "docs")}\n`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill docs-dir exits non-zero when the session can only re-enter", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    runTraceCli(["task", "create", "Prior work"], env, repo);
    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "session-2",
        "--transcript",
        join(repo, "s2.jsonl"),
        "--tool",
        "claude",
      ],
      env,
      repo,
    );

    const result = runTraceCli(
      ["skill", "docs-dir", "--id", "session-2"],
      env,
      repo,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("re-enter");
    expect(result.stderr).toContain("prior-work");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill docs-dir exits non-zero when there is no task to bind", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "session-3",
        "--transcript",
        join(repo, "s3.jsonl"),
        "--tool",
        "claude",
      ],
      env,
      repo,
    );

    const result = runTraceCli(
      ["skill", "docs-dir", "--id", "session-3"],
      env,
      repo,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("work-on-task");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill docs-dir infers the session from the env when --id is omitted", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const transcript = join(repo, "env-session.jsonl");
    const baseEnv = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

    const bound = runTraceCli(
      [
        "skill",
        "work-on-task",
        "Env bound work",
        "--id",
        "env-session",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      baseEnv,
      repo,
    );
    expect(bound.exitCode).toBe(0);

    const result = runTraceCli(
      ["skill", "docs-dir"],
      { ...baseEnv, CLAUDE_SESSION_ID: "env-session" },
      repo,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `taskDocsDir: ${join(home, "tasks", "env-bound-work", "docs")}\n`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill re-enter renders state: above docs: when a state.md doc exists", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const created = runTraceCli(
      ["task", "create", "State doc task"],
      env,
      repo,
    );
    expect(created.exitCode).toBe(0);
    const slug = created.stdout.trim();

    const stateDocPath = join(repo, "state.md");
    writeFileSync(stateDocPath, "# State\nCurrent state.\n");

    const addedState = runTraceCli(
      ["task", "add-doc", slug, stateDocPath],
      env,
      repo,
    );
    expect(addedState.exitCode).toBe(0);

    const otherDocPath = join(repo, "notes.md");
    writeFileSync(otherDocPath, "# Notes\n");
    const addedOther = runTraceCli(
      ["task", "add-doc", slug, otherDocPath],
      env,
      repo,
    );
    expect(addedOther.exitCode).toBe(0);

    const reentered = runTraceCli(
      ["skill", "re-enter", "State doc task"],
      env,
      repo,
    );
    expect(reentered.exitCode).toBe(0);

    const output = reentered.stdout;
    // state: block must appear and precede docs:
    expect(output).toContain("state:");
    expect(output.indexOf("state:")).toBeLessThan(output.indexOf("docs:"));
    // state.md must not appear in docs:
    const docsSection = output.slice(output.indexOf("docs:"));
    expect(docsSection).not.toContain("state.md");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill re-enter output is unchanged when no state.md exists", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const created = runTraceCli(
      ["task", "create", "No state doc task"],
      env,
      repo,
    );
    expect(created.exitCode).toBe(0);
    const slug = created.stdout.trim();

    const notesPath = join(repo, "notes.md");
    writeFileSync(notesPath, "# Notes\n");
    runTraceCli(["task", "add-doc", slug, notesPath], env, repo);

    const reentered = runTraceCli(
      ["skill", "re-enter", "No state doc task"],
      env,
      repo,
    );
    expect(reentered.exitCode).toBe(0);
    expect(reentered.stdout).not.toContain("state:");
    expect(reentered.stdout).toContain("docs:");
    expect(reentered.stdout).toContain("notes.md");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("skill re-enter output includes taskDocsDir even when the task has no docs", () => {
  const home = tmp("trace-cli-home-");
  const repoParent = tmp("trace-cli-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const created = runTraceCli(["task", "create", "Zero docs task"], env, repo);
    expect(created.exitCode).toBe(0);
    const slug = created.stdout.trim();

    const reentered = runTraceCli(
      ["skill", "re-enter", "Zero docs task"],
      env,
      repo,
    );
    expect(reentered.exitCode).toBe(0);
    expect(reentered.stdout).toContain(
      `taskDocsDir: ${join(home, "tasks", slug, "docs")}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});
