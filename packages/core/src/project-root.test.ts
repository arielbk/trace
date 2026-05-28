import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveProjectRoot } from "./index.ts";

test("resolves a nested cwd to the nearest ancestor with a .git entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const repoRoot = join(dir, "repo");
    const nestedCwd = join(repoRoot, "packages", "core");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));

    expect(resolveProjectRoot(nestedCwd)).toBe(repoRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns cwd when cwd is the repo root", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    mkdirSync(join(dir, ".git"));

    expect(resolveProjectRoot(dir)).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns cwd when no ancestor contains a .git entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const cwd = join(dir, "outside", "nested");
    mkdirSync(cwd, { recursive: true });

    expect(resolveProjectRoot(cwd)).toBe(cwd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("treats a .git file as a repository marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const repoRoot = join(dir, "worktree");
    const nestedCwd = join(repoRoot, "src");
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(
      join(repoRoot, ".git"),
      "gitdir: ../.git/worktrees/worktree\n",
    );

    expect(resolveProjectRoot(nestedCwd)).toBe(repoRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
