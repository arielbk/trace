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
  createTaskDocCrypto,
  generateTaskKey,
  resolveTaskDocsDir,
  type DocCrypto,
  type DocCryptoFile,
  type KeyWrapper,
  type SyncBlob,
  type SyncDocManifest,
  type SyncDocumentStore,
  type SyncTaskRow,
  type SyncWrappedKey,
} from "@trace/core";

type DocumentMetadata = {
  machineId: string;
  // Per task: the fingerprint of the last pushed file set, the manifest we
  // published, and the wrapped DEK. The wrapped key is minted once (on first
  // push) or adopted from a pull, then persisted verbatim and never re-wrapped
  // — so the server row stays byte-stable across re-pushes.
  tasks: Record<
    string,
    { fingerprint: string; manifest: SyncDocManifest; wrappedKey: string }
  >;
};

// Bridge to the store's task_docs rows, so registered doc titles and
// descriptions travel inside the manifest rather than staying machine-local.
export type DocMetadataAccessor = {
  list(taskId: string): { path: string; title?: string; description?: string }[];
  update(
    taskId: string,
    path: string,
    fields: { title?: string; description?: string },
  ): void;
};

export class FileSystemDocumentStore implements SyncDocumentStore {
  readonly #metadataPath: string;
  private readonly databasePath: string;
  private readonly tasks: () => SyncTaskRow[];
  private readonly options: {
    keyWrapper: KeyWrapper;
    now?: () => string;
    docs?: DocMetadataAccessor;
  };

  constructor(
    databasePath: string,
    tasks: () => SyncTaskRow[],
    options: {
      keyWrapper: KeyWrapper;
      now?: () => string;
      docs?: DocMetadataAccessor;
    },
  ) {
    this.databasePath = databasePath;
    this.tasks = tasks;
    this.options = options;
    this.#metadataPath = join(dirname(resolve(databasePath)), "doc-sync.json");
  }

  async snapshot(): Promise<{
    manifests: SyncDocManifest[];
    blobs: SyncBlob[];
    wrappedKeys: SyncWrappedKey[];
  }> {
    const metadata = this.#readMetadata();
    const manifests: SyncDocManifest[] = [];
    const wrappedKeys: SyncWrappedKey[] = [];
    const blobs = new Map<string, Uint8Array>();
    let changed = false;

    for (const task of this.tasks()) {
      const docsDir = resolveTaskDocsDir(this.databasePath, task.slug);
      const files = readFiles(docsDir);
      let tracked = metadata.tasks[task.id];
      // A task that has never synced and has no docs stays untouched — no DEK
      // is minted, so tasks that never sync never carry key material.
      if (!tracked && files.length === 0) continue;

      // Mint the DEK on first push and persist its wrapped form; every later
      // push reuses that exact envelope so the server row never churns.
      const wrappedKey =
        tracked?.wrappedKey ??
        this.options.keyWrapper.wrapTaskKey(generateTaskKey());
      const crypto = this.#cryptoFor(wrappedKey);

      const metadataByPath = this.#docMetadataByRelativePath(task.id, docsDir);
      const manifestFiles = files.map((file) => ({
        path: file.path,
        blobHash: crypto.address(file.content),
        ...(metadataByPath.get(file.path) ?? {}),
      }));
      const fingerprint = fingerprintOf(manifestFiles);
      if (
        !tracked ||
        tracked.fingerprint !== fingerprint ||
        tracked.wrappedKey !== wrappedKey
      ) {
        tracked = {
          fingerprint,
          wrappedKey,
          manifest: {
            taskId: task.id,
            filesCiphertext: crypto.sealFilesList(manifestFiles),
            updatedAt: this.options.now?.() ?? new Date().toISOString(),
            machineId: metadata.machineId,
          },
        };
        metadata.tasks[task.id] = tracked;
        changed = true;
      }
      manifests.push(structuredClone(tracked.manifest));
      wrappedKeys.push({ taskId: task.id, wrappedKey });
      for (const file of files) {
        blobs.set(crypto.address(file.content), crypto.sealBlob(file.content));
      }
    }

    if (changed) this.#writeMetadata(metadata);
    return {
      manifests,
      blobs: [...blobs].map(([hash, content]) => ({ hash, content })),
      wrappedKeys,
    };
  }

