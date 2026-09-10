import {
  compareSyncRows,
  type SyncDocManifest,
  type SyncPayload,
} from "@trace/core";

/**
 * Test-only. Not reachable from `trace.ts`, so it is never bundled.
 *
 * Shared by the tests that need two machines talking to one cloud: the
 * cross-machine re-entry walkthrough and the second-machine restore journey.
 */

// A faithful in-process stand-in for the hosted sync server: one user,
// last-write-wins task/session rows and per-task doc manifests, and
// content-addressed blobs — the same contract `apps/server` implements and
// tests in isolation. It is bearer-gated so the exercised path also proves the
// CLI sends its token. Routed into the real `eqnx sync` command through an
// injected fetch, so both "machines" drive the genuine sync engine, transport,
// and document materialisation end to end.
export class FakeSyncServer {
  readonly #token: string;
  #rows: SyncPayload = { tasks: [], sessions: [] };
  #manifests: SyncDocManifest[] = [];
  readonly #wrappedKeys = new Map<string, string>();
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(token: string) {
    this.#token = token;
  }

  get fetch(): typeof globalThis.fetch {
    return ((input: string | URL | Request, init?: RequestInit) =>
      this.#handle(String(input), init)) as typeof globalThis.fetch;
  }

  async #handle(url: string, init?: RequestInit): Promise<Response> {
    const { pathname } = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${this.#token}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const body = (): unknown => JSON.parse(String(init?.body ?? "null"));

    if (pathname === "/api/sync/push") {
      return Response.json({ accepted: this.#pushRows(body() as SyncPayload) });
    }
    if (pathname === "/api/sync/pull") {
      return Response.json(structuredClone(this.#rows));
    }
    if (pathname === "/api/sync/docs/push") {
      const payload = body() as {
        manifests: SyncDocManifest[];
        blobs: { hash: string; content: string }[];
        wrappedKeys?: { taskId: string; wrappedKey: string }[];
      };
      return Response.json(
        this.#pushDocuments(payload.manifests, payload.blobs, payload.wrappedKeys ?? []),
      );
    }
    if (pathname === "/api/sync/docs/manifests") {
      return Response.json({
        manifests: structuredClone(this.#manifests),
        wrappedKeys: [...this.#wrappedKeys].map(([taskId, wrappedKey]) => ({
          taskId,
          wrappedKey,
        })),
      });
    }
    if (pathname === "/api/sync/blobs/missing") {
      const { hashes } = body() as { hashes: string[] };
      return Response.json(hashes.filter((hash) => !this.#blobs.has(hash)));
    }
    if (pathname.startsWith("/api/sync/blobs/") && method === "GET") {
      const hash = decodeURIComponent(pathname.slice("/api/sync/blobs/".length));
      const blob = this.#blobs.get(hash);
      if (!blob) return Response.json({ error: "not found" }, { status: 404 });
      return new Response(blob.slice());
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  #pushRows(payload: SyncPayload): number {
    let accepted = 0;
    for (const kind of ["tasks", "sessions"] as const) {
      for (const row of payload[kind]) {
        const index = this.#rows[kind].findIndex((candidate) => candidate.id === row.id);
        if (index < 0) {
          (this.#rows[kind] as (typeof row)[]).push(structuredClone(row));
          accepted += 1;
        } else if (compareSyncRows(row, this.#rows[kind][index]!) > 0) {
          (this.#rows[kind] as (typeof row)[])[index] = structuredClone(row);
          accepted += 1;
        }
      }
    }
    return accepted;
  }

  #pushDocuments(
    manifests: SyncDocManifest[],
    blobs: { hash: string; content: string }[],
    wrappedKeys: { taskId: string; wrappedKey: string }[],
  ): { accepted: number; uploaded: number } {
    let accepted = 0;
    for (const manifest of manifests) {
      const index = this.#manifests.findIndex((item) => item.taskId === manifest.taskId);
      if (index < 0) {
        this.#manifests.push(structuredClone(manifest));
        accepted += 1;
      } else if (compareSyncRows(manifest, this.#manifests[index]!) > 0) {
        this.#manifests[index] = structuredClone(manifest);
        accepted += 1;
      }
    }
    for (const { taskId, wrappedKey } of wrappedKeys) {
      this.#wrappedKeys.set(taskId, wrappedKey);
    }
    let uploaded = 0;
    for (const blob of blobs) {
      if (!this.#blobs.has(blob.hash)) {
        this.#blobs.set(blob.hash, Buffer.from(blob.content, "base64"));
        uploaded += 1;
      }
    }
    return { accepted, uploaded };
  }
}

/**
 * The hosted account half of the same server: RFC 8628 device authorization,
 * a token endpoint that stays pending until {@link FakeCloud.approve}, the
 * account's document manifests, and its session identity.
 *
 * Composed with {@link FakeSyncServer} rather than folded into it, because the
 * sync half is bearer-gated on a token this half is what issues.
 */
export class FakeCloud {
  readonly url = "https://cloud.test";
  readonly #sync: FakeSyncServer;
  readonly #token: string;
  readonly #user: { id: string; name?: string; email?: string };
  #approved = false;

  constructor(options: {
    token: string;
    user: { id: string; name?: string; email?: string };
  }) {
    this.#token = options.token;
    this.#user = options.user;
    this.#sync = new FakeSyncServer(options.token);
  }

  approve(): void {
    this.#approved = true;
  }

  get fetch(): typeof globalThis.fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const { pathname } = new URL(url);
      if (pathname === "/api/auth/device/code") {
        return Promise.resolve(
          Response.json({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: `${this.url}/device`,
            verification_uri_complete: `${this.url}/device?user_code=ABCD-EFGH`,
            interval: 0,
            expires_in: 3_600,
          }),
        );
      }
      if (pathname === "/api/auth/device/token") {
        return Promise.resolve(
          this.#approved
            ? Response.json({ access_token: this.#token })
            : Response.json({ error: "authorization_pending" }, { status: 400 }),
        );
      }
      if (pathname === "/api/auth/get-session") {
        return Promise.resolve(Response.json({ user: this.#user }));
      }
      return this.#sync.fetch(input, init);
    }) as typeof globalThis.fetch;
  }
}
