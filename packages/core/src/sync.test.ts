import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { openTraceStore } from "./store.ts";
import { readProjectFingerprints } from "./project-fingerprint.ts";
import type { Task } from "./types.ts";
import {
  compareSyncRows,
  synchronize,
  type SyncBlob,
  type SyncDocManifest,
  type SyncCursorScope,
  type SyncDocumentStore,
  type SyncPayload,
  type SyncStore,
  type SyncTransport,
  type SyncWrappedKey,
} from "./sync.ts";

class MemoryTransport implements SyncTransport {
  payload: SyncPayload = { tasks: [], sessions: [] };
  manifests: SyncDocManifest[] = [];
  wrappedKeys = new Map<string, string>();
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

  async pushDocuments(
    manifests: SyncDocManifest[],
    blobs: SyncBlob[],
    wrappedKeys: SyncWrappedKey[],
  ) {
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
    for (const { taskId, wrappedKey } of wrappedKeys) {
      this.wrappedKeys.set(taskId, wrappedKey);
    }
    let uploaded = 0;
    for (const blob of blobs) {
      if (!this.blobs.has(blob.hash)) uploaded += 1;
      this.blobs.set(blob.hash, blob.content.slice());
    }
    return { accepted, uploaded };
  }

  async pullDocumentManifests() {
    return {
      manifests: structuredClone(this.manifests),
      wrappedKeys: [...this.wrappedKeys].map(([taskId, wrappedKey]) => ({
        taskId,
        wrappedKey,
      })),
    };
  }

  async missingBlobs(hashes: string[]) {
    return hashes.filter((hash) => !this.blobs.has(hash));
  }

  async downloadBlob(hash: string) {
    return this.blobs.get(hash)?.slice() ?? null;
  }
}

/**
 * A transport that records the watermark each pull was given and answers with
 * whatever cursor the test sets — the server owns that value, so the tests
 * hand it back rather than deriving it from the rows.
 */
class CursorTransport implements SyncTransport {
  pulledSince: (string | undefined)[] = [];
  pulledDocumentsSince: (string | undefined)[] = [];
  cursor: string | undefined;
  documentsCursor: string | undefined;

  async push() {
    return { accepted: 0 };
  }

  async pull(since?: string): Promise<SyncPayload> {
    this.pulledSince.push(since);
    return { tasks: [], sessions: [], cursor: this.cursor };
  }

  async pushDocuments() {
    return { accepted: 0, uploaded: 0 };
  }

  async pullDocumentManifests(since?: string) {
    this.pulledDocumentsSince.push(since);
    return { manifests: [], wrappedKeys: [], cursor: this.documentsCursor };
  }

  async missingBlobs() {
    return [];
  }

  async downloadBlob() {
    return null;
  }
}

class MemoryDocumentStore implements SyncDocumentStore {
  constructor(
    private manifest: SyncDocManifest,
    private readonly blobs: Map<string, Uint8Array>,
  ) {}

  async snapshot() {
    return {
      manifests: [structuredClone(this.manifest)],
      blobs: [...this.blobs].map(([hash, content]) => ({ hash, content })),
      wrappedKeys: [{ taskId: this.manifest.taskId, wrappedKey: "wrapped" }],
    };
  }

  async apply(
    manifests: SyncDocManifest[],
    _wrappedKeys: SyncWrappedKey[],
    download: (hash: string) => Promise<Uint8Array | null>,
  ) {
    const remote = manifests.find((item) => item.taskId === this.manifest.taskId);
    if (!remote || compareSyncRows(remote, this.manifest) <= 0) return { pulled: 0, downloaded: 0 };
    let downloaded = 0;
    this.blobs.clear();
    for (const file of testFiles(remote)) {
      const content = await download(file.blobHash);
      if (!content) throw new Error(`missing blob ${file.blobHash}`);
      this.blobs.set(file.blobHash, content);
      downloaded += 1;
    }
    this.manifest = structuredClone(remote);
    return { pulled: 1, downloaded };
  }

  paths() {
    return testFiles(this.manifest).map((file) => file.path);
  }
}

function testFiles(
  manifest: SyncDocManifest,
): { path: string; blobHash: string }[] {
  return JSON.parse(manifest.filesCiphertext) as {
    path: string;
    blobHash: string;
  }[];
}

