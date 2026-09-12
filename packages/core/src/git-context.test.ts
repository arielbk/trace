import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import {
  lastWorkedOnFromContext,
  lastWorkedOnFromSessions,
  readGitWorkContext,
} from "./git-context.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(branch = "main"): string {
  const root = mkdtempSync(join(tmpdir(), "trace-git-context-"));
  git(root, "init", "-b", branch, "--quiet");
  git(root, "config", "user.email", "trace@example.com");
  git(root, "config", "user.name", "EQNX Tests");
  writeFileSync(join(root, "README.md"), "trace\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

test("reads the current branch including the default branch", () => {
  const root = createRepository("main");

  try {
    expect(readGitWorkContext(root)).toMatchObject({ branch: "main" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("omits a worktree label for a primary checkout", () => {
  const root = createRepository();

  try {
    expect(readGitWorkContext(root).worktreeLabel).toBeUndefined();
    expect(readGitWorkContext(root)).not.toHaveProperty("commit");
    expect(readGitWorkContext(root)).not.toHaveProperty("head");
    expect(Object.keys(readGitWorkContext(root)).sort()).toEqual(
      ["branch", "localPath"].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("labels a linked worktree by its directory name", () => {
  const root = createRepository();
  const container = mkdtempSync(join(tmpdir(), "trace-git-worktree-"));
  const worktreeRoot = join(container, "feature-checkout");

  try {
    git(root, "worktree", "add", "-b", "feature-branch", "--quiet", worktreeRoot);
    const context = readGitWorkContext(worktreeRoot);
    expect(context.branch).toBe("feature-branch");
    expect(context.worktreeLabel).toBe(basename(worktreeRoot));
    expect(context.localPath).toBe(realpathSync(worktreeRoot));
    expect(context).not.toHaveProperty("commit");
    expect(context).not.toHaveProperty("head");
  } finally {
    rmSync(container, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns no git context for a non-git directory", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-git-context-nongit-"));

  try {
    expect(readGitWorkContext(root)).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable last-worked-on omits the local path", () => {
  expect(
    lastWorkedOnFromContext({
      branch: "main",
      worktreeLabel: "feature-checkout",
      localPath: "/Users/me/.worktrees/feature-checkout",
    }),
  ).toEqual({
    branch: "main",
    worktree: "feature-checkout",
  });
  expect(lastWorkedOnFromContext({})).toBeUndefined();
});

test("picks the latest session that captured git context", () => {
  expect(
    lastWorkedOnFromSessions([
      {},
      { branch: "feature-branch", worktreeLabel: "feature-checkout" },
      { branch: "main" },
    ]),
  ).toEqual({
    branch: "feature-branch",
    worktree: "feature-checkout",
  });
});
