import {
  openTraceStore,
  resolveDatabasePath,
  synchronize,
  type SyncPayload,
  type SyncTransport,
} from "@trace/core";
import { readAuthToken, resolveServerUrl } from "./auth.ts";
import type { CommandResult, Env } from "./seam.ts";

export async function runSyncCommand(
  env: Env,
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): Promise<CommandResult> {
  const token = readAuthToken(env);
  if (!token) {
    return { exitCode: 0, stdout: "Not logged in. Run trace login.\n", stderr: "" };
  }
  const store = openTraceStore(resolveDatabasePath(env));
  try {
    const result = await synchronize(
      store,
      new HttpSyncTransport(
        resolveServerUrl(env),
        token.accessToken,
        dependencies.fetch ?? globalThis.fetch,
      ),
    );
    return {
      exitCode: 0,
      stdout: `Sync complete: ${result.pushed} pushed, ${result.pulled} pulled.\n`,
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  } finally {
    store.close();
  }
}

class HttpSyncTransport implements SyncTransport {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

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