/**
 * A SyncStore with no rows of its own, for the document tests: they exercise
 * manifests and blobs, and only need synchronize() to have something to call.
 * Its watermarks live in memory rather than sqlite.
 */
function rowlessStore(): SyncStore {
  const cursors = new Map<SyncCursorScope, string>();
  return {
    syncSnapshot: () => ({ tasks: [], sessions: [] }),
    mergeSyncPayload: () => ({ pulled: 0 }),
    syncCursor: (scope) => cursors.get(scope) ?? null,
    setSyncCursor: (scope, cursor) => void cursors.set(scope, cursor),
  };
}

function database(name: string) {
  return join(mkdtempSync(join(tmpdir(), "trace-sync-")), `${name}.db`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(root: string, remoteUrl?: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "trace@example.com");
  git(root, "config", "user.name", "Trace Tests");
  writeFileSync(join(root, "README.md"), "trace\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "initial");
  if (remoteUrl) git(root, "remote", "add", "origin", remoteUrl);
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
    // project_id never crosses the wire — each machine resolves the synced
    // project_root to its own local project — so compare everything else and
    // check the pulled task was mapped to some local project.
    const stripProjectId = (task: Task) => ({ ...task, projectId: undefined });
    expect(second.listTasks().map(stripProjectId)).toEqual(
      first.listTasks().map(stripProjectId),
    );
    expect(second.listTasks()[0]?.projectId).toEqual(expect.any(String));
    expect(second.getSession("session-a")).toMatchObject({ taskId: task.id });
    expect(await synchronize(second, server)).toEqual({ pushed: 0, pulled: 0 });

    first.close();
    second.close();
  });

  test("duplicate slugs from independent machines converge under a local suffix", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("first"));
    const second = openTraceStore(database("second"));
    // Both machines mint the same slug before ever syncing.
    const fromFirst = first.createTask("Cloud sync", "/project-a");
    const fromSecond = second.createTask("Cloud sync", "/project-b");

    await synchronize(first, server);
    await synchronize(second, server);
    await synchronize(first, server);

    // Each machine keeps its own task at the original slug and lands the
    // pulled twin under an iterator suffix; nothing throws, nothing is lost.
    expect(second.getTask(fromSecond.id)?.slug).toBe("cloud-sync");
    expect(second.getTask(fromFirst.id)?.slug).toBe("cloud-sync-2");
    expect(first.getTask(fromFirst.id)?.slug).toBe("cloud-sync");
    expect(first.getTask(fromSecond.id)?.slug).toBe("cloud-sync-2");

    // A remote edit still wins last-write-wins without disturbing the
    // machine-local slug.
    await new Promise((resolve) => setTimeout(resolve, 2));
    first.updateTaskDescription(fromFirst.id, "edited on machine A");
    await synchronize(first, server);
    await synchronize(second, server);
    expect(second.getTask(fromFirst.id)).toMatchObject({
      description: "edited on machine A",
      slug: "cloud-sync-2",
    });

    first.close();
    second.close();
  });

  test("a title-only rename propagates", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("first"));
    const second = openTraceStore(database("second"));
    const task = first.createTask("Old title");
    await synchronize(first, server);
    await synchronize(second, server);

    await new Promise((resolve) => setTimeout(resolve, 2));
    first.updateTaskTitle(task.id, "New title");
    expect(await synchronize(first, server)).toEqual({ pushed: 1, pulled: 0 });
    expect(await synchronize(second, server)).toEqual({ pushed: 0, pulled: 1 });
    expect(second.getTask(task.id)).toMatchObject({ title: "New title" });

    first.close();
    second.close();
  });

  test("pinning a task bumps the sync clock and the snapshot carries pinnedAt", async () => {
    const store = openTraceStore(database("pin"));
    const task = store.createTask("Pin me");
    const before = store.syncSnapshot().tasks[0]!;

    await new Promise((resolve) => setTimeout(resolve, 2));
    store.pinTask(task.id);
    const pinned = store.syncSnapshot().tasks[0]!;
    expect(pinned.pinnedAt).toEqual(expect.any(String));
    expect(pinned.updatedAt > before.updatedAt).toBe(true);

    store.unpinTask(task.id);
    const unpinned = store.syncSnapshot().tasks[0]!;
    expect(unpinned.pinnedAt).toBeNull();
    expect(unpinned.updatedAt > pinned.updatedAt).toBe(true);

    store.close();
  });

  test("pins and unpins propagate between machines", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("first"));
    const second = openTraceStore(database("second"));
    const task = first.createTask("Focus");
    await synchronize(first, server);
    await synchronize(second, server);

    await new Promise((resolve) => setTimeout(resolve, 2));
    first.pinTask(task.id);
    expect(await synchronize(first, server)).toEqual({ pushed: 1, pulled: 0 });
    expect(await synchronize(second, server)).toEqual({ pushed: 0, pulled: 1 });
    expect(second.getTask(task.id)?.pinnedAt).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 2));
    second.unpinTask(task.id);
    await synchronize(second, server);
    await synchronize(first, server);
    expect(first.getTask(task.id)?.pinnedAt).toBeNull();

    first.close();
    second.close();
  });

  test("a legacy payload row without pinnedAt merges cleanly as unpinned", async () => {
    const store = openTraceStore(database("legacy"));
    const task = store.createTask("From an old client");
    store.pinTask(task.id);

    // Rows pushed by clients predating pin sync carry no pinnedAt field at
    // all; when such a row wins last-write-wins it lands as unpinned.
    const [row] = store.syncSnapshot().tasks;
    const legacy = {
      ...row!,
      updatedAt: new Date(Date.parse(row!.updatedAt) + 10).toISOString(),
      machineId: "legacy-machine",
    };
    delete legacy.pinnedAt;
    store.mergeSyncPayload({ tasks: [legacy], sessions: [] });

    expect(store.getTask(task.id)?.pinnedAt).toBeNull();
    store.close();
  });

  test("snapshot rows carry the project's fingerprints", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-sync-"));
    const root = join(dir, "checkout");
    createRepository(root, "git@github.com:trace/checkout.git");
    const store = openTraceStore(join(dir, "trace.db"));
    store.createTask("Fingerprinted", root);
    store.createTask("Rootless");

    const fingerprints = readProjectFingerprints(root);
    const rows = store.syncSnapshot().tasks;
    expect(rows.find((row) => row.projectRoot === root)).toMatchObject({
      projectRemoteUrl: fingerprints.remoteUrl,
      projectRootCommit: fingerprints.rootCommit,
    });
    // A project without a git identity rides as nulls, not a crash.
    expect(rows.find((row) => row.projectRoot === "")).toMatchObject({
      projectRemoteUrl: null,
      projectRootCommit: null,
    });
    store.close();
  });

  test("a merged task joins an existing project by fingerprint when its root is foreign", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-sync-"));
    const root = join(dir, "checkout");
    createRepository(root, "git@github.com:trace/checkout.git");
    const store = openTraceStore(join(dir, "trace.db"));
    const local = store.createTask("Local task", root);
    const fingerprints = readProjectFingerprints(root);

    store.mergeSyncPayload({
      tasks: [
        {
          id: "task-from-a",
          title: "From machine A",
          slug: "from-machine-a",
          createdAt: "2026-07-18T00:00:00.000Z",
          projectRoot: "/machine-a/dev/checkout",
          projectRemoteUrl: fingerprints.remoteUrl,
          projectRootCommit: fingerprints.rootCommit,
          archivedAt: null,
          description: null,
          pinnedAt: null,
          updatedAt: "2026-07-18T00:00:00.000Z",
          machineId: "machine-a",
        },
      ],
      sessions: [],
    });

    // No checkout-2 duplicate is minted; both tasks share the one project.
    expect(store.getTask("task-from-a")?.projectId).toBe(
      store.getTask(local.id)?.projectId,
    );
    expect(store.getProjectBySlug("checkout-2")).toBeNull();
    store.close();
  });

  test("an unmatched fingerprint mints a new project carrying that fingerprint", () => {
    const store = openTraceStore(database("unmatched"));

    store.mergeSyncPayload({
      tasks: [
        {
          id: "task-from-a",
          title: "From machine A",
          slug: "from-machine-a",
          createdAt: "2026-07-18T00:00:00.000Z",
          projectRoot: "/machine-a/dev/checkout",
          projectRemoteUrl: "git@github.com:trace/checkout.git",
          projectRootCommit: "0123456789abcdef0123456789abcdef01234567",
          archivedAt: null,
          description: null,
          pinnedAt: null,
          updatedAt: "2026-07-18T00:00:00.000Z",
          machineId: "machine-a",
        },
      ],
      sessions: [],
    });

    const project = store.getProjectBySlug("checkout");
    expect(project).toMatchObject({
      remoteUrl: "git@github.com:trace/checkout.git",
      rootCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(store.getTask("task-from-a")?.projectId).toBe(project?.id);
    // The next pull with the same fingerprint reuses this project.
    expect(
      store.getProjectByFingerprint({
        remoteUrl: "git@github.com:trace/checkout.git",
      })?.id,
    ).toBe(project?.id);
    store.close();
  });

  test("a merged task without fingerprints keeps path-based project resolution", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-sync-"));
    const root = join(dir, "checkout");
    createRepository(root, "git@github.com:trace/checkout.git");
    const store = openTraceStore(join(dir, "trace.db"));
    const local = store.createTask("Local task", root);

    store.mergeSyncPayload({
      tasks: [
        {
          id: "legacy-same-root",
          title: "Legacy row, same root",
          slug: "legacy-same-root",
          createdAt: "2026-07-18T00:00:00.000Z",
          projectRoot: root,
          archivedAt: null,
          description: null,
          pinnedAt: null,
          updatedAt: "2026-07-18T00:00:00.000Z",
          machineId: "machine-a",
        },
        {
          id: "legacy-foreign-root",
          title: "Legacy row, foreign root",
          slug: "legacy-foreign-root",
          createdAt: "2026-07-18T00:00:00.000Z",
          projectRoot: "/machine-a/dev/checkout",
          archivedAt: null,
          description: null,
          pinnedAt: null,
          updatedAt: "2026-07-18T00:00:00.000Z",
          machineId: "machine-a",
        },
      ],
      sessions: [],
    });

    // A known root joins the existing project; a foreign root without a
    // fingerprint still mints a duplicate, exactly as before this field.
    expect(store.getTask("legacy-same-root")?.projectId).toBe(
      store.getTask(local.id)?.projectId,
    );
    const foreign = store.getTask("legacy-foreign-root");
    expect(foreign?.projectId).not.toBeNull();
    expect(foreign?.projectId).not.toBe(store.getTask(local.id)?.projectId);
    store.close();
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

describe("incremental pull", () => {
  test("the cursor a pull returns is stored and sent as the next pull's since", async () => {
    const server = new CursorTransport();
    const store = openTraceStore(database("cursor"));

    server.cursor = "7";
    await synchronize(store, server);
    server.cursor = "9";
    await synchronize(store, server);

    // First pull has no watermark to send; the second carries what the
    // server handed back, never a value derived from the returned rows.
    expect(server.pulledSince).toEqual([undefined, "7"]);
    store.close();
  });

  test("a pull that returns no rows still advances the watermark", async () => {
    const server = new CursorTransport();
    const store = openTraceStore(database("empty-cursor"));

    server.cursor = "7";
    await synchronize(store, server);
    // Nothing changed server-side, but rows this machine will never be sent
    // again may still have been written: only the server's cursor knows.
    server.cursor = "9";
    expect(await synchronize(store, server)).toEqual({ pushed: 0, pulled: 0 });
    await synchronize(store, server);

    expect(server.pulledSince).toEqual([undefined, "7", "9"]);
    store.close();
  });

  test("a server that sends no cursor gets a full pull and leaves the watermark alone", async () => {
    const server = new CursorTransport();
    const store = openTraceStore(database("legacy-server"));

    // A server predating incremental pull answers every request with full
    // state, so there is nothing to record and nothing to send.
    await synchronize(store, server);
    await synchronize(store, server);
    expect(server.pulledSince).toEqual([undefined, undefined]);
    expect(store.syncCursor("rows")).toBeNull();

    // Should such a server appear after one that did send cursors, the stored
    // watermark stays put — replaying it is safe, discarding it is not.
    server.cursor = "7";
    await synchronize(store, server);
    server.cursor = undefined;
    await synchronize(store, server);
    expect(store.syncCursor("rows")).toBe("7");

    store.close();
  });

  test("document manifests keep a watermark of their own", async () => {
    const server = new CursorTransport();
    const store = openTraceStore(database("doc-cursor"));
    const documents = new MemoryDocumentStore(
      {
        taskId: "task-a",
        filesCiphertext: "[]",
        updatedAt: "2026-01-01T00:00:00.000Z",
        machineId: "machine-a",
      },
      new Map(),
    );

    server.cursor = "7";
    server.documentsCursor = "4";
    await synchronize(store, server, documents);
    await synchronize(store, server, documents);

    // The two endpoints advance independently — they serve different tables,
    // so folding them into one watermark would skip whichever lagged.
    expect(server.pulledSince).toEqual([undefined, "7"]);
    expect(server.pulledDocumentsSince).toEqual([undefined, "4"]);
    expect(store.syncCursor("documents")).toBe("4");
    store.close();
  });
});

describe("document synchronization", () => {
  test("content-addressed documents converge, removals replace the task manifest, and re-sync is a no-op", async () => {
    const server = new MemoryTransport();
    const first = new MemoryDocumentStore(
      {
        taskId: "task-a",
        filesCiphertext: JSON.stringify([
          { path: "state.md", blobHash: "state-v1" },
          { path: "notes.md", blobHash: "notes-v1" },
        ]),
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
        filesCiphertext: "[]",
        updatedAt: "2025-01-01T00:00:00.000Z",
        machineId: "machine-b",
      },
      new Map(),
    );

    expect(await synchronize(rowlessStore(), server, first))
      .toMatchObject({ uploadedBlobs: 2, pushedManifests: 1 });
    // Wrapped keys ride alongside manifests through synchronize().
    expect(server.wrappedKeys.get("task-a")).toBe("wrapped");
    expect(await synchronize(rowlessStore(), server, second))
      .toMatchObject({ downloadedBlobs: 2, pulledManifests: 1 });
    expect(second.paths()).toEqual(["state.md", "notes.md"]);

    const removal = new MemoryDocumentStore(
      {
        taskId: "task-a",
        filesCiphertext: JSON.stringify([
          { path: "state.md", blobHash: "state-v1" },
        ]),
        updatedAt: "2026-01-02T00:00:00.000Z",
        machineId: "machine-b",
      },
      new Map([["state-v1", new TextEncoder().encode("state")]]),
    );
    await synchronize(rowlessStore(), server, removal);
    await synchronize(rowlessStore(), server, first);
    expect(first.paths()).toEqual(["state.md"]);
    expect(await synchronize(rowlessStore(), server, first))
      .toMatchObject({ uploadedBlobs: 0, pushedManifests: 0, downloadedBlobs: 0, pulledManifests: 0 });
    expect(server.blobUploadSizes.at(-1)).toBe(0);
  });
});

describe("last-work context synchronization", () => {
  test("the session snapshot carries portable git labels and omits the local path", () => {
    const store = openTraceStore(database("last-work-snapshot"));
    const task = store.createTask("Checkout");
    store.registerSession({
      id: "session-a",
      transcriptPath: "/machine-a/transcript.jsonl",
      tool: "codex",
    });
    store.assignSession("session-a", task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
      localPath: "/Users/ada/.worktrees/feature-checkout",
    });

    const [row] = store.syncSnapshot().sessions;
    expect(row).toMatchObject({
      gitBranch: "feature-branch",
      gitWorktreeLabel: "feature-checkout",
    });
    expect(row).not.toHaveProperty("gitWorktreePath");
    expect(row).not.toHaveProperty("localPath");
    expect(JSON.stringify(row)).not.toContain(
      "/Users/ada/.worktrees/feature-checkout",
    );

    store.close();
  });

  test("a second store pulls branch and worktree label without the origin path", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("last-work-first"));
    const second = openTraceStore(database("last-work-second"));
    const task = first.createTask("Checkout", "/machine-a/checkout");
    first.registerSession({
      id: "session-a",
      transcriptPath: "/machine-a/transcript.jsonl",
      tool: "codex",
    });
    first.assignSession("session-a", task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
      localPath: "/Users/ada/.worktrees/feature-checkout",
    });

    expect(await synchronize(first, server)).toEqual({ pushed: 2, pulled: 0 });
    expect(await synchronize(second, server)).toEqual({ pushed: 0, pulled: 2 });

    expect(second.getSession("session-a")).toMatchObject({
      gitBranch: "feature-branch",
      gitWorktreeLabel: "feature-checkout",
    });
    expect(second.getSession("session-a")?.gitWorktreePath).toBeUndefined();
    expect(second.getReEntryManifest(task.id)?.lastWorkedOn).toEqual({
      branch: "feature-branch",
      worktree: "feature-checkout",
    });
    expect(JSON.stringify(second.getReEntryManifest(task.id))).not.toContain(
      "/Users/ada/.worktrees/feature-checkout",
    );

    first.close();
    second.close();
  });

  test("re-entry on the receiving store follows the latest session with git context", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("last-work-latest-first"));
    const second = openTraceStore(database("last-work-latest-second"));
    const task = first.createTask("Checkout");
    first.registerSession({
      id: "older",
      transcriptPath: "/machine-a/older.jsonl",
      tool: "claude",
    });
    first.assignSession("older", task.id, { branch: "main" });

    await new Promise((resolve) => setTimeout(resolve, 2));
    first.registerSession({
      id: "newer",
      transcriptPath: "/machine-a/newer.jsonl",
      tool: "codex",
    });
    first.assignSession("newer", task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
    });

    await synchronize(first, server);
    await synchronize(second, server);

    expect(second.getReEntryManifest(task.id)?.lastWorkedOn).toEqual({
      branch: "feature-branch",
      worktree: "feature-checkout",
    });

    first.close();
    second.close();
  });

  test("a legacy session row without git fields still merges", () => {
    const store = openTraceStore(database("last-work-legacy-insert"));
    const task = store.createTask("Checkout");
    const createdAt = "2026-08-01T00:00:00.000Z";
    store.mergeSyncPayload({
      tasks: [],
      sessions: [
        {
          id: "session-legacy",
          transcriptPath: "/old/transcript.jsonl",
          tool: "claude",
          model: null,
          title: null,
          taskId: task.id,
          parentSessionId: null,
          origin: "root",
          subagentType: null,
          agentId: null,
          createdAt,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 0,
          updatedAt: createdAt,
          machineId: "legacy-machine",
        },
      ],
    });

    expect(store.getSession("session-legacy")).toMatchObject({
      taskId: task.id,
    });
    expect(store.getSession("session-legacy")?.gitBranch).toBeUndefined();
    expect(store.getReEntryManifest(task.id)?.lastWorkedOn).toBeUndefined();
    store.close();
  });

  test("a legacy last-write does not erase captured git labels", () => {
    const store = openTraceStore(database("last-work-legacy-lww"));
    const task = store.createTask("Checkout");
    store.registerSession({
      id: "session-a",
      transcriptPath: "/machine-a/transcript.jsonl",
      tool: "codex",
    });
    store.assignSession("session-a", task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
      localPath: "/Users/ada/.worktrees/feature-checkout",
    });

    const [row] = store.syncSnapshot().sessions;
    const legacy = {
      ...row!,
      updatedAt: new Date(Date.parse(row!.updatedAt) + 10).toISOString(),
      machineId: "legacy-machine",
    };
    delete legacy.gitBranch;
    delete legacy.gitWorktreeLabel;

    store.mergeSyncPayload({ tasks: [], sessions: [legacy] });

    expect(store.getSession("session-a")).toMatchObject({
      gitBranch: "feature-branch",
      gitWorktreeLabel: "feature-checkout",
      gitWorktreePath: "/Users/ada/.worktrees/feature-checkout",
    });
    store.close();
  });

  test("a later inbound write keeps the local worktree path", async () => {
    const server = new MemoryTransport();
    const first = openTraceStore(database("last-work-path-first"));
    const second = openTraceStore(database("last-work-path-second"));
    const task = first.createTask("Checkout");
    first.registerSession({
      id: "session-a",
      transcriptPath: "/machine-a/transcript.jsonl",
      tool: "codex",
    });
    first.assignSession("session-a", task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
      localPath: "/Users/ada/.worktrees/feature-checkout",
    });

    await synchronize(first, server);
    await synchronize(second, server);

    await new Promise((resolve) => setTimeout(resolve, 2));
    second.assignSession("session-a", task.id, {
      branch: "feature-branch",
      worktreeLabel: "feature-checkout",
    });
    await synchronize(second, server);
    await synchronize(first, server);

    expect(first.getSession("session-a")?.gitWorktreePath).toBe(
      "/Users/ada/.worktrees/feature-checkout",
    );
    expect(second.getSession("session-a")?.gitWorktreePath).toBeUndefined();

    first.close();
    second.close();
  });
});