  async apply(
    manifests: SyncDocManifest[],
    wrappedKeys: SyncWrappedKey[],
    download: (hash: string) => Promise<Uint8Array | null>,
  ): Promise<{ pulled: number; downloaded: number }> {
    const metadata = this.#readMetadata();
    const tasks = new Map(this.tasks().map((task) => [task.id, task]));
    const wrappedByTask = new Map(
      wrappedKeys.map(({ taskId, wrappedKey }) => [taskId, wrappedKey]),
    );
    let pulled = 0;
    let downloaded = 0;

    for (const manifest of manifests) {
      const task = tasks.get(manifest.taskId);
      const tracked = metadata.tasks[manifest.taskId];
      if (!task || (tracked && compareSyncRows(manifest, tracked.manifest) <= 0)) continue;

      const wrappedKey = wrappedByTask.get(manifest.taskId);
      if (!wrappedKey) {
        throw new Error(
          `sync server is missing the wrapped key for task ${manifest.taskId}`,
        );
      }
      // Unwrap the DEK with the master KEK before anything else — a wrong
      // master key fails the AEAD tag here, before any local file is touched.
      let crypto: DocCrypto;
      let manifestFiles: DocCryptoFile[];
      try {
        crypto = this.#cryptoFor(wrappedKey);
        manifestFiles = crypto.openFilesList(manifest.filesCiphertext);
      } catch {
        throw new Error(
          `could not decrypt document manifest for task ${manifest.taskId}`,
        );
      }
      validateManifest(manifestFiles);

      const docsDir = resolveTaskDocsDir(this.databasePath, task.slug);
      const local = new Map(
        readFiles(docsDir).map((file) => [
          crypto.address(file.content),
          file.content,
        ]),
      );
      const contents = new Map<string, Uint8Array>();
      for (const file of manifestFiles) {
        let content = local.get(file.blobHash);
        if (!content) {
          const envelope = await download(file.blobHash);
          if (!envelope) {
            throw new Error(`sync server is missing blob ${file.blobHash}`);
          }
          try {
            content = crypto.openBlob(envelope, file.blobHash);
          } catch {
            throw new Error(
              `could not decrypt or verify document blob ${file.blobHash}`,
            );
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
      // Entries that carry metadata are authoritative for it; entries without
      // any leave local task_docs rows untouched, so an old-format manifest
      // can never strip labels this machine already has.
      for (const file of manifestFiles) {
        if (file.title === undefined && file.description === undefined) continue;
        this.options.docs?.update(task.id, join(docsDir, ...file.path.split("/")), {
          ...(file.title === undefined ? {} : { title: file.title }),
          ...(file.description === undefined ? {} : { description: file.description }),
        });
      }
      // Adopt the incoming wrapped key verbatim so a re-push re-sends the same
      // envelope the minting machine produced — the surviving task id owns one
      // stable server row even after slug convergence.
      metadata.tasks[manifest.taskId] = {
        fingerprint: fingerprintOf(manifestFiles),
        manifest: structuredClone(manifest),
        wrappedKey,
      };
      pulled += 1;
    }

    if (pulled > 0) this.#writeMetadata(metadata);
    return { pulled, downloaded };
  }

  // Unwrap a stored/incoming wrapped DEK with the account master KEK and build
  // the per-task crypto surface from it.
  #cryptoFor(wrappedKey: string): DocCrypto {
    return createTaskDocCrypto(this.options.keyWrapper.unwrapTaskKey(wrappedKey));
  }

  // Map registered docs onto manifest-relative paths. Only docs that carry a
  // stored title or description contribute an entry: emitting nothing for the
  // rest is what lets the apply side treat absent fields as "no opinion".
  #docMetadataByRelativePath(
    taskId: string,
    docsDir: string,
  ): Map<string, { title?: string; description?: string }> {
    const metadataByPath = new Map<string, { title?: string; description?: string }>();
    for (const doc of this.options.docs?.list(taskId) ?? []) {
      if (doc.title === undefined && doc.description === undefined) continue;
      // Legacy rows may hold a bare relative path; resolve it the same way
      // the doc listing does before checking it lives inside the docs dir.
      const absolute = isAbsolute(doc.path) ? doc.path : resolve(docsDir, doc.path);
      const relativePath = relative(docsDir, absolute);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
      metadataByPath.set(relativePath.split(sep).join("/"), {
        ...(doc.title === undefined ? {} : { title: doc.title }),
        ...(doc.description === undefined ? {} : { description: doc.description }),
      });
    }
    return metadataByPath;
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

function readFiles(root: string): { path: string; content: Uint8Array }[] {
  if (!existsSync(root)) return [];
  const files: { path: string; content: Uint8Array }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const content = readFileSync(absolute);
        files.push({
          path: relative(root, absolute).split(sep).join("/"),
          content,
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

// Fingerprints must survive a round trip through the server, and Postgres
// jsonb does not preserve object key order — so hash a canonical projection
// rather than the entries' own serialization.
function fingerprintOf(files: DocCryptoFile[]): string {
  const canonical = files.map((file) => [
    file.path,
    file.blobHash,
    file.title ?? null,
    file.description ?? null,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validateManifest(files: DocCryptoFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
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
