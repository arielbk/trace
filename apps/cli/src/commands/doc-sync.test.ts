import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  compareSyncRows,
  createKeyWrapper,
  createTaskDocCrypto,
  openTraceStore,
  resolveTaskDocsDir,
  synchronize,
  type SyncBlob,
  type SyncDocManifest,
  type SyncPayload,
  type SyncTransport,
  type SyncWrappedKey,
} from "@trace/core";
import { FileSystemDocumentStore } from "./doc-sync.ts";

class DocumentTransport implements SyncTransport {
  rows: SyncPayload = { tasks: [], sessions: [] };
  manifests: SyncDocManifest[] = [];
  wrappedKeys = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  async missingBlobs(hashes: string[]) { return hashes.filter((hash) => !this.blobs.has(hash)); }

  async push(payload: SyncPayload) {
    for (const task of payload.tasks) {
      if (!this.rows.tasks.some((item) => item.id === task.id)) this.rows.tasks.push(task);
    }
    return { accepted: payload.tasks.length };
  }
  async pull() { return structuredClone(this.rows); }
  async pushDocuments(
    manifests: SyncDocManifest[],
    blobs: SyncBlob[],
    wrappedKeys: SyncWrappedKey[],
  ) {
    let accepted = 0;
    for (const manifest of manifests) {
      const index = this.manifests.findIndex((item) => item.taskId === manifest.taskId);
      if (index < 0) { this.manifests.push(structuredClone(manifest)); accepted += 1; }
      else if (compareSyncRows(manifest, this.manifests[index]!) > 0) { this.manifests[index] = structuredClone(manifest); accepted += 1; }
    }
    for (const { taskId, wrappedKey } of wrappedKeys) this.wrappedKeys.set(taskId, wrappedKey);
    let uploaded = 0;
    for (const blob of blobs) {
      if (!this.blobs.has(blob.hash)) { this.blobs.set(blob.hash, blob.content.slice()); uploaded += 1; }
    }
    return { accepted, uploaded };
  }
  async pullDocumentManifests() {
    return {
      manifests: structuredClone(this.manifests),
      wrappedKeys: [...this.wrappedKeys].map(([taskId, wrappedKey]) => ({ taskId, wrappedKey })),
    };
  }
  async downloadBlob(hash: string) { return this.blobs.get(hash)?.slice() ?? null; }
}

test("registered doc titles and descriptions travel with the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  const task = first.createTask("Labelled docs");
  const server = new DocumentTransport();
  const keyWrapper = createKeyWrapper("12".repeat(32));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const docsAccessor = (store: typeof first) => ({
    list: (taskId: string) => store.listDocsForTask(taskId),
    update: (taskId: string, path: string, fields: { title?: string; description?: string }) =>
      void store.updateTaskDoc(taskId, path, fields),
  });
  const firstDocs = new FileSystemDocumentStore(firstDb, () => first.syncSnapshot().tasks, { keyWrapper, now: clock, docs: docsAccessor(first) });
  const secondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { keyWrapper, now: clock, docs: docsAccessor(second) });

  const firstDir = resolveTaskDocsDir(firstDb, task.slug);
  mkdirSync(firstDir, { recursive: true });
  writeFileSync(join(firstDir, "spec.md"), "the spec");
  writeFileSync(join(firstDir, "scratch.md"), "unregistered scratch notes");
  first.addTaskDoc(task.id, join(firstDir, "spec.md"), {
    title: "PRD: Labelled docs",
    description: "What we are building and why",
  });

  await synchronize(first, server, firstDocs);
  expect(server.manifests[0]).toMatchObject({
    taskId: task.id,
    filesCiphertext: expect.any(String),
  });
  expect(server.manifests[0]).not.toHaveProperty("files");
  expect(Buffer.from(server.blobs.values().next().value!)).not.toContain(
    Buffer.from("the spec"),
  );
  await synchronize(second, server, secondDocs);

  const pulledDocs = second.listDocsForTask(task.id);
  const secondDir = resolveTaskDocsDir(secondDb, task.slug);
  expect(pulledDocs.find((doc) => doc.path === join(secondDir, "spec.md"))).toMatchObject({
    title: "PRD: Labelled docs",
    description: "What we are building and why",
  });
  // The unregistered file arrives as content only — no metadata row invented.
  const scratch = pulledDocs.find((doc) => doc.path === join(secondDir, "scratch.md"));
  expect(scratch?.title).toBeUndefined();
  expect(scratch?.description).toBeUndefined();

  // A manifest entry without metadata never strips labels the pulling
  // machine already has: a legacy client (no docs accessor) on the second
  // machine edits the file and pushes a metadata-less manifest, yet first's
  // registered row keeps its title through the round trip.
  const legacySecondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { keyWrapper, now: clock });
  writeFileSync(join(secondDir, "spec.md"), "the spec, revised");
  await synchronize(second, server, legacySecondDocs);
  await synchronize(first, server, firstDocs);
  expect(readFileSync(join(firstDir, "spec.md"), "utf8")).toBe("the spec, revised");
  expect(first.listDocsForTask(task.id).find((doc) => doc.path === join(firstDir, "spec.md")))
    .toMatchObject({ title: "PRD: Labelled docs" });

  first.close();
  second.close();
});

