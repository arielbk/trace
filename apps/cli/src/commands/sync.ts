import {
  createKeyWrapper,
  openTraceStore,
  resolveConfiguredServerUrl,
  resolveDatabasePath,
  synchronize,
  updateSyncStatusFile,
  type SyncPayload,
  type SyncBlob,
  type SyncDocManifest,
  type SyncTransport,
  type SyncWrappedKey,
} from "@trace/core";
import { spawn as nodeSpawn } from "node:child_process";
import { NO_SERVER_CONFIGURED_MESSAGE, readAuthToken } from "./auth.ts";
import { FileSystemDocumentStore } from "./doc-sync.ts";
import { readStoredDocCryptoKey } from "./key.ts";
import type { CommandResult, Env } from "./seam.ts";

type BackgroundChild = {
  on(event: "error", listener: () => void): unknown;
  unref(): void;
};

type BackgroundSpawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => BackgroundChild;

/** Start an isolated sync process without adding latency to the calling command. */
export function triggerBackgroundSync(
  env: Env,
  dependencies: {
    spawn?: BackgroundSpawn;
    executable?: string;
  } = {},
): void {
  if (!readAuthToken(env)) return;
  const executable = dependencies.executable ?? process.argv[1];
  if (!executable) return;

  try {
    const child = (dependencies.spawn ?? nodeSpawn)(
      process.execPath,
      [executable, "sync"],
      { detached: true, stdio: "ignore", env: { ...process.env, ...env } },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Background sync is best-effort and must never affect the foreground path.
  }
}

export async function runSyncCommand(
  env: Env,
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): Promise<CommandResult> {
  const serverUrl = resolveConfiguredServerUrl(env);
  if (!serverUrl) {
    // Cloud sync is flagged off without a configured server — soft no-op so a
    // stray `trace sync` (foreground or background) never invents a server.
    return { exitCode: 0, stdout: `${NO_SERVER_CONFIGURED_MESSAGE}\n`, stderr: "" };
  }
  const token = readAuthToken(env);
  if (!token) {
    return { exitCode: 0, stdout: "Not logged in. Run trace login.\n", stderr: "" };
  }
  const masterKey = readStoredDocCryptoKey(env);
  if (!masterKey) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "No document encryption key found. Run trace login to set one up.\n",
    };
  }
  const databasePath = resolveDatabasePath(env);
  const store = openTraceStore(databasePath);
  try {
    const result = await synchronize(
      store,
      new HttpSyncTransport(
        serverUrl,
        token.accessToken,
        dependencies.fetch ?? globalThis.fetch,
      ),
      new FileSystemDocumentStore(databasePath, () => store.syncSnapshot().tasks, {
        keyWrapper: createKeyWrapper(masterKey),
        docs: {
          list: (taskId) => store.listDocsForTask(taskId),
          update: (taskId, path, fields) => void store.updateTaskDoc(taskId, path, fields),
        },
      }),
    );
    recordSyncStatus(databasePath, { loggedIn: true, lastSyncedAt: new Date().toISOString(), lastError: undefined });
    const documentChanges =
      (result.pushedManifests ?? 0) +
      (result.pulledManifests ?? 0) +
      (result.uploadedBlobs ?? 0) +
      (result.downloadedBlobs ?? 0);
    return {
      exitCode: 0,
      stdout:
        `Sync complete: ${result.pushed} pushed, ${result.pulled} pulled.` +
        (documentChanges > 0
          ? ` Docs: ${result.pushedManifests} manifests pushed, ${result.pulledManifests} pulled, ${result.uploadedBlobs} blobs uploaded, ${result.downloadedBlobs} downloaded.`
          : "") +
        "\n",
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordSyncStatus(databasePath, { loggedIn: true, lastError: message });
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sync failed: ${message}\n`,
    };
  } finally {
    store.close();
  }
}

/**
 * Persist the outcome of a sync for the board's status header. Best-effort: a
 * write failure here must never change the command's own exit code or output.
 */
function recordSyncStatus(
  databasePath: string,
  patch: Parameters<typeof updateSyncStatusFile>[1],
): void {
  try {
    updateSyncStatusFile(databasePath, patch);
  } catch {
    // The header just won't reflect this sync; the sync itself still stands.
  }
}

class HttpSyncTransport implements SyncTransport {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    serverUrl: string,
    token: string,
    fetch: typeof globalThis.fetch,
  ) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.fetch = fetch;
  }

  async push(payload: SyncPayload): Promise<{ accepted: number }> {
    return this.request<{ accepted: number }>("/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async pull(): Promise<SyncPayload> {
    return this.request<SyncPayload>("/api/sync/pull");
  }

  async pushDocuments(
    manifests: SyncDocManifest[],
    blobs: SyncBlob[],
    wrappedKeys: SyncWrappedKey[],
  ): Promise<{ accepted: number; uploaded: number }> {
    return this.request("/api/sync/docs/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifests,
        blobs: blobs.map((blob) => ({
          hash: blob.hash,
          content: Buffer.from(blob.content).toString("base64"),
        })),
        wrappedKeys,
      }),
    });
  }

  async pullDocumentManifests(): Promise<{
    manifests: SyncDocManifest[];
    wrappedKeys: SyncWrappedKey[];
  }> {
    return this.request("/api/sync/docs/manifests");
  }

  async missingBlobs(hashes: string[]): Promise<string[]> {
    return this.request<string[]>("/api/sync/blobs/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hashes }),
    });
  }

  async downloadBlob(hash: string): Promise<Uint8Array | null> {
    const response = await this.fetch(`${this.serverUrl}/api/sync/blobs/${encodeURIComponent(hash)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetch(`${this.serverUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${this.token}`,
      },
    });
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    return (await response.json()) as T;
  }
}
