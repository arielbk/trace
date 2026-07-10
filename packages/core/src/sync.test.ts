import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { openTraceStore } from "./store.ts";
import {
  compareSyncRows,
  synchronize,
  type SyncBlob,
  type SyncDocManifest,
  type SyncDocumentStore,
  type SyncPayload,
  type SyncTransport,
} from "./sync.ts";

class MemoryTransport implements SyncTransport {
  payload: SyncPayload = { tasks: [], sessions: [] };
  manifests: SyncDocManifest[] = [];
  blobs = new Map<string, Uint8Array>();
  blobUploadSizes: number[] = [];

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

  async pushDocuments(manifests: SyncDocManifest[], blobs: SyncBlob[]) {
    this.blobUploadSizes.push(blobs.length);
    let accepted = 0;
    for (const manifest of manifests) {
      const index = this.manifests.findIndex((item) => item.taskId === manifest.taskId);
      if (index < 0) {
        this.manifests.push(structuredClone(manifest));
        accepted += 1;
      } else if (compareSyncRows(manifest, this.manifests[index]!) > 0) {
        this.manifests[index] = structuredClone(manifest);
        accepted += 1;
      }
    }
    let uploaded = 0;
    for (const blob of blobs) {
      if (!this.blobs.has(blob.hash)) uploaded += 1;
      this.blobs.set(blob.hash, blob.content.slice());
    }
    return { accepted, uploaded };
  }

  async pullDocumentManifests() {
    return structuredClone(this.manifests);
  }

  async missingBlobs(hashes: string[]) {
    return hashes.filter((hash) => !this.blobs.has(hash));
  }

  async downloadBlob(hash: string) {
    return this.blobs.get(hash)?.slice() ?? null;
  }
}

class MemoryDocumentStore implements SyncDocumentStore {
  constructor(
    private manifest: SyncDocManifest,
    private readonly blobs: Map<string, Uint8Array>,
  ) {}

  async snapshot() {
    return { manifests: [structuredClone(this.manifest)], blobs: [...this.blobs].map(([hash, content]) => ({ hash, content })) };
  }

  async apply(manifests: SyncDocManifest[], download: (hash: string) => Promise<Uint8Array | null>) {
    const remote = manifests.find((item) => item.taskId === this.manifest.taskId);
    if (!remote || compareSyncRows(remote, this.manifest) <= 0) return { pulled: 0, downloaded: 0 };
    let downloaded = 0;
    this.blobs.clear();
    for (const file of remote.files) {
      const content = await download(file.blobHash);
      if (!content) throw new Error(`missing blob ${file.blobHash}`);
      this.blobs.set(file.blobHash, content);
      downloaded += 1;
    }
    this.manifest = structuredClone(remote);
    return { pulled: 1, downloaded };
  }

  paths() {
    return this.manifest.files.map((file) => file.path);
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

describe("document synchronization", () => {
  test("content-addressed documents converge, removals replace the task manifest, and re-sync is a no-op", async () => {
    const server = new MemoryTransport();
    const first = new MemoryDocumentStore(
      {
        taskId: "task-a",
        files: [
          { path: "state.md", blobHash: "state-v1" },
          { path: "notes.md", blobHash: "notes-v1" },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
        machineId: "machine-a",
      },
      new Map([
        ["state-v1", new TextEncoder().encode("state")],
        ["notes-v1", new TextEncoder().encode("notes")],
      ]),
    );
    const second = new MemoryDocumentStore(
      {
        taskId: "task-a",
        files: [],
        updatedAt: "2025-01-01T00:00:00.000Z",
        machineId: "machine-b",
      },
      new Map(),
    );

    expect(await synchronize({ syncSnapshot: () => ({ tasks: [], sessions: [] }), mergeSyncPayload: () => ({ pulled: 0 }) }, server, first))
      .toMatchObject({ uploadedBlobs: 2, pushedManifests: 1 });
    expect(await synchronize({ syncSnapshot: () => ({ tasks: [], sessions: [] }), mergeSyncPayload: () => ({ pulled: 0 }) }, server, second))
      .toMatchObject({ downloadedBlobs: 2, pulledManifests: 1 });
    expect(second.paths()).toEqual(["state.md", "notes.md"]);

    const removal = new MemoryDocumentStore(
      {
        taskId: "task-a",
        files: [{ path: "state.md", blobHash: "state-v1" }],
        updatedAt: "2026-01-02T00:00:00.000Z",
        machineId: "machine-b",
      },
      new Map([["state-v1", new TextEncoder().encode("state")]]),
    );
    await synchronize({ syncSnapshot: () => ({ tasks: [], sessions: [] }), mergeSyncPayload: () => ({ pulled: 0 }) }, server, removal);
    await synchronize({ syncSnapshot: () => ({ tasks: [], sessions: [] }), mergeSyncPayload: () => ({ pulled: 0 }) }, server, first);
    expect(first.paths()).toEqual(["state.md"]);
    expect(await synchronize({ syncSnapshot: () => ({ tasks: [], sessions: [] }), mergeSyncPayload: () => ({ pulled: 0 }) }, server, first))
      .toMatchObject({ uploadedBlobs: 0, pushedManifests: 0, downloadedBlobs: 0, pulledManifests: 0 });
    expect(server.blobUploadSizes.at(-1)).toBe(0);
  });
});