test("two filesystem document stores converge additions, modifications, and removals without re-uploading blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  const task = first.createTask("Cloud docs");
  const server = new DocumentTransport();
  const keyWrapper = createKeyWrapper("34".repeat(32));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const firstDocs = new FileSystemDocumentStore(firstDb, () => first.syncSnapshot().tasks, { keyWrapper, now: clock });
  const secondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { keyWrapper, now: clock });

  const firstDir = resolveTaskDocsDir(firstDb, task.slug);
  mkdirSync(firstDir, { recursive: true });
  writeFileSync(join(firstDir, "state.md"), "version one");
  await synchronize(first, server, firstDocs);
  const initialPull = await synchronize(second, server, secondDocs);
  expect(readFileSync(join(resolveTaskDocsDir(secondDb, task.slug), "state.md"), "utf8")).toBe("version one");
  expect(initialPull).toMatchObject({ downloadedBlobs: 1, pulledManifests: 1 });

  writeFileSync(join(resolveTaskDocsDir(secondDb, task.slug), "state.md"), "version two");
  writeFileSync(join(resolveTaskDocsDir(secondDb, task.slug), "notes.md"), "temporary note");
  await synchronize(second, server, secondDocs);
  await synchronize(first, server, firstDocs);
  expect(readFileSync(join(firstDir, "state.md"), "utf8")).toBe("version two");
  expect(readFileSync(join(firstDir, "notes.md"), "utf8")).toBe("temporary note");

  rmSync(join(firstDir, "notes.md"));
  const removalPush = await synchronize(first, server, firstDocs);
  await synchronize(second, server, secondDocs);
  expect(() => readFileSync(join(resolveTaskDocsDir(secondDb, task.slug), "notes.md"))).toThrow();
  expect(removalPush).toMatchObject({ uploadedBlobs: 0, pushedManifests: 1 });
  expect(await synchronize(first, server, firstDocs)).toMatchObject({ uploadedBlobs: 0, pushedManifests: 0 });

  first.close();
  second.close();
});

