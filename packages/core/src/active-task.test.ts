import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "./index.ts";

function withStore<T>(run: (store: ReturnType<typeof openTraceStore>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "trace-active-task-"));
  const store = openTraceStore(join(dir, "trace.sqlite"));
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function registerSession(
  store: ReturnType<typeof openTraceStore>,
  id: string,
): void {
  store.registerSession({
    id,
    transcriptPath: `/transcripts/${id}.jsonl`,
    tool: "claude",
  });
}

test("a session bound to a task resolves to that task", () => {
  withStore((store) => {
    const task = store.createTask("Checkout flow", "/repo-a");
    registerSession(store, "session-1");
    store.assignSession("session-1", task.id);

    expect(store.resolveActiveTask("session-1", "/repo-a")).toEqual({
      kind: "bound",
      task,
    });
  });
});

test("an unbound session offers the project's most recent task for re-entry", () => {
  withStore((store) => {
    store.createTask("Older work", "/repo-a");
    const newer = store.createTask("Newer work", "/repo-a");
    registerSession(store, "session-1");

    expect(store.resolveActiveTask("session-1", "/repo-a")).toEqual({
      kind: "re-enter",
      task: newer,
    });
  });
});

test("an unbound session in a fresh project resolves to none", () => {
  withStore((store) => {
    store.createTask("Elsewhere", "/repo-b");
    registerSession(store, "session-1");

    expect(store.resolveActiveTask("session-1", "/repo-a")).toEqual({
      kind: "none",
    });
  });
});

test("re-entry skips an archived most-recent task for the next unarchived one", () => {
  withStore((store) => {
    const kept = store.createTask("Kept work", "/repo-a");
    const archived = store.createTask("Shelved work", "/repo-a");
    store.archiveTask(archived.id);
    registerSession(store, "session-1");

    expect(store.resolveActiveTask("session-1", "/repo-a")).toEqual({
      kind: "re-enter",
      task: kept,
    });
  });
});

test("a session bound to an archived task falls back to re-entry, not the dead binding", () => {
  withStore((store) => {
    const other = store.createTask("Live work", "/repo-a");
    const stale = store.createTask("Shelved work", "/repo-a");
    registerSession(store, "session-1");
    store.assignSession("session-1", stale.id);
    store.archiveTask(stale.id);

    expect(store.resolveActiveTask("session-1", "/repo-a")).toEqual({
      kind: "re-enter",
      task: other,
    });
  });
});

test("a session bound to an archived task with no live task resolves to none", () => {
  withStore((store) => {
    const stale = store.createTask("Shelved work", "/repo-a");
    registerSession(store, "session-1");
    store.assignSession("session-1", stale.id);
    store.archiveTask(stale.id);

    expect(store.resolveActiveTask("session-1", "/repo-a")).toEqual({
      kind: "none",
    });
  });
});
