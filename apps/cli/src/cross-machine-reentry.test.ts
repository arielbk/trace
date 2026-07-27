import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  compareSyncRows,
  openTraceStore,
  resolveTaskDocsDir,
  type SyncDocManifest,
  type SyncPayload,
} from "@trace/core";
import type { Env } from "./commands/seam.ts";
import { runSyncCommand } from "./commands/sync.ts";

// A faithful in-process stand-in for the hosted sync server: one user,
// last-write-wins task/session rows and per-task doc manifests, and
// content-addressed blobs — the same contract `apps/server` implements and
// tests in isolation. It is bearer-gated so the exercised path also proves the
// CLI sends its token. Routed into the real `trace sync` command through an
// injected fetch, so both "machines" drive the genuine sync engine, transport,
// and document materialisation end to end.
class FakeSyncServer {
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

// A simulated machine: its own HOME (so its own ~/.trace/auth.json), Trace
// database, and docs tree, all under a shared temp root. Both machines carry
// the same bearer token — single-user cloud sync — so they share server state.
function setupMachine(root: string, name: string, token: string) {
  const home = join(root, name, "home");
  mkdirSync(join(home, ".trace"), { recursive: true });
  writeFileSync(join(home, ".trace", "auth.json"), JSON.stringify({ accessToken: token }));
  writeFileSync(
    join(home, ".trace", "key.json"),
    JSON.stringify({ masterKey: "12".repeat(32) }),
  );
  const db = join(root, name, "trace.sqlite");
  const env: Env = { HOME: home, TRACE_DB: db, TRACE_SERVER_URL: "https://sync.test" };
  return { home, db, env };
}

test("a handoff on machine A re-enters on machine B with state.md, docs, and A's session pointer", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-cross-machine-"));
  const server = new FakeSyncServer("shared-token");
  const machineA = setupMachine(root, "a", "shared-token");
  const machineB = setupMachine(root, "b", "shared-token");

  try {
    // --- Machine A: bind a session to a task and hand off ---
    const storeA = openTraceStore(machineA.db);
    const task = storeA.createTask("Ship cross-machine reentry");
    // The transcript lives under A's home — it will not exist on B, so B must
    // fail soft rather than choke when it surfaces the session.
    const transcriptOnA = join(machineA.home, ".claude", "projects", "session-a.jsonl");
    storeA.registerSession({
      id: "session-a",
      transcriptPath: transcriptOnA,
      tool: "claude",
      title: "Machine A work",
    });
    storeA.assignSession("session-a", task.id);
    const { id: taskId, slug } = task;
    storeA.close();

    const docsA = resolveTaskDocsDir(machineA.db, slug);
    mkdirSync(docsA, { recursive: true });
    writeFileSync(
      join(docsA, "state.md"),
      "# Ship cross-machine reentry\n\nHalfway through wiring sync.\n",
    );
    writeFileSync(
      join(docsA, "plan.md"),
      "# Plan\n\n1. sync up\n2. re-enter on the laptop\n",
    );

    // --- trace sync on both machines, one user, one server ---
    const pushed = await runSyncCommand(machineA.env, { fetch: server.fetch });
    expect(pushed.exitCode).toBe(0);
    const pulled = await runSyncCommand(machineB.env, { fetch: server.fetch });
    expect(pulled.exitCode).toBe(0);

    // Docs materialise on B under B's own docs tree.
    const docsB = resolveTaskDocsDir(machineB.db, slug);
    expect(readFileSync(join(docsB, "state.md"), "utf8")).toContain(
      "Halfway through wiring sync",
    );
    expect(readFileSync(join(docsB, "plan.md"), "utf8")).toContain(
      "re-enter on the laptop",
    );

    // --- Re-entry manifest on B carries the synced state.md, docs, and session ---
    const storeB = openTraceStore(machineB.db);
    const manifest = storeB.getReEntryManifest(taskId);
    expect(manifest).not.toBeNull();
    expect(manifest!.task.title).toBe("Ship cross-machine reentry");
    expect(manifest!.taskDocsDir).toBe(docsB);
    expect(manifest!.state?.path).toBe(join(docsB, "state.md"));
    expect(manifest!.docs.map((doc) => basename(doc.path))).toEqual(["plan.md"]);
    expect(manifest!.sessions).toHaveLength(1);
    expect(manifest!.sessions[0]).toMatchObject({
      id: "session-a",
      tool: "claude",
      transcriptPath: transcriptOnA,
      isMostRecent: true,
    });
    storeB.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign transcript locator on machine B fails soft instead of throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-cross-machine-softfail-"));
  const server = new FakeSyncServer("shared-token");
  const machineA = setupMachine(root, "a", "shared-token");
  const machineB = setupMachine(root, "b", "shared-token");

  try {
    const storeA = openTraceStore(machineA.db);
    const task = storeA.createTask("Foreign transcript task");
    storeA.registerSession({
      id: "session-a",
      // A path that exists on neither machine — the transcript layer must swallow
      // the missing file rather than propagate an error into the board read.
      transcriptPath: join(machineA.home, ".claude", "projects", "gone.jsonl"),
      tool: "claude",
    });
    storeA.assignSession("session-a", task.id);
    const { id: taskId } = task;
    storeA.close();

    await runSyncCommand(machineA.env, { fetch: server.fetch });
    await runSyncCommand(machineB.env, { fetch: server.fetch });

    const storeB = openTraceStore(machineB.db);
    // A board read composes the timeline, which refreshes each session from its
    // transcript. The foreign locator must not throw.
    const timeline = storeB.getTaskTimeline(taskId);
    expect(timeline).not.toBeNull();
    const sessionItems = timeline!.items.filter((item) => item.type === "session");
    expect(sessionItems).toHaveLength(1);
    // With no readable transcript, token totals stay at zero rather than erroring.
    expect(timeline!.tokenTotals.totalTokens).toBe(0);

    // A second sync on B is a no-op: no doc blobs to download, files unchanged.
    const resync = await runSyncCommand(machineB.env, { fetch: server.fetch });
    expect(resync.exitCode).toBe(0);
    storeB.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
