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

  /**
   * Everything the server is holding, as one string — rows, manifests, and the
   * raw blob bytes. This is the seam for "the cloud never sees a plaintext
   * document": what the server stores, read the way an operator with the
   * database in front of them would read it.
   */
  get stored(): string {
    return [
      JSON.stringify(this.#rows),
      JSON.stringify(this.#manifests),
      ...[...this.#blobs.values()].map((blob) => Buffer.from(blob).toString("latin1")),
    ].join("\n");
  }

  async #handle(url: string, init?: RequestInit): Promise<Response> {
    const { pathname } = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${this.#token}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (pathname === "/api/auth/get-session") return Response.json({ user: { id: "fixture-user" } });
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
 * The key-transfer relay half: `pending → offered → revealed → approved →
 * claimed`, with denial, cancellation and expiry from any unfinished state.
 *
 * A faithful stand-in for `apps/cloud`'s handlers, kept deliberately literal
 * about the two properties the protocol leans on — an accepted offer or reveal
 * is immutable, and an identical retry returns the same state rather than
 * starting a second exchange. It knows nothing about keys beyond carrying
 * them, which is the point: the relay is the adversary these tests assume.
 */
class FakeKeyTransferRelay {
  static readonly LIFETIME_MS = 10 * 60 * 1000;
  /** How many requests one account may create inside a lifetime window. */
  static readonly CREATION_LIMIT = 5;
  readonly #rows = new Map<string, Record<string, unknown>>();
  readonly #accountId: string;
  #now: () => Date = () => new Date();

  constructor(accountId: string) {
    this.#accountId = accountId;
  }

  /** Drive the relay's clock from the test, so expiry is exercised without
   * waiting ten minutes for it. */
  set clock(now: () => Date) {
    this.#now = now;
  }

  handle(pathname: string, method: string, body: unknown): Response {
    const rest = pathname.slice("/api/key-transfer".length).replace(/^\//, "");
    const now = this.#now();
    if (rest === "" && method === "GET") {
      return Response.json(
        [...this.#rows.values()]
          .map((row) => this.#present(row, now))
          .filter((row) => row.state === "pending"),
      );
    }
    if (rest === "" && method === "POST") return this.#create(body, now);

    const [id, action] = rest.split("/");
    if (!id) return Response.json({ error: "not found" }, { status: 404 });
    const row = this.#rows.get(id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    if (!action) {
      return method === "GET"
        ? Response.json(this.#present(row, now))
        : Response.json({ error: "not found" }, { status: 404 });
    }
    return this.#transition(row, action, body, now);
  }

  #create(body: unknown, now: Date): Response {
    const draft = body as Record<string, unknown>;
    const expiresAt = Date.parse(String(draft?.expiresAt));
    if (
      draft?.protocolVersion !== 1 ||
      typeof draft.requestId !== "string" ||
      typeof draft.commitment !== "string" ||
      typeof draft.machineName !== "string" ||
      !draft.machineName.trim() ||
      Number.isNaN(expiresAt) ||
      expiresAt <= now.getTime() ||
      expiresAt > now.getTime() + FakeKeyTransferRelay.LIFETIME_MS
    ) {
      return Response.json(
        { error: "invalid request or unsupported protocol" },
        { status: 400 },
      );
    }
    if (this.#rows.has(draft.requestId)) {
      return Response.json({ error: "request already exists" }, { status: 409 });
    }
    // The real relay bounds creation over the request lifetime rather than
    // over what is still live: a cancelled or already-claimed request keeps
    // its slot until it expires. Measured against the deployed handlers, and
    // copied here so a client test can reach the refusal at all.
    for (const [id, existing] of this.#rows) {
      if (Date.parse(String(existing.expiresAt)) <= now.getTime()) this.#rows.delete(id);
    }
    if (this.#rows.size >= FakeKeyTransferRelay.CREATION_LIMIT) {
      return Response.json(
        {
          error:
            "Too many key-transfer requests. Wait for the current ten-minute window to expire.",
        },
        { status: 429, headers: { "retry-after": "600" } },
      );
    }
    const row: Record<string, unknown> = {
      requestId: draft.requestId,
      accountId: this.#accountId,
      commitment: draft.commitment,
      serviceOrigin: draft.serviceOrigin,
      machineName: draft.machineName,
      protocolVersion: 1,
      state: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.#rows.set(draft.requestId, row);
    return Response.json(this.#present(row, now), { status: 201 });
  }

  #transition(
    row: Record<string, unknown>,
    action: string,
    body: unknown,
    now: Date,
  ): Response {
    const fields = (body ?? {}) as Record<string, unknown>;
    const state = String(this.#present(row, now).state);
    if (state === "expired") return Response.json({ error: "expired" }, { status: 410 });
    const ok = () => Response.json(this.#present(row, now));
    const conflict = () =>
      Response.json({ error: "conflict", state }, { status: 409 });

    if (action === "offer") {
      if (["offered", "revealed", "approved"].includes(state)) {
        return row.senderPublicKey === fields.senderPublicKey ? ok() : conflict();
      }
      if (state !== "pending") return conflict();
      row.senderPublicKey = fields.senderPublicKey;
      row.state = "offered";
      return ok();
    }
    if (action === "reveal") {
      if (["revealed", "approved"].includes(state)) {
        return row.recipientPublicKey === fields.recipientPublicKey
          ? ok()
          : conflict();
      }
      if (state !== "offered") return conflict();
      row.recipientPublicKey = fields.recipientPublicKey;
      row.state = "revealed";
      return ok();
    }
    if (action === "approve") {
      if (state === "approved") {
        return row.ciphertext === fields.ciphertext ? ok() : conflict();
      }
      if (state !== "revealed" || row.senderPublicKey !== fields.senderPublicKey) {
        return conflict();
      }
      row.ciphertext = fields.ciphertext;
      row.state = "approved";
      return ok();
    }
    const settled =
      action === "claim" ? "claimed" : action === "cancel" ? "cancelled" : "denied";
    if (!["claim", "cancel", "deny"].includes(action)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (state === settled) return ok();
    if (
      action === "claim"
        ? state !== "approved"
        : !["pending", "offered", "revealed", "approved"].includes(state)
    ) {
      return conflict();
    }
    row.state = settled;
    delete row.ciphertext;
    return ok();
  }

  /** Expiry is presentational until something acts on the row, exactly as the
   * server computes it: a stored state plus this machine's clock. */
  #present(row: Record<string, unknown>, now: Date): Record<string, unknown> {
    const open = ["pending", "offered", "revealed", "approved"];
    const state =
      open.includes(String(row.state)) &&
      Date.parse(String(row.expiresAt)) <= now.getTime()
        ? "expired"
        : row.state;
    const { ciphertext, ...rest } = row;
    return {
      ...rest,
      state,
      ...(state === "approved" && ciphertext
        ? { envelope: { senderPublicKey: row.senderPublicKey, ciphertext } }
        : {}),
    };
  }
}

/**
 * The hosted account half of the same server: RFC 8628 device authorization,
 * a token endpoint that stays pending until {@link FakeCloud.approve}, the
 * account's document manifests, its session identity, and the key-transfer
 * relay.
 *
 * Composed with {@link FakeSyncServer} rather than folded into it, because the
 * sync half is bearer-gated on a token this half is what issues.
 */
export class FakeCloud {
  readonly url = "https://cloud.test";
  readonly #sync: FakeSyncServer;
  readonly #token: string;
  readonly #user: { id: string; name?: string; email?: string };
  readonly #transfers: FakeKeyTransferRelay;
  #approved = false;

  constructor(options: {
    token: string;
    user: { id: string; name?: string; email?: string };
  }) {
    this.#token = options.token;
    this.#user = options.user;
    this.#sync = new FakeSyncServer(options.token);
    this.#transfers = new FakeKeyTransferRelay(options.user.id);
  }

  approve(): void {
    this.#approved = true;
  }

  /** Everything the sync half is holding — see {@link FakeSyncServer.stored}. */
  get stored(): string {
    return this.#sync.stored;
  }

  /** Point the transfer relay's expiry arithmetic at a test-controlled clock. */
  set transferClock(now: () => Date) {
    this.#transfers.clock = now;
  }

  get fetch(): typeof globalThis.fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const { pathname } = new URL(url);
      if (pathname.startsWith("/api/key-transfer")) {
        if (
          new Headers(init?.headers).get("authorization") !== `Bearer ${this.#token}`
        ) {
          return Promise.resolve(
            Response.json({ error: "unauthorized" }, { status: 401 }),
          );
        }
        const raw = init?.body === undefined ? undefined : String(init.body);
        return Promise.resolve(
          this.#transfers.handle(
            pathname,
            (init?.method ?? "GET").toUpperCase(),
            raw === undefined ? undefined : JSON.parse(raw),
          ),
        );
      }
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
