import { expect, test } from "vitest";
import { mergeTaskDocs } from "./task-docs.ts";
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
