import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  generateTaskKey,
  openTraceStore,
  readSyncIdentity,
  resolveTaskDocsDir,
} from "@trace/core";
import { updateAutomaticSyncState } from "./commands/automatic-sync-policy.ts";
import { requestAutomaticSync, runSyncCommand } from "./commands/sync.ts";
import { createLocalAuthService } from "./local-auth.ts";
import { createServeRequestListener } from "./serve.ts";
import { openConnectionCredentials } from "./connection-credentials.ts";
import { FakeCloud } from "./fake-sync-server.ts";
import type { Env } from "./commands/seam.ts";

/**
 * The second-machine restore journey, driven the way it actually happens: a
 * browser on the hosted origin talking to machine B's own local EQNX over the
 * loopback API, with a real sync server standing between B and machine A.
 *
 * Every request in these tests carries the hosted `Origin` and a paired browser
 * credential, so the cross-origin allowlist, the bearer check, the capability
 * handshake, and the account/key checks are all on the exercised path.
 */

const HOSTED_ORIGIN = "https://board.test";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trace-second-machine-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A machine: its own HOME, database, docs tree, and config. */
function machine(name: string, cloudUrl: string): { home: string; db: string; env: Env } {
  const home = join(root, name, "home");
  mkdirSync(join(home, ".trace"), { recursive: true });
  const db = join(root, name, "trace.sqlite");
  return { home, db, env: { HOME: home, TRACE_DB: db, TRACE_SERVER_URL: cloudUrl } };
}

/** Sign a machine in the way an already-established machine is: token and key
 * on disk, no login flow. This is machine A's starting state. */
function signInDirectly(m: { home: string }, token: string, masterKey: string): void {
  writeFileSync(
    join(m.home, ".trace", "auth.json"),
    JSON.stringify({ accessToken: token }),
  );
  writeFileSync(
    join(m.home, ".trace", "key.json"),
    JSON.stringify({ masterKey }),
  );
}

type Captured = { status: number; headers: Record<string, string>; body: string };

/** A hosted board pointed at one machine's local EQNX. */
function hostedBoard(
  m: { home: string; db: string; env: Env },
  cloud: FakeCloud,
): {
  request: (method: string, path: string, body?: string) => Promise<Captured>;
  syncs: Promise<unknown>[];
} {
  const syncs: Promise<unknown>[] = [];
  const connection = openConnectionCredentials({ HOME: m.home });
  const { token } = connection.issueBrowserToken("Test browser");
  const listener = createServeRequestListener(
    m.db,
    undefined,
    true,
    undefined,
    undefined,
    createLocalAuthService(m.env, {
      fetch: cloud.fetch,
      sleep: async () => undefined,
      // The real login-complete trigger: a machine that just signed in has
      // documents waiting for it and must not sit out the periodic interval.
      onLoginComplete: () => {
        requestAutomaticSync(m.env, {
          reason: "login",
          executable: "eqnx",
          spawn: (_command, _args, options) => {
            syncs.push(runSyncCommand(options.env as Env, { fetch: cloud.fetch }));
            return { on: () => {}, unref: () => {} };
          },
        });
      },
    }),
    HOSTED_ORIGIN,
    connection,
  );

  const request = (method: string, path: string, body?: string): Promise<Captured> =>
    new Promise((resolve) => {
      const captured: Captured = { status: 200, headers: {}, body: "" };
      const res = {
        set statusCode(value: number) {
          captured.status = value;
        },
        get statusCode() {
          return captured.status;
        },
        setHeader(name: string, value: string) {
          captured.headers[name.toLowerCase()] = value;
        },
        end(chunk?: Buffer | string) {
          captured.body = chunk === undefined ? "" : chunk.toString("utf8");
          resolve(captured);
        },
      } as unknown as ServerResponse;

      const req = Object.assign(new EventEmitter(), {
        method,
        url: path,
        headers: {
          host: "127.0.0.1:4317",
          origin: HOSTED_ORIGIN,
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      }) as unknown as IncomingMessage;
      listener(req, res);
      if (method === "POST") {
        if (body !== undefined) req.emit("data", Buffer.from(body));
        req.emit("end");
      }
    });

  return { request, syncs };
}

type AttemptView = { attemptId: string; state: string; error?: string; identity?: string };

/** Poll the attempt through the hosted API until it settles on `state`. */
async function waitForState(
  board: { request: (method: string, path: string, body?: string) => Promise<Captured> },
  attemptId: string,
  state: string,
): Promise<AttemptView> {
  for (let poll = 0; poll < 500; poll += 1) {
    const response = await board.request("GET", `/api/local-auth/login/${attemptId}`);
    expect(response.status).toBe(200);
    const attempt = JSON.parse(response.body) as AttemptView;
    if (attempt.state === state) return attempt;
  }
  throw new Error(`login attempt never reached ${state}`);
}

/** Machine A with one task and one document, already synced to the cloud. */
async function machineAWithSyncedWork(
  cloud: FakeCloud,
  token: string,
  masterKey: string,
): Promise<{ slug: string; taskId: string }> {
  const a = machine("a", cloud.url);
  signInDirectly(a, token, masterKey);
  const store = openTraceStore(a.db);
  const task = store.createTask("Ship the second machine");
  store.close();

  const docs = resolveTaskDocsDir(a.db, task.slug);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "state.md"), "# Ship it\n\nA wrote this.\n");

  expect((await runSyncCommand(a.env, { fetch: cloud.fetch })).exitCode).toBe(0);
  return { slug: task.slug, taskId: task.id };
}

