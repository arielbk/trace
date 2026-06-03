import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "@trace/core";
import {
  getDatabasePath,
  getTaskTimeline,
  listTaskSummaries,
  listTasks,
} from "../server/data.ts";

test("web data adapter lists tasks and returns the same task timeline as core", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-"));
  const databasePath = join(dir, "trace.sqlite");
  const originalTraceDb = process.env.TRACE_DB;
  process.env.TRACE_DB = databasePath;

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const session = store.registerSession({
      id: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      tool: "codex",
      model: "gpt-5-codex",
      tokenTotals: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
    });
    store.assignSession(session.id, task.id);
    store.addTaskDoc(task.id, "/tmp/spec.md");
    const coreTimeline = store.getTaskTimeline(task.id);
    store.close();

    expect(listTasks()).toEqual([task]);
    expect(getTaskTimeline(task.id)).toEqual(coreTimeline);
    const timelineLabels = getTaskTimeline(task.id)?.items.map((item) =>
      item.type === "session" ? item.session.id : item.doc.path,
    );
    const timelineSessions = getTaskTimeline(task.id)?.items.filter(
      (item) => item.type === "session",
    );
    expect(timelineLabels).toContain("session-1");
    expect(timelineLabels).toContain("/tmp/spec.md");
    expect(timelineSessions?.[0]?.session.model).toBe("gpt-5-codex");
    expect(getTaskTimeline(task.id)?.tokenTotals.totalTokens).toBe(20);
  } finally {
    if (originalTraceDb === undefined) {
      delete process.env.TRACE_DB;
    } else {
      process.env.TRACE_DB = originalTraceDb;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web data adapter exposes task summaries with last activity and token totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-"));
  const databasePath = join(dir, "trace.sqlite");
  const originalTraceDb = process.env.TRACE_DB;
  process.env.TRACE_DB = databasePath;

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const session = store.registerSession({
      id: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      tool: "codex",
      tokenTotals: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
    });
    store.assignSession(session.id, task.id);
    const doc = store.addTaskDoc(task.id, "/tmp/spec.md");
    store.close();

    const summaries = listTaskSummaries();
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.id).toBe(task.id);
    expect(summary.title).toBe(task.title);
    expect(summary.projectRoot).toBe(task.projectRoot);
    expect(summary.createdAt).toBe(task.createdAt);
    expect(summary.tokenTotals.totalTokens).toBe(20);
    // last activity is the max of session/doc createdAt — never before the task.
    expect(summary.lastActivityAt >= task.createdAt).toBe(true);
    expect(summary.lastActivityAt).toBe(
      [session.createdAt, doc.createdAt].sort().at(-1),
    );
  } finally {
    if (originalTraceDb === undefined) {
      delete process.env.TRACE_DB;
    } else {
      process.env.TRACE_DB = originalTraceDb;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web data adapter uses ~/.trace/trace.sqlite when TRACE_DB is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-home-"));
  const originalTraceDb = process.env.TRACE_DB;
  const originalHome = process.env.HOME;
  delete process.env.TRACE_DB;
  process.env.HOME = dir;

  try {
    expect(getDatabasePath()).toBe(join(dir, ".trace", "trace.sqlite"));
    expect(listTasks()).toEqual([]);
  } finally {
    if (originalTraceDb === undefined) {
      delete process.env.TRACE_DB;
    } else {
      process.env.TRACE_DB = originalTraceDb;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
