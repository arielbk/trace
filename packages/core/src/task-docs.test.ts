import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { listNativeTaskDocs, mergeTaskDocs } from "./task-docs.ts";
import type { TaskDoc } from "./types.ts";

const doc = (path: string, createdAt: string): TaskDoc => ({
  taskId: "task-1",
  path,
  createdAt,
});

test("mergeTaskDocs unions registered and native docs", () => {
  const registered = [doc("/a.md", "2026-01-01T00:00:00.000Z")];
  const native = [doc("/b.md", "2026-01-02T00:00:00.000Z")];

  expect(mergeTaskDocs(registered, native)).toEqual([
    doc("/a.md", "2026-01-01T00:00:00.000Z"),
    doc("/b.md", "2026-01-02T00:00:00.000Z"),
  ]);
});

test("mergeTaskDocs orders merged docs by createdAt then path", () => {
  const registered = [doc("/late.md", "2026-03-03T00:00:00.000Z")];
  const native = [
    doc("/early.md", "2026-01-01T00:00:00.000Z"),
    doc("/zeta.md", "2026-02-02T00:00:00.000Z"),
    doc("/alpha.md", "2026-02-02T00:00:00.000Z"),
  ];

  expect(mergeTaskDocs(registered, native).map((d) => d.path)).toEqual([
    "/early.md",
    "/alpha.md",
    "/zeta.md",
    "/late.md",
  ]);
});

test("mergeTaskDocs dedups by path, keeping the registered doc", () => {
  const registered = [doc("/shared.md", "2026-01-01T00:00:00.000Z")];
  const native = [doc("/shared.md", "2026-06-06T00:00:00.000Z")];

  expect(mergeTaskDocs(registered, native)).toEqual([
    doc("/shared.md", "2026-01-01T00:00:00.000Z"),
  ]);
});

test("mergeTaskDocs folds a relative registered path into its native doc", () => {
  const registered = [
    {
      ...doc("spec.md", "2026-01-01T00:00:00.000Z"),
      description: "The spec",
    },
  ];
  const native = [doc("/db/tasks/my-task/docs/spec.md", "2026-06-06T00:00:00.000Z")];

  expect(mergeTaskDocs(registered, native, "/db/tasks/my-task/docs")).toEqual([
    {
      ...doc("/db/tasks/my-task/docs/spec.md", "2026-01-01T00:00:00.000Z"),
      description: "The spec",
    },
  ]);
});

test("mergeTaskDocs leaves a relative registered path that has no native counterpart", () => {
  const registered = [doc("notes/plan.md", "2026-01-01T00:00:00.000Z")];
  const native = [doc("/db/tasks/my-task/docs/spec.md", "2026-06-06T00:00:00.000Z")];

  expect(
    mergeTaskDocs(registered, native, "/db/tasks/my-task/docs").map((d) => d.path),
  ).toEqual(["notes/plan.md", "/db/tasks/my-task/docs/spec.md"]);
});

test("mergeTaskDocs without a docs dir keeps relative registered paths as-is", () => {
  const registered = [doc("spec.md", "2026-01-01T00:00:00.000Z")];
  const native = [doc("/db/tasks/my-task/docs/spec.md", "2026-06-06T00:00:00.000Z")];

  expect(mergeTaskDocs(registered, native)).toHaveLength(2);
});

// Helper: create a temp db dir and place a file in tasks/<ref>/docs/
function makeDocsFixture(ref: string, filename: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
  const dbPath = join(dir, "trace.db");
  const docsDir = join(dir, "tasks", ref, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, filename), "content");
  return dbPath;
}

test("listNativeTaskDocs resolves docs from the slug directory", () => {
  const slug = "my-task-slug";
  const taskId = "00000000-0000-0000-0000-000000000001";
  const dbPath = makeDocsFixture(slug, "plan.md");

  const docs = listNativeTaskDocs(dbPath, taskId, slug);

  expect(docs).toHaveLength(1);
  expect(docs[0]?.taskId).toBe(taskId);
  expect(docs[0]?.path).toContain("plan.md");
});

test("listNativeTaskDocs returns empty array when slug directory does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
  const dbPath = join(dir, "trace.db");

  const docs = listNativeTaskDocs(dbPath, "some-id", "nonexistent-slug");

  expect(docs).toEqual([]);
});

test("listNativeTaskDocs does not fall back to UUID directory", () => {
  const taskId = "00000000-0000-0000-0000-000000000002";
  const slug = "my-new-slug";
  // File exists only in the UUID directory, not the slug directory
  const dbPath = makeDocsFixture(taskId, "legacy.md");

  const docs = listNativeTaskDocs(dbPath, taskId, slug);

  expect(docs).toEqual([]);
});
