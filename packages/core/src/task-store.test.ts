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
