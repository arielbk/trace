import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTraceStore } from "@trace/core";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("work-on-task declares project creation then links a sibling worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-project-resolution-"));
  const databasePath = join(dir, "trace.sqlite");
  const mainRoot = join(dir, "trace");
  const worktreeRoot = join(dir, "trace-worktree");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    mkdirSync(mainRoot);
    git(mainRoot, "init", "--quiet");
    git(mainRoot, "config", "user.email", "trace@example.com");
    git(mainRoot, "config", "user.name", "Trace Tests");
    writeFileSync(join(mainRoot, "README.md"), "trace\n");
    git(mainRoot, "add", "README.md");
    git(mainRoot, "commit", "--quiet", "-m", "initial");
    git(mainRoot, "worktree", "add", "--quiet", "--detach", worktreeRoot);

    const created = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "Main task",
        "--id",
        "session-main",
        "--transcript",
        join(mainRoot, "main.jsonl"),
        "--tool",
        "codex",
      ],
      { cwd: mainRoot, encoding: "utf8", env },
    );
    const recalledFromWorktree = execFileSync(
      process.execPath,
      [traceBin, "skill", "recall-candidates"],
      { cwd: worktreeRoot, encoding: "utf8", env },
    );
    const linked = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "Worktree task",
        "--id",
        "session-worktree",
        "--transcript",
        join(worktreeRoot, "worktree.jsonl"),
        "--tool",
        "codex",
      ],
      { cwd: worktreeRoot, encoding: "utf8", env },
    );

    expect(created).toContain("created new project trace\n");
    expect(JSON.parse(recalledFromWorktree)).toEqual([
      { title: "Main task", slug: "main-task" },
    ]);
    expect(linked).toContain("linked to existing project trace\n");

    const store = openTraceStore(databasePath);
    expect(store.getTaskByRef("main-task")?.projectId).toBe(
      store.getTaskByRef("worktree-task")?.projectId,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
