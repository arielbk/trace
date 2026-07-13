import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readProjectFingerprints } from "./index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "trace-project-fingerprint-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "trace@example.com");
  git(root, "config", "user.name", "Trace Tests");
  writeFileSync(join(root, "README.md"), "trace\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

test("canonicalizes SSH and HTTPS forms of the same origin remote", () => {
  const root = createRepository();

  try {
    git(
      root,
      "remote",
      "add",
      "origin",
      "https://token:secret@GitHub.com:443/acme/trace.git",
    );
    const httpsFingerprint = readProjectFingerprints(root);

    git(
      root,
      "remote",
      "set-url",
      "origin",
      "ssh://git@github.com:22/acme/trace.git",
    );
    const sshUrlFingerprint = readProjectFingerprints(root);

    git(root, "remote", "set-url", "origin", "git@github.com:acme/trace.git");
    const scpFingerprint = readProjectFingerprints(root);

    expect(httpsFingerprint.remoteUrl).toBe("github.com/acme/trace");
    expect(sshUrlFingerprint.remoteUrl).toBe(httpsFingerprint.remoteUrl);
    expect(scpFingerprint.remoteUrl).toBe(httpsFingerprint.remoteUrl);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the root commit fingerprint when the origin remote is renamed", () => {
  const root = createRepository();

  try {
    const expectedRootCommit = git(root, "rev-parse", "HEAD");
    git(root, "remote", "add", "origin", "https://github.com/acme/trace.git");
    const beforeRename = readProjectFingerprints(root);

    git(
      root,
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/renamed-trace.git",
    );
    const afterRename = readProjectFingerprints(root);

    expect(beforeRename.remoteUrl).not.toBe(afterRename.remoteUrl);
    expect(beforeRename.rootCommit).toBe(expectedRootCommit);
    expect(afterRename.rootCommit).toBe(expectedRootCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the remote fingerprint but omits the root commit for a shallow clone", () => {
  const source = createRepository();
  const container = mkdtempSync(join(tmpdir(), "trace-project-shallow-"));
  const shallowRoot = join(container, "clone");

  try {
    git(
      source,
      "clone",
      "--quiet",
      "--depth=1",
      `file://${source}`,
      shallowRoot,
    );
    git(
      shallowRoot,
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/trace.git",
    );

    expect(readProjectFingerprints(shallowRoot)).toEqual({
      remoteUrl: "github.com/acme/trace",
    });
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(container, { recursive: true, force: true });
  }
});

test("reads the root commit from a repository with no origin remote", () => {
  const root = createRepository();

  try {
    expect(readProjectFingerprints(root)).toEqual({
      rootCommit: git(root, "rev-parse", "HEAD"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns no fingerprints for a non-git directory", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-project-non-git-"));

  try {
    expect(readProjectFingerprints(root)).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns no fingerprints when git is unavailable", () => {
  const root = createRepository();
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = "";
    expect(readProjectFingerprints(root)).toEqual({});
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("chooses the sorted-first root commit for a history with multiple roots", () => {
  const root = createRepository();

  try {
    const firstRoot = git(root, "rev-parse", "HEAD");
    const tree = git(root, "rev-parse", "HEAD^{tree}");
    const secondRoot = git(root, "commit-tree", tree, "-m", "second root");
    const merge = git(
      root,
      "commit-tree",
      tree,
      "-p",
      firstRoot,
      "-p",
      secondRoot,
      "-m",
      "merge histories",
    );
    git(root, "update-ref", "HEAD", merge);

    expect(readProjectFingerprints(root).rootCommit).toBe(
      [firstRoot, secondRoot].sort()[0],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