test("a second machine signs in from the hosted board and reads machine A's work", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", name: "The Octocat", email: "octocat@github.com" },
  });
  const { slug } = await machineAWithSyncedWork(cloud, "cloud-token", masterKey);

  const b = machine("b", cloud.url);
  // A recent attempt must not delay recovery after this login.
  updateAutomaticSyncState(b.db, { lastRequestedAt: new Date().toISOString() });
  const board = hostedBoard(b, cloud);

  // Nothing of A's is here yet, and B is signed out.
  expect(
    JSON.parse((await board.request("GET", "/api/sync/status")).body),
  ).toMatchObject({ state: "logged-out" });
  expect(JSON.parse((await board.request("GET", "/api/tasks")).body)).toEqual([]);

  const started = JSON.parse(
    (
      await board.request(
        "POST",
        "/api/local-auth/login",
        JSON.stringify({ provider: "github" }),
      )
    ).body,
  ) as AttemptView;
  cloud.approve();

  // The account holds documents, so B stops for the recovery key rather than
  // signing in half-way.
  await waitForState(board, started.attemptId, "waiting-for-existing-key");

  const settled = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${started.attemptId}/existing-key`,
        JSON.stringify({ key: masterKey }),
      )
    ).body,
  ) as AttemptView;
  expect(settled.state).toBe("complete");
  expect(settled.identity).toBe("The Octocat <octocat@github.com>");
  // The key the user typed never comes back out of the local service.
  expect(JSON.stringify(settled)).not.toContain(masterKey);

  // The login-complete trigger is what brings the work over.
  await Promise.all(board.syncs);

  const tasks = JSON.parse((await board.request("GET", "/api/tasks")).body) as {
    title: string;
  }[];
  expect(tasks.map((task) => task.title)).toEqual(["Ship the second machine"]);

  const doc = await board.request("GET", `/api/tasks/${slug}/docs?path=state.md`);
  expect(doc.status).toBe(200);
  expect(doc.body).toContain("A wrote this.");

  // And the store now knows whose work it is holding.
  expect(readSyncIdentity(b.db)).toMatchObject({
    serverUrl: cloud.url,
    accountId: "octocat",
  });
});

test("a wrong recovery key leaves the second machine exactly as it was", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  await machineAWithSyncedWork(cloud, "cloud-token", masterKey);

  const b = machine("b", cloud.url);
  const board = hostedBoard(b, cloud);
  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  await waitForState(board, started.attemptId, "waiting-for-existing-key");

  const refused = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${started.attemptId}/existing-key`,
        JSON.stringify({ key: generateTaskKey() }),
      )
    ).body,
  ) as AttemptView;

  expect(refused.state).toBe("waiting-for-existing-key");
  expect(refused.error).toMatch(/could not decrypt/i);
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(false);
  expect(readSyncIdentity(b.db)).toBeNull();
  expect(board.syncs).toHaveLength(0);
  expect(JSON.parse((await board.request("GET", "/api/tasks")).body)).toEqual([]);
});

