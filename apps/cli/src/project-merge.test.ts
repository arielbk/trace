import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTraceStore } from "@trace/core";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

test("trace project merge prints what moved and persists the merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-project-merge-"));
  const databasePath = join(dir, "trace.sqlite");
  const canonicalRoot = join(dir, "one", "checkout");
  const duplicateRoot = join(dir, "two", "checkout");
  const env = { ...process.env, TRACE_DB: databasePath };
  mkdirSync(canonicalRoot, { recursive: true });
  mkdirSync(duplicateRoot, { recursive: true });

  try {
    const setup = openTraceStore(databasePath);
    setup.createTask("Canonical task", canonicalRoot);
    const duplicateTask = setup.createTask("Duplicate task", duplicateRoot);
    const canonical = setup.getProjectByRoot(canonicalRoot)!;
    const duplicate = setup.getProjectByRoot(duplicateRoot)!;
    setup.close();

    const output = execFileSync(
      process.execPath,
      [traceBin, "project", "merge", duplicate.slug, canonical.slug],
      { encoding: "utf8", env },
    );

    expect(output).toBe(
      `merged project ${duplicate.slug} into ${canonical.slug}\n` +
        "moved 1 task and 1 root\n" +
        "added fingerprints: none\n",
    );

    const store = openTraceStore(databasePath);
    expect(store.getProjectBySlug(duplicate.slug)).toBeNull();
    expect(store.getTask(duplicateTask.id)?.projectId).toBe(canonical.id);
    expect(store.getProjectByRoot(duplicateRoot)?.id).toBe(canonical.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace project merge exits non-zero for an unknown slug and prints near candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-project-merge-missing-"));
  const databasePath = join(dir, "trace.sqlite");
  const canonicalRoot = join(dir, "one", "checkout");
  const duplicateRoot = join(dir, "two", "checkout");
  const env = { ...process.env, TRACE_DB: databasePath };
  mkdirSync(canonicalRoot, { recursive: true });
  mkdirSync(duplicateRoot, { recursive: true });

  try {
    const setup = openTraceStore(databasePath);
    const canonical = setup.resolveProject(canonicalRoot).project;
    const duplicate = setup.resolveProject(duplicateRoot).project;
    setup.close();

    const result = spawnSync(
      process.execPath,
      [traceBin, "project", "merge", "check", canonical.slug],
      { encoding: "utf8", env },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Project not found: check");
    expect(result.stderr).toContain("Near candidates:");
    expect(result.stderr).toContain(`  ${canonical.slug}`);
    expect(result.stderr).toContain(`  ${duplicate.slug}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace project merge exits non-zero for a self-merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-project-merge-self-"));
  const databasePath = join(dir, "trace.sqlite");
  const root = join(dir, "checkout");
  const env = { ...process.env, TRACE_DB: databasePath };
  mkdirSync(root);

  try {
    const setup = openTraceStore(databasePath);
    const project = setup.resolveProject(root).project;
    setup.close();

    const result = spawnSync(
      process.execPath,
      [traceBin, "project", "merge", project.slug, project.slug],
      { encoding: "utf8", env },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `Cannot merge project ${project.slug} into itself`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
