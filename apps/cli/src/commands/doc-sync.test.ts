import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  compareSyncRows,
  openTraceStore,
  resolveTaskDocsDir,
  synchronize,
  type SyncBlob,
  type SyncDocManifest,
  type SyncPayload,
  type SyncTransport,
} from "@trace/core";
import { FileSystemDocumentStore } from "./doc-sync.ts";

class DocumentTransport implements SyncTransport {
  rows: SyncPayload = { tasks: [], sessions: [] };
  manifests: SyncDocManifest[] = [];
  blobs = new Map<string, Uint8Array>();
  async missingBlobs(hashes: string[]) { return hashes.filter((hash) => !this.blobs.has(hash)); }

  async push(payload: SyncPayload) {
    for (const task of payload.tasks) {
      if (!this.rows.tasks.some((item) => item.id === task.id)) this.rows.tasks.push(task);
    }
    return { accepted: payload.tasks.length };
  }
  async pull() { return structuredClone(this.rows); }
  async pushDocuments(manifests: SyncDocManifest[], blobs: SyncBlob[]) {
    let accepted = 0;
    for (const manifest of manifests) {
      const index = this.manifests.findIndex((item) => item.taskId === manifest.taskId);
      if (index < 0) { this.manifests.push(structuredClone(manifest)); accepted += 1; }
      else if (compareSyncRows(manifest, this.manifests[index]!) > 0) { this.manifests[index] = structuredClone(manifest); accepted += 1; }
    }
    let uploaded = 0;
    for (const blob of blobs) {
      if (!this.blobs.has(blob.hash)) { this.blobs.set(blob.hash, blob.content.slice()); uploaded += 1; }
    }
    return { accepted, uploaded };
  }
  async pullDocumentManifests() { return structuredClone(this.manifests); }
  async downloadBlob(hash: string) { return this.blobs.get(hash)?.slice() ?? null; }
}

test("two filesystem document stores converge additions, modifications, and removals without re-uploading blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-doc-sync-"));
  const firstDb = join(root, "first", "trace.sqlite");
  const secondDb = join(root, "second", "trace.sqlite");
  const first = openTraceStore(firstDb);
  const second = openTraceStore(secondDb);
  const task = first.createTask("Cloud docs");
  const server = new DocumentTransport();
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const firstDocs = new FileSystemDocumentStore(firstDb, () => first.syncSnapshot().tasks, { now: clock });
  const secondDocs = new FileSystemDocumentStore(secondDb, () => second.syncSnapshot().tasks, { now: clock });

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
