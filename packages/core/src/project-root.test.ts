import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveProjectRoot, resolveProjectRootArg } from "./index.ts";

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

test("resolveProjectRootArg without an override resolves the cwd's repo root", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const repoRoot = join(dir, "repo");
    const nestedCwd = join(repoRoot, "packages", "core");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));

    expect(resolveProjectRootArg(undefined, nestedCwd)).toBe(repoRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectRootArg resolves a relative override against cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const repoRoot = join(dir, "other");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });

    expect(resolveProjectRootArg("other", dir)).toBe(repoRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectRootArg keys an override to that directory's repo root", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const cwdRepo = join(dir, "cwd-repo");
    const otherRepo = join(dir, "other-repo");
    const otherNested = join(otherRepo, "src");
    mkdirSync(join(cwdRepo, ".git"), { recursive: true });
    mkdirSync(otherNested, { recursive: true });
    mkdirSync(join(otherRepo, ".git"));

    expect(resolveProjectRootArg(otherNested, cwdRepo)).toBe(otherRepo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectRootArg returns an existing git-less override directory itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const target = join(dir, "loose");
    mkdirSync(target, { recursive: true });

    expect(resolveProjectRootArg(target, dir)).toBe(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectRootArg throws naming the path when the override is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-project-root-"));

  try {
    const missing = join(dir, "nope");

    expect(() => resolveProjectRootArg(missing, dir)).toThrow(missing);
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
