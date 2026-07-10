import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { openTraceStore } from "./store.ts";
import {
  compareSyncRows,
  synchronize,
  type SyncPayload,
  type SyncTransport,
} from "./sync.ts";

class MemoryTransport implements SyncTransport {
  payload: SyncPayload = { tasks: [], sessions: [] };

  async push(payload: SyncPayload) {
    let accepted = 0;
    for (const kind of ["tasks", "sessions"] as const) {
      for (const row of payload[kind]) {
        const index = this.payload[kind].findIndex((item) => item.id === row.id);
        if (index < 0) {
          (this.payload[kind] as typeof row[]).push(row);
          accepted += 1;
        } else if (compareSyncRows(row, this.payload[kind][index]!) > 0) {
          (this.payload[kind] as typeof row[])[index] = row;
          accepted += 1;
        }
      }
    }
    return { accepted };
  }

  async pull() {
    return structuredClone(this.payload);
  }
}

function database(name: string) {
  return join(mkdtempSync(join(tmpdir(), "trace-sync-")), `${name}.db`);
}

describe("row synchronization", () => {
  test("two local stores converge and a second sync is a no-op", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("first"));
    const second = openTraceStore(database("second"));
    const task = first.createTask("Cloud task", "/project", "from machine A");
    first.registerSession({
      id: "session-a",
      transcriptPath: "/machine-a/transcript.jsonl",
      tool: "codex",
    });
    first.assignSession("session-a", task.id);

    expect(await synchronize(first, server)).toEqual({ pushed: 2, pulled: 0 });
    expect(await synchronize(second, server)).toEqual({ pushed: 0, pulled: 2 });
    expect(second.listTasks()).toEqual(first.listTasks());
    expect(second.getSession("session-a")).toMatchObject({ taskId: task.id });
    expect(await synchronize(second, server)).toEqual({ pushed: 0, pulled: 0 });

    first.close();
    second.close();
  });

  test("last write wins, including archive versus edit conflicts", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("first"));
    const second = openTraceStore(database("second"));
    const task = first.createTask("Conflict");
    await synchronize(first, server);
    await synchronize(second, server);

    first.archiveTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    second.updateTaskDescription(task.id, "remote edit");
    await synchronize(second, server);
    await synchronize(first, server);

    expect(first.getTask(task.id)).toMatchObject({
      description: "remote edit",
      archivedAt: null,
    });
    first.close();
    second.close();
  });
});
