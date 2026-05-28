import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "@trace/core";
import { getTaskTimeline, listTasks } from "../server/data.ts";

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
    expect(timelineLabels).toContain("session-1");
    expect(timelineLabels).toContain("/tmp/spec.md");
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
