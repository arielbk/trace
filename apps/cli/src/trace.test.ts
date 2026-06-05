import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
