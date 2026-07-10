import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  compareSyncRows,
  resolveTaskDocsDir,
  type SyncBlob,
  type SyncDocManifest,
  type SyncDocumentStore,
  type SyncTaskRow,
} from "@trace/core";

type DocumentMetadata = {
  machineId: string;
  tasks: Record<string, { fingerprint: string; manifest: SyncDocManifest }>;
};

export class FileSystemDocumentStore implements SyncDocumentStore {
  readonly #metadataPath: string;

  constructor(
    private readonly databasePath: string,
    private readonly tasks: () => SyncTaskRow[],
    private readonly options: { now?: () => string } = {},
  ) {
    this.#metadataPath = join(dirname(resolve(databasePath)), "doc-sync.json");
  }

  async snapshot(): Promise<{ manifests: SyncDocManifest[]; blobs: SyncBlob[] }> {
    const metadata = this.#readMetadata();
    const manifests: SyncDocManifest[] = [];
    const blobs = new Map<string, Uint8Array>();
    let changed = false;

    for (const task of this.tasks()) {
      const files = readFiles(resolveTaskDocsDir(this.databasePath, task.slug));
      const manifestFiles = files.map((file) => ({ path: file.path, blobHash: file.hash }));
      const fingerprint = fingerprintOf(manifestFiles);
      let tracked = metadata.tasks[task.id];
      if (!tracked && files.length === 0) continue;
      if (!tracked || tracked.fingerprint !== fingerprint) {
        tracked = {
          fingerprint,
          manifest: {
            taskId: task.id,
            files: manifestFiles,
            updatedAt: this.options.now?.() ?? new Date().toISOString(),
            machineId: metadata.machineId,
          },
        };
        metadata.tasks[task.id] = tracked;
        changed = true;
      }
      manifests.push(structuredClone(tracked.manifest));
      for (const file of files) blobs.set(file.hash, file.content);
    }

    if (changed) this.#writeMetadata(metadata);
    return {
      manifests,
      blobs: [...blobs].map(([hash, content]) => ({ hash, content })),
    };
  }

  async apply(
    manifests: SyncDocManifest[],
    download: (hash: string) => Promise<Uint8Array | null>,
  ): Promise<{ pulled: number; downloaded: number }> {
    const metadata = this.#readMetadata();
    const tasks = new Map(this.tasks().map((task) => [task.id, task]));
    let pulled = 0;
    let downloaded = 0;

    for (const manifest of manifests) {
      const task = tasks.get(manifest.taskId);
      const tracked = metadata.tasks[manifest.taskId];
      if (!task || (tracked && compareSyncRows(manifest, tracked.manifest) <= 0)) continue;
      validateManifest(manifest);

      const docsDir = resolveTaskDocsDir(this.databasePath, task.slug);
      const local = new Map(readFiles(docsDir).map((file) => [file.hash, file.content]));
      const contents = new Map<string, Uint8Array>();
      for (const file of manifest.files) {
        let content = local.get(file.blobHash);
        if (!content) {
          content = (await download(file.blobHash)) ?? undefined;
          if (!content) throw new Error(`sync server is missing blob ${file.blobHash}`);
          if (hash(content) !== file.blobHash) {
            throw new Error(`sync server returned corrupt blob ${file.blobHash}`);
          }
          downloaded += 1;
        }
        contents.set(file.path, content);
      }

      rmSync(docsDir, { recursive: true, force: true });
      for (const [path, content] of contents) {
        const destination = join(docsDir, ...path.split("/"));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, content);
      }
      metadata.tasks[manifest.taskId] = {
        fingerprint: fingerprintOf(manifest.files),
        manifest: structuredClone(manifest),
      };
      pulled += 1;
    }

    if (pulled > 0) this.#writeMetadata(metadata);
    return { pulled, downloaded };
  }

  #readMetadata(): DocumentMetadata {
    if (!existsSync(this.#metadataPath)) return { machineId: randomUUID(), tasks: {} };
    return JSON.parse(readFileSync(this.#metadataPath, "utf8")) as DocumentMetadata;
  }

  #writeMetadata(metadata: DocumentMetadata): void {
    mkdirSync(dirname(this.#metadataPath), { recursive: true });
    const temporary = `${this.#metadataPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#metadataPath);
  }
}

function readFiles(root: string): { path: string; hash: string; content: Uint8Array }[] {
  if (!existsSync(root)) return [];
  const files: { path: string; hash: string; content: Uint8Array }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const content = readFileSync(absolute);
        files.push({
          path: relative(root, absolute).split(sep).join("/"),
          hash: hash(content),
          content,
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function fingerprintOf(files: SyncDocManifest["files"]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function validateManifest(manifest: SyncDocManifest): void {
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file.path ||
      isAbsolute(file.path) ||
      file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      paths.has(file.path)
    ) {
      throw new Error(`invalid document path in sync manifest: ${file.path}`);
    }
    paths.add(file.path);
  }
}
