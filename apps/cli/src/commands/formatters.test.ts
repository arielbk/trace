import { expect, test } from "vitest";
import type { ReEntryManifest, Session, Task, TaskDoc } from "@trace/core";
import {
  formatReEntryManifest,
  formatSessionSummary,
  formatTask,
  taskNotFoundMessage,
} from "./formatters.ts";

const task: Task = {
  id: "task-1",
  title: "Ship formatters",
  slug: "ship-formatters",
  description: "Move formatting behind a seam",
  createdAt: "2026-06-18T17:00:00.000Z",
  projectRoot: "/repo",
  projectId: "project-1",
  archivedAt: null,
  pinnedAt: null,
};

const session: Session = {
  id: "session-1",
  transcriptPath: "/tmp/session.jsonl",
  tool: "codex",
  model: "gpt-5-codex",
  title: null,
  taskId: "task-1",
  parentSessionId: null,
  origin: "root",
  subagentType: null,
  agentId: null,
  createdAt: "2026-06-18T17:01:00.000Z",
  tokenTotals: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  },
};

const doc: TaskDoc = {
  taskId: "task-1",
  path: "/tmp/spec.md",
  createdAt: "2026-06-18T17:02:00.000Z",
};

test("formatTask renders task details with sessions and docs", () => {
  expect(formatTask(task, [session], [doc])).toBe(
    [
      "slug: ship-formatters",
      "id: task-1",
      "title: Ship formatters",
      "description: Move formatting behind a seam",
      "createdAt: 2026-06-18T17:00:00.000Z",
      "projectRoot: /repo",
      "sessions:",
      "- session-1\tcodex\t/tmp/session.jsonl",
      "docs:",
      "- /tmp/spec.md",
      "",
    ].join("\n"),
  );
});

test("formatTask omits optional sections when sessions and docs are absent", () => {
  expect(formatTask({ ...task, description: undefined })).toBe(
    [
      "slug: ship-formatters",
      "id: task-1",
      "title: Ship formatters",
      "createdAt: 2026-06-18T17:00:00.000Z",
      "projectRoot: /repo",
      "",
    ].join("\n"),
  );
});

test("formatSessionSummary renders the resolved transcript path", () => {
  expect(formatSessionSummary(session)).toBe("session-1\tcodex\t/tmp/session.jsonl\n");
  expect(formatSessionSummary({ ...session, model: null })).toBe(
    "session-1\tcodex\t/tmp/session.jsonl\n",
  );
});

test("formatReEntryManifest renders empty docs and sessions", () => {
  const manifest: ReEntryManifest = {
    task: {
      id: "task-1",
      title: "Ship formatters",
      description: "Move formatting behind a seam",
      projectRoot: "/repo",
    },
    taskDocsDir: "/trace/tasks/ship-formatters/docs",
    docs: [],
    sessions: [],
  };

  expect(formatReEntryManifest(manifest)).toBe(
    [
      "task:",
      "  id: task-1",
      "  title: Ship formatters",
      "  description: Move formatting behind a seam",
      "  projectRoot: /repo",
      "taskDocsDir: /trace/tasks/ship-formatters/docs",
      "docs: []",
      "sessions: []",
      "",
    ].join("\n"),
  );
});

test("formatReEntryManifest renders docs, state, and sessions", () => {
  const manifest: ReEntryManifest = {
    task: {
      id: "task-1",
      title: "Ship formatters",
      projectRoot: "/repo",
    },
    taskDocsDir: "/trace/tasks/ship-formatters/docs",
    state: { ...doc, path: "/trace/tasks/ship-formatters/docs/state.md" },
    docs: [doc],
    sessions: [
      {
        id: "session-1",
        transcriptPath: "/tmp/session.jsonl",
        tool: "codex",
        model: "gpt-5-codex",
        createdAt: "2026-06-18T17:01:00.000Z",
        isMostRecent: true,
      },
    ],
  };

  expect(formatReEntryManifest(manifest)).toBe(
    [
      "task:",
      "  id: task-1",
      "  title: Ship formatters",
      "  projectRoot: /repo",
      "state:",
      "  path: /trace/tasks/ship-formatters/docs/state.md",
      "taskDocsDir: /trace/tasks/ship-formatters/docs",
      "docs:",
      "- path: /tmp/spec.md",
      "sessions:",
      "- id: session-1",
      "  tool: codex",
      "  transcript: /tmp/session.jsonl",
      "  mostRecent: true",
      "  model: gpt-5-codex",
      "",
    ].join("\n"),
  );
});

test("taskNotFoundMessage includes near candidates when they match the ref", () => {
  expect(taskNotFoundMessage([task], "format")).toBe(
    [
      "Task not found: format",
      "Near candidates:",
      "  ship-formatters \u2014 Ship formatters",
    ].join("\n"),
  );
});

test("taskNotFoundMessage omits near candidates when none match", () => {
  expect(taskNotFoundMessage([task], "missing")).toBe("Task not found: missing");
});
