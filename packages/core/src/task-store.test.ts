import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { openTraceStore } from "./index.ts";

test("task entity persists and reads back through the store interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const created = store.createTask("checkout");
    store.close();

    const reopened = openTraceStore(databasePath);
    assert.deepEqual(reopened.getTask(created.id), created);
    assert.deepEqual(reopened.listTasks(), [created]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session register and assign lifecycle keeps one task per session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const firstTask = store.createTask("checkout");
    const secondTask = store.createTask("review");
    const session = store.registerSession({
      id: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      tool: "codex",
    });

    assert.equal(session.taskId, null);
    assert.deepEqual(store.listUnassignedSessions(), [session]);

    const assigned = store.assignSession(session.id, firstTask.id);
    assert.equal(assigned.taskId, firstTask.id);
    assert.deepEqual(store.listUnassignedSessions(), []);
    assert.deepEqual(store.listSessionsForTask(firstTask.id), [assigned]);

    const moved = store.assignSession(session.id, secondTask.id);
    assert.equal(moved.taskId, secondTask.id);
    assert.deepEqual(store.listSessionsForTask(firstTask.id), []);
    assert.deepEqual(store.listSessionsForTask(secondTask.id), [moved]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task doc associations can be added, read, and removed through the store interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-core-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");

    const doc = store.addTaskDoc(task.id, "/tmp/spec.md");

    assert.equal(doc.taskId, task.id);
    assert.equal(doc.path, "/tmp/spec.md");
    assert.deepEqual(store.listDocsForTask(task.id), [doc]);

    store.removeTaskDoc(task.id, "/tmp/spec.md");
    assert.deepEqual(store.listDocsForTask(task.id), []);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
