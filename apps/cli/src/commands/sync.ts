import {
  beginSyncRun,
  createKeyWrapper,
  finalizeSyncRun,
  openTraceStore,
  resolveAutoSyncEnabled,
  resolveConfiguredServerUrl,
  resolveDatabasePath,
  synchronize,
  type SyncPayload,
  type SyncBlob,
  type SyncDocManifest,
  type SyncTransport,
  type SyncWrappedKey,
} from "@trace/core";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/**
 * Marks a `trace sync` process as one Trace started on the user's behalf rather
 * than one the user typed. Set on the spawned child by
 * {@link requestAutomaticSync}, read back by {@link runSyncCommand} as the
 * execution half of the AutoSync policy: a job queued before the user turned
 * AutoSync off must still refuse to touch the network when it finally runs. A
 * separate process means an in-memory flag would not survive the handoff, so
 * the marker travels in the child's environment.
 */
export const AUTOMATIC_SYNC_ENV_VAR = "TRACE_AUTOMATIC_SYNC";

/**
 * The one entry point for *implicit* task-data synchronization — task
 * mutations, task binding, board startup/focus, and the periodic board timer
 * all come through here. It starts an isolated sync process without adding
 * latency to the calling command, and it is the scheduling half of the AutoSync
 * policy: with `auto-sync` off, nothing is spawned at all. Explicit `trace
 * sync` deliberately does not route through this function, so no caller can
 * bypass the policy by reaching for a lower-level sync helper.
 */
export function requestAutomaticSync(
  env: Env,
  dependencies: {
    spawn?: BackgroundSpawn;
    executable?: string;
  } = {},
): void {
  if (!resolveAutoSyncEnabled(env)) return;
  if (!readAuthToken(env)) return;
  const executable = dependencies.executable ?? process.argv[1];
  if (!executable) return;

  try {
    const child = (dependencies.spawn ?? nodeSpawn)(
      process.execPath,
      [executable, "sync"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...env, [AUTOMATIC_SYNC_ENV_VAR]: "1" },
      },
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
  // The execution half of the AutoSync policy. This process was spawned on the
  // user's behalf, possibly seconds before they turned AutoSync off — so the
  // policy is re-read here, at the last moment before any network work. Silent
  // and status-neutral: a refused run is not a sync outcome, so it must not
  // overwrite what the board is showing.
  if (env[AUTOMATIC_SYNC_ENV_VAR] === "1" && !resolveAutoSyncEnabled(env)) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

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
  // Claim the run before the first network call so a board polling mid-sync
  // sees a spinner rather than the previous outcome. The id is what lets a slow
  // run recognise that a newer one has taken over, and refuse to finalize.
  const runId = randomUUID();
  recordSyncStatus(databasePath, (path) =>
    beginSyncRun(path, { id: runId, startedAt: new Date().toISOString() }),
  );
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
    recordSyncStatus(databasePath, (path) =>
      finalizeSyncRun(path, runId, {
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      }),
    );
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
    recordSyncStatus(databasePath, (path) =>
      finalizeSyncRun(path, runId, { lastError: message }),
    );
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
 * Persist part of a sync's lifecycle for the board's status header.
 * Best-effort: a write failure here must never change the command's own exit
 * code or output.
 */
function recordSyncStatus(
  databasePath: string,
  write: (databasePath: string) => void,
): void {
  try {
    write(databasePath);
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