test("a document store with a different master key rejects the manifest before touching local files", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  const task = first.createTask("Private docs");
  const server = new DocumentTransport();
  const firstDocs = new FileSystemDocumentStore(
    firstDb,
    () => first.syncSnapshot().tasks,
    { keyWrapper: createKeyWrapper("56".repeat(32)) },
  );
  const secondDocs = new FileSystemDocumentStore(
    secondDb,
    () => second.syncSnapshot().tasks,
    { keyWrapper: createKeyWrapper("78".repeat(32)) },
  );
  const docsDir = resolveTaskDocsDir(firstDb, task.slug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "state.md"), "private state");

  try {
    await synchronize(first, server, firstDocs);
    await expect(synchronize(second, server, secondDocs)).rejects.toThrow(
      "could not decrypt document manifest",
    );
    // The wrong master key fails at unwrap, before any file is materialised.
    expect(existsSync(resolveTaskDocsDir(secondDb, task.slug))).toBe(false);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

type StoredMetadata = {
  tasks: Record<string, { fingerprint: string; wrappedKey: string }>;
};

function readDocSyncMetadata(databasePath: string): StoredMetadata {
  return JSON.parse(
    readFileSync(join(dirname(databasePath), "doc-sync.json"), "utf8"),
  ) as StoredMetadata;
}

test("the first push mints and persists a task wrapped key that the server stores verbatim", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const db = join(root, "trace.sqlite");
  const store = openTraceStore(db);
  const task = store.createTask("Keyed docs");
  const server = new DocumentTransport();
  const docs = new FileSystemDocumentStore(db, () => store.syncSnapshot().tasks, {
    keyWrapper: createKeyWrapper("9a".repeat(32)),
  });
  const docsDir = resolveTaskDocsDir(db, task.slug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "state.md"), "first version");

  try {
    await synchronize(store, server, docs);
    const persisted = readDocSyncMetadata(db).tasks[task.id]!;
    expect(persisted.wrappedKey).toEqual(expect.any(String));
    expect(persisted.wrappedKey.length).toBeGreaterThan(0);
    // The server holds exactly the client's wrapped key, byte for byte.
    expect(server.wrappedKeys.get(task.id)).toBe(persisted.wrappedKey);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unchanged content keeps the wrapped key and manifest stable across pushes (no re-wrap churn)", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const db = join(root, "trace.sqlite");
  const store = openTraceStore(db);
  const task = store.createTask("Stable docs");
  const server = new DocumentTransport();
  let tick = 0;
  const docs = new FileSystemDocumentStore(db, () => store.syncSnapshot().tasks, {
    keyWrapper: createKeyWrapper("ab".repeat(32)),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  const docsDir = resolveTaskDocsDir(db, task.slug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "state.md"), "steady content");

  try {
    await synchronize(store, server, docs);
    const first = readDocSyncMetadata(db).tasks[task.id]!;
    const firstManifest = structuredClone(server.manifests[0]);

    // A second sync with no content change must not re-wrap or re-seal.
    const second = await synchronize(store, server, docs);
    const after = readDocSyncMetadata(db).tasks[task.id]!;
    expect(after.wrappedKey).toBe(first.wrappedKey);
    expect(after.fingerprint).toBe(first.fingerprint);
    expect(server.manifests[0]).toEqual(firstManifest);
    expect(server.wrappedKeys.get(task.id)).toBe(first.wrappedKey);
    expect(second).toMatchObject({ pushedManifests: 0, uploadedBlobs: 0 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pulled docs keep the source machine's modified dates", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  const task = first.createTask("Dated docs");
  const server = new DocumentTransport();
  const keyWrapper = createKeyWrapper("ef".repeat(32));
  const firstDocs = new FileSystemDocumentStore(firstDb, () => first.syncSnapshot().tasks, { keyWrapper });
  const secondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { keyWrapper });

  try {
    const firstDir = resolveTaskDocsDir(firstDb, task.slug);
    mkdirSync(join(firstDir, "notes"), { recursive: true });
    writeFileSync(join(firstDir, "spec.md"), "the spec");
    writeFileSync(join(firstDir, "notes", "log.md"), "the log");
    const specDate = new Date("2025-03-05T12:34:56.000Z");
    const logDate = new Date("2025-04-01T08:00:00.000Z");
    utimesSync(join(firstDir, "spec.md"), specDate, specDate);
    utimesSync(join(firstDir, "notes", "log.md"), logDate, logDate);

    await synchronize(first, server, firstDocs);
    await synchronize(second, server, secondDocs);

    const secondDir = resolveTaskDocsDir(secondDb, task.slug);
    expect(statSync(join(secondDir, "spec.md")).mtime.toISOString()).toBe(
      specDate.toISOString(),
    );
    expect(statSync(join(secondDir, "notes", "log.md")).mtime.toISOString()).toBe(
      logDate.toISOString(),
    );
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest entry without a modified date still applies and leaves the write time alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  const task = first.createTask("Legacy docs");
  const server = new DocumentTransport();
  const keyWrapper = createKeyWrapper("21".repeat(32));
  const firstDocs = new FileSystemDocumentStore(firstDb, () => first.syncSnapshot().tasks, { keyWrapper });
  const secondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { keyWrapper });

  try {
    const firstDir = resolveTaskDocsDir(firstDb, task.slug);
    mkdirSync(firstDir, { recursive: true });
    writeFileSync(join(firstDir, "spec.md"), "the spec");
    const oldDate = new Date("2025-03-05T12:34:56.000Z");
    utimesSync(join(firstDir, "spec.md"), oldDate, oldDate);
    await synchronize(first, server, firstDocs);

    // Simulate a manifest sealed by an older client: same files list, minus
    // the modified dates.
    const crypto = createTaskDocCrypto(
      keyWrapper.unwrapTaskKey(server.wrappedKeys.get(task.id)!),
    );
    const legacyFiles = crypto
      .openFilesList(server.manifests[0]!.filesCiphertext)
      .map(({ path, blobHash }) => ({ path, blobHash }));
    server.manifests[0] = {
      ...server.manifests[0]!,
      filesCiphertext: crypto.sealFilesList(legacyFiles),
    };

    const beforePull = Date.now();
    await synchronize(second, server, secondDocs);
    const pulled = join(resolveTaskDocsDir(secondDb, task.slug), "spec.md");
    expect(readFileSync(pulled, "utf8")).toBe("the spec");
    // No date in the manifest → the file keeps its local write time.
    expect(statSync(pulled).mtime.getTime()).toBeGreaterThanOrEqual(beforePull - 1000);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("converged duplicate-slug tasks decrypt under the surviving task id's key", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  // Both machines mint the same slug independently before ever syncing.
  const fromFirst = first.createTask("Shared plan", "/project-a");
  second.createTask("Shared plan", "/project-b");
  const server = new DocumentTransport();
  const keyWrapper = createKeyWrapper("cd".repeat(32));
  const firstDocs = new FileSystemDocumentStore(firstDb, () => first.syncSnapshot().tasks, { keyWrapper });
  const secondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { keyWrapper });

  try {
    const firstDir = resolveTaskDocsDir(firstDb, fromFirst.slug);
    mkdirSync(firstDir, { recursive: true });
    writeFileSync(join(firstDir, "plan.md"), "the surviving plan");

    await synchronize(first, server, firstDocs);
    await synchronize(second, server, secondDocs);

    // The pulled twin lands under a local suffix, but the wrapped key is keyed
    // by task id — so the second machine decrypts it under the surviving id.
    const survivingSlug = second.getTask(fromFirst.id)!.slug;
    expect(survivingSlug).toBe("shared-plan-2");
    const materialised = join(resolveTaskDocsDir(secondDb, survivingSlug), "plan.md");
    expect(readFileSync(materialised, "utf8")).toBe("the surviving plan");
    // The second machine adopts the minting machine's wrapped key verbatim.
    expect(readDocSyncMetadata(secondDb).tasks[fromFirst.id]!.wrappedKey).toBe(
      server.wrappedKeys.get(fromFirst.id),
    );

    // Editing on the second machine re-sends the same envelope — one stable row.
    const beforeEdit = server.wrappedKeys.get(fromFirst.id);
    writeFileSync(materialised, "the surviving plan, revised");
    await synchronize(second, server, secondDocs);
    expect(server.wrappedKeys.get(fromFirst.id)).toBe(beforeEdit);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