test("a cancelled sign-in on the second machine stores nothing and syncs nothing", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  await machineAWithSyncedWork(cloud, "cloud-token", masterKey);

  const b = machine("b", cloud.url);
  const board = hostedBoard(b, cloud);
  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  await waitForState(board, started.attemptId, "waiting-for-existing-key");

  const cancelled = JSON.parse(
    (await board.request("POST", `/api/local-auth/login/${started.attemptId}/cancel`))
      .body,
  ) as AttemptView;

  expect(cancelled.state).toBe("cancelled");
  // Even the right key is refused once the attempt is settled.
  const afterwards = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${started.attemptId}/existing-key`,
        JSON.stringify({ key: masterKey }),
      )
    ).body,
  ) as AttemptView;
  expect(afterwards.state).toBe("cancelled");
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(board.syncs).toHaveLength(0);
});

test("the hosted board cannot reach the second machine's key replacement or local management", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const b = machine("b", cloud.url);
  const board = hostedBoard(b, cloud);

  for (const path of [
    "/api/local-auth/login/any/replacement-key",
    "/api/local-auth/login/any/acknowledge-key",
    "/api/management/pairings",
  ]) {
    expect([path, (await board.request("POST", path, "{}")).status]).toEqual([
      path,
      403,
    ]);
  }
});

test("an unpaired browser on the hosted origin cannot start a sign-in at all", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const b = machine("b", cloud.url);
  const connection = openConnectionCredentials({ HOME: b.home });
  const listener = createServeRequestListener(
    b.db,
    undefined,
    true,
    undefined,
    undefined,
    createLocalAuthService(b.env, { fetch: cloud.fetch, sleep: async () => undefined }),
    HOSTED_ORIGIN,
    connection,
  );

  const status = await new Promise<number>((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end() {
        resolve((res as { statusCode: number }).statusCode);
      },
    } as unknown as ServerResponse;
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/api/local-auth/login",
      headers: { host: "127.0.0.1:4317", origin: HOSTED_ORIGIN },
    }) as unknown as IncomingMessage;
    listener(req, res);
    req.emit("end");
  });

  expect(status).toBe(401);
});

test("a cloud that answers with nonsense leaves the second machine untouched", async () => {
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  const b = machine("b", cloud.url);
  // Everything the account flow needs answers normally except the one call that
  // says what the account holds, which comes back as something else entirely.
  const garbled = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/api/sync/docs/manifests")
      ? Promise.resolve(Response.json({ manifests: "everything" }))
      : cloud.fetch(input, init)) as typeof globalThis.fetch;
  const board = hostedBoard(b, { ...cloud, fetch: garbled } as unknown as FakeCloud);

  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  const attempt = await waitForState(board, started.attemptId, "failed");

  expect(attempt.error).toMatch(/invalid document manifest/i);
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(false);
  expect(readSyncIdentity(b.db)).toBeNull();
  expect(board.syncs).toHaveLength(0);
});

test("only the paired hosted origin may drive the restore routes", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const b = machine("b", cloud.url);
  const connection = openConnectionCredentials({ HOME: b.home });
  const { token } = connection.issueBrowserToken("Test browser");
  const listener = createServeRequestListener(
    b.db,
    undefined,
    true,
    undefined,
    undefined,
    createLocalAuthService(b.env, { fetch: cloud.fetch, sleep: async () => undefined }),
    HOSTED_ORIGIN,
    connection,
  );

  const fromOrigin = (origin: string): Promise<number> =>
    new Promise((resolve) => {
      const captured = { status: 200 };
      const res = {
        set statusCode(value: number) {
          captured.status = value;
        },
        get statusCode() {
          return captured.status;
        },
        setHeader() {},
        end() {
          resolve(captured.status);
        },
      } as unknown as ServerResponse;
      const req = Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/api/local-auth/login",
        headers: {
          host: "127.0.0.1:4317",
          origin,
          authorization: `Bearer ${token}`,
        },
      }) as unknown as IncomingMessage;
      listener(req, res);
      req.emit("end");
    });

  expect(await fromOrigin(`${HOSTED_ORIGIN}.attacker.test`)).toBe(403);
  expect(await fromOrigin("https://attacker.test")).toBe(403);
});

test("a revoked browser loses the restore routes on its very next request", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const b = machine("b", cloud.url);
  const board = hostedBoard(b, cloud);

  expect((await board.request("GET", "/api/sync/status")).status).toBe(200);
  openConnectionCredentials({ HOME: b.home }).reset();

  expect((await board.request("GET", "/api/sync/status")).status).toBe(401);
  expect(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).status,
  ).toBe(401);
});

test("a cloud that will not say who signed in signs nobody in", async () => {
  // The dangerous shape: this store already belongs to one account and holds
  // its key, and the machine is signed into another whose session read fails.
  // Treating "no answer" as "no account to compare" would let the two meet.
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  await machineAWithSyncedWork(cloud, "cloud-token", masterKey);

  const b = machine("b", cloud.url);
  signInDirectly(b, "stale-token", masterKey);
  writeFileSync(
    join(root, "b", "sync-identity.json"),
    JSON.stringify({ serverUrl: cloud.url, accountId: "octocat" }),
  );
  const silent = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/api/auth/get-session")
      ? Promise.resolve(Response.json({ error: "boom" }, { status: 500 }))
      : cloud.fetch(input, init)) as typeof globalThis.fetch;
  const board = hostedBoard(b, { ...cloud, fetch: silent } as unknown as FakeCloud);

  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  const attempt = await waitForState(board, started.attemptId, "failed");

  expect(attempt.error).toMatch(/could not confirm which account/i);
  expect(board.syncs).toHaveLength(0);
  // The credentials that were already here are the ones that are still here.
  expect(
    JSON.parse(readFileSync(join(b.home, ".trace", "auth.json"), "utf8")),
  ).toEqual({ accessToken: "stale-token" });
  expect(readSyncIdentity(b.db)).toMatchObject({ accountId: "octocat" });
});

test("a cloud that names the account only by something it can change is refused", async () => {
  // An email is a label, not an identity: a server that lets one be moved
  // between accounts would move this store's binding with it.
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  const b = machine("b", cloud.url);
  const anonymous = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/api/auth/get-session")
      ? Promise.resolve(Response.json({ user: { email: "octocat@github.com" } }))
      : cloud.fetch(input, init)) as typeof globalThis.fetch;
  const board = hostedBoard(b, { ...cloud, fetch: anonymous } as unknown as FakeCloud);

  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  const attempt = await waitForState(board, started.attemptId, "failed");

  expect(attempt.error).toMatch(/could not confirm which account/i);
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(false);
  expect(board.syncs).toHaveLength(0);
});

test("a store whose account record cannot be read refuses to sign in", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  await machineAWithSyncedWork(cloud, "cloud-token", masterKey);

  const b = machine("b", cloud.url);
  // Present but unreadable is not the same as absent: absent is a fresh
  // machine, this is a machine whose binding we cannot check.
  writeFileSync(join(root, "b", "sync-identity.json"), "{ not json");
  const board = hostedBoard(b, cloud);

  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  const attempt = await waitForState(board, started.attemptId, "failed");

  expect(attempt.error).toMatch(/account record/i);
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(board.syncs).toHaveLength(0);
});

test("a binding that cannot be written stores no credentials and no key", async () => {
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", email: "octocat@github.com" },
  });
  const b = machine("b", cloud.url);
  // Nothing can be written to this path, so the store can never be bound —
  // and an unbindable store must not be given an account's credentials.
  mkdirSync(join(root, "b", "sync-identity.json"), { recursive: true });
  writeFileSync(join(root, "b", "sync-identity.json", "occupied"), "");
  const board = hostedBoard(b, cloud);

  const started = JSON.parse(
    (await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body,
  ) as AttemptView;
  cloud.approve();
  const attempt = await waitForState(board, started.attemptId, "failed");

  expect(attempt.error).toMatch(/account record/i);
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(false);
  expect(board.syncs).toHaveLength(0);
});

test("a credential write failure restores the previous key and account binding", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const b = machine("b", cloud.url);
  mkdirSync(join(b.home, ".trace", `auth.json.${process.pid}.tmp`), { recursive: true });
  const board = hostedBoard(b, cloud);
  const started = JSON.parse((await board.request("POST", "/api/local-auth/login", JSON.stringify({}))).body) as AttemptView;
  cloud.approve();
  await waitForState(board, started.attemptId, "failed");
  expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(false);
  expect(readSyncIdentity(b.db)).toBeNull();
  expect(board.syncs).toHaveLength(0);
});

test("restore reports metadata then documents and cannot be ready before the document is readable", async () => {
  const key = generateTaskKey();
  const cloud = new FakeCloud({ token: "token", user: { id: "account" } });
  const { slug } = await machineAWithSyncedWork(cloud, "token", key);
  const b = machine("progress", cloud.url);
  signInDirectly(b, "token", key);
  const board = hostedBoard(b, cloud);
  const status = async () => JSON.parse((await board.request("GET", "/api/sync/status")).body);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/sync/pull")) {
      expect(await status()).toMatchObject({ state: "syncing", restore: { phase: "metadata" } });
      expect(existsSync(join(resolveTaskDocsDir(b.db, slug), "state.md"))).toBe(false);
    }
    if (url.includes("/api/sync/blobs/") && !url.endsWith("missing")) {
      expect(await status()).toMatchObject({ state: "syncing", restore: { phase: "documents" } });
      expect(JSON.parse((await board.request("GET", "/api/tasks")).body)).toHaveLength(1);
      expect(existsSync(join(resolveTaskDocsDir(b.db, slug), "state.md"))).toBe(false);
    }
    return cloud.fetch(input, init);
  };
  expect((await runSyncCommand(b.env, { fetch })).exitCode).toBe(0);
  expect(await status()).toMatchObject({ state: "synced", restore: { phase: "ready", taskCount: 1 } });
  expect(readFileSync(join(resolveTaskDocsDir(b.db, slug), "state.md"), "utf8")).toContain("A wrote this");
});

test("failed document download keeps tasks visible and a later retry completes recovery", async () => {
  const key = generateTaskKey();
  const cloud = new FakeCloud({ token: "token", user: { id: "account" } });
  await machineAWithSyncedWork(cloud, "token", key);
  const b = machine("failed-progress", cloud.url);
  signInDirectly(b, "token", key);
  const board = hostedBoard(b, cloud);
  const fetch: typeof globalThis.fetch = async (input, init) =>
    String(input).includes("/api/sync/blobs/") && !String(input).endsWith("missing")
      ? new Response("offline", { status: 503 }) : cloud.fetch(input, init);
  // A blob this machine cannot fetch defers the manifest rather than failing the
  // run: the rows it pulled stay, the board says documents are pending, and the
  // next sync is the retry.
  const interrupted = await runSyncCommand(b.env, { fetch });
  expect(interrupted.exitCode).toBe(0);
  expect(interrupted.stdout).toContain("not on this machine yet");
  expect(JSON.parse((await board.request("GET", "/api/sync/status")).body)).toMatchObject({ state: "synced", restore: { phase: "partial" } });
  expect(JSON.parse((await board.request("GET", "/api/tasks")).body)).toHaveLength(1);
  expect((await runSyncCommand(b.env, { fetch: cloud.fetch })).exitCode).toBe(0);
  expect(JSON.parse((await board.request("GET", "/api/sync/status")).body)).toMatchObject({ state: "synced", restore: { phase: "ready", taskCount: 1 } });
});

test("an empty account finishes restore with an observed zero local tasks", async () => {
  const cloud = new FakeCloud({ token: "token", user: { id: "account" } });
  const b = machine("empty-progress", cloud.url);
  signInDirectly(b, "token", generateTaskKey());
  expect((await runSyncCommand(b.env, { fetch: cloud.fetch })).exitCode).toBe(0);
  const board = hostedBoard(b, cloud);
  expect(JSON.parse((await board.request("GET", "/api/sync/status")).body)).toMatchObject({ state: "synced", restore: { phase: "ready", taskCount: 0 } });
});

test("an established machine's later sync is not stamped as a restore", async () => {
  const key = generateTaskKey();
  const cloud = new FakeCloud({ token: "token", user: { id: "account" } });
  await machineAWithSyncedWork(cloud, "token", key);
  const b = machine("settled", cloud.url);
  signInDirectly(b, "token", key);
  const board = hostedBoard(b, cloud);
  const status = async () =>
    JSON.parse((await board.request("GET", "/api/sync/status")).body) as {
      state: string;
      restore?: { phase: string; taskCount?: number };
    };

  // The first run is the restore, and it ends ready.
  expect((await runSyncCommand(b.env, { fetch: cloud.fetch })).exitCode).toBe(0);
  expect(await status()).toMatchObject({ restore: { phase: "ready", taskCount: 1 } });

  // The next one is just a sync: nothing is arriving that this machine does
  // not already have, so no phase is claimed while it runs.
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push((await status()).restore?.phase ?? "none");
    return cloud.fetch(input, init);
  };
  expect((await runSyncCommand(b.env, { fetch })).exitCode).toBe(0);
  expect(seen).not.toHaveLength(0);
  expect([...new Set(seen)]).toEqual(["ready"]);
  // And a machine that gains a task afterwards does not keep the old count.
  const store = openTraceStore(b.db);
  store.createTask("Written on B");
  store.close();
  expect((await runSyncCommand(b.env, { fetch: cloud.fetch })).exitCode).toBe(0);
  expect(await status()).toMatchObject({ restore: { phase: "ready", taskCount: 2 } });
});

test("hosted sign-out stops sync while preserving local work and browser pairing", async () => {
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat" },
  });
  const b = machine("logout", cloud.url);
  signInDirectly(b, "cloud-token", "retained-key");
  const store = openTraceStore(b.db);
  const task = store.createTask("Keep my local work");
  store.close();
  const board = hostedBoard(b, cloud);
  const response = await board.request("POST", "/api/local-auth/logout");
  expect(response.status).toBe(200);
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);
  expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(true);
  const tasks = await board.request("GET", "/api/tasks");
  expect(tasks.status).toBe(200);
  expect(tasks.body).toContain(task.id);
  expect(board.syncs).toHaveLength(0);
});
