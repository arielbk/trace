import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { runSyncCommand } from "./commands/sync.ts";
import { createLocalAuthService } from "./local-auth.ts";
import { createKeyTransferRelay } from "./key-transfer-relay.ts";
import { createKeyTransferApproverSession } from "./key-transfer-session.ts";
import { createServeRequestListener } from "./serve.ts";
import { openConnectionCredentials } from "./connection-credentials.ts";
import { FakeCloud } from "./fake-sync-server.ts";
import type { Env } from "./commands/seam.ts";

/**
 * The journey this slice exists for: a second machine unlocks itself through
 * the first, without the user ever typing — or seeing — the master key.
 *
 * Two local runtimes with their own HOMEs, databases and document trees, one
 * relay between them, and the real login attempt driving the real transfer
 * ceremony. What is asserted at the end is not "the protocol ran" but "B can
 * read the document A wrote".
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trace-approval-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function machine(name: string, cloudUrl: string): { home: string; db: string; env: Env } {
  const home = join(root, name, "home");
  mkdirSync(join(home, ".trace"), { recursive: true });
  const db = join(root, name, "trace.sqlite");
  return { home, db, env: { HOME: home, TRACE_DB: db, TRACE_SERVER_URL: cloudUrl } };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => resolve()));

/** Machine A: signed in the way an established machine is, with one task and
 * one encrypted document already in the cloud. */
async function machineAWithSyncedWork(
  cloud: FakeCloud,
  token: string,
  masterKey: string,
): Promise<{ a: ReturnType<typeof machine>; slug: string }> {
  const a = machine("a", cloud.url);
  writeFileSync(join(a.home, ".trace", "auth.json"), JSON.stringify({ accessToken: token }));
  writeFileSync(join(a.home, ".trace", "key.json"), JSON.stringify({ masterKey }));
  const store = openTraceStore(a.db);
  const task = store.createTask("Ship the second machine");
  store.close();
  const docs = resolveTaskDocsDir(a.db, task.slug);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "state.md"), "# Ship it\n\nA wrote this.\n");
  expect((await runSyncCommand(a.env, { fetch: cloud.fetch })).exitCode).toBe(0);
  return { a, slug: task.slug };
}

/** Poll a value the way a board tab does, yielding between reads. */
async function until<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  for (let poll = 0; poll < 1_000; poll += 1) {
    const value = read();
    if (predicate(value)) return value;
    await tick();
  }
  throw new Error(`never settled: ${JSON.stringify(read())}`);
}

test("machine B unlocks through machine A's approval and reads A's document", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({
    token: "cloud-token",
    user: { id: "octocat", name: "The Octocat" },
  });
  const { slug } = await machineAWithSyncedWork(cloud, "cloud-token", masterKey);

  // B signs in. The account holds documents, so the login parks at the key
  // step rather than storing anything.
  const b = machine("b", cloud.url);
  const syncs: Promise<unknown>[] = [];
  const auth = createLocalAuthService(b.env, {
    fetch: cloud.fetch,
    sleep: tick,
    onLoginComplete: () => {
      syncs.push(runSyncCommand(b.env, { fetch: cloud.fetch }));
    },
  });
  const started = await auth.startLogin("github");
  cloud.approve();
  await until(
    () => auth.readLogin(started.attemptId),
    (view) => view?.state === "waiting-for-existing-key",
  );

  // Instead of typing the key, B asks A to approve.
  const asked = await auth.requestKeyTransfer(started.attemptId);
  expect(asked?.transfer).toMatchObject({ state: "waiting-for-approval" });
  expect(asked?.transfer?.locator).toMatch(/^[0-9A-Z]{6}$/);
  // Nothing is stored while the request is merely pending.
  expect(readSyncIdentity(b.db)).toBeNull();

  // A finds the request, offers, and compares codes with the user.
  const approver = createKeyTransferApproverSession({
    relay: createKeyTransferRelay({
      serverUrl: cloud.url,
      fetch: cloud.fetch,
      accessToken: "cloud-token",
    }),
    accountId: "octocat",
    serviceOrigin: cloud.url,
    masterKey,
    sleep: tick,
  });
  const listed = await approver.list();
  expect(listed[0]?.locator).toBe(asked?.transfer?.locator);
  const inspected = await approver.inspect(listed[0]!.requestId);
  const comparing = await until(
    () => auth.readLogin(started.attemptId),
    (view) => view?.transfer?.state === "comparing",
  );
  expect(inspected.verificationCode).toBe(comparing?.transfer?.verificationCode);

  // The user confirms the codes match.
  await approver.approve(listed[0]!.requestId);

  const complete = await until(
    () => auth.readLogin(started.attemptId),
    (view) => view?.state === "complete",
  );
  // The key crossed the relay sealed, and never crosses into the view.
  expect(JSON.stringify(complete)).not.toContain(masterKey);
  expect(
    JSON.parse(readFileSync(join(b.home, ".trace", "key.json"), "utf8")) as {
      masterKey: string;
    },
  ).toEqual({ masterKey });
  expect(readSyncIdentity(b.db)).toMatchObject({ accountId: "octocat" });

  // Which is the point: B can now read what A wrote.
  await Promise.all(syncs);
  expect(
    readFileSync(join(resolveTaskDocsDir(b.db, slug), "state.md"), "utf8"),
  ).toContain("A wrote this.");
});

const HOSTED_ORIGIN = "https://board.test";

type Captured = { status: number; body: string };

/**
 * A hosted board pointed at one machine's local EQNX, carrying the hosted
 * origin and a paired browser credential on every request — so the
 * cross-origin allowlist and the capability grant are on the exercised path,
 * not assumed.
 */
function hostedBoard(
  m: { home: string; db: string; env: Env },
  cloud: FakeCloud,
): {
  request: (method: string, path: string, body?: string) => Promise<Captured>;
  syncs: Promise<unknown>[];
  seen: string[];
} {
  const syncs: Promise<unknown>[] = [];
  const seen: string[] = [];
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
      sleep: tick,
      onLoginComplete: () => {
        syncs.push(runSyncCommand(m.env, { fetch: cloud.fetch }));
      },
    }),
    HOSTED_ORIGIN,
    connection,
  );

  const request = (method: string, path: string, body?: string): Promise<Captured> =>
    new Promise((resolve) => {
      const captured: Captured = { status: 200, body: "" };
      const res = {
        set statusCode(value: number) {
          captured.status = value;
        },
        get statusCode() {
          return captured.status;
        },
        setHeader() {},
        end(chunk?: Buffer | string) {
          captured.body = chunk === undefined ? "" : chunk.toString("utf8");
          seen.push(captured.body);
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

  return { request, syncs, seen };
}

test("both machines run the ceremony from the hosted board, and no key crosses it", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const { a, slug } = await machineAWithSyncedWork(cloud, "cloud-token", masterKey);
  const boardA = hostedBoard(a, cloud);

  const b = machine("b", cloud.url);
  const boardB = hostedBoard(b, cloud);

  const started = JSON.parse(
    (
      await boardB.request(
        "POST",
        "/api/local-auth/login",
        JSON.stringify({ provider: "github" }),
      )
    ).body,
  ) as { attemptId: string };
  cloud.approve();

  const attempt = (): Promise<{
    state: string;
    transfer?: { requestId: string; locator: string; state: string; verificationCode?: string };
  }> =>
    boardB
      .request("GET", `/api/local-auth/login/${started.attemptId}`)
      .then((response) => JSON.parse(response.body));

  for (let poll = 0; poll < 500; poll += 1) {
    if ((await attempt()).state === "waiting-for-existing-key") break;
    await tick();
  }
  expect((await attempt()).state).toBe("waiting-for-existing-key");

  // B asks, through the board, to be unlocked by another machine.
  const asked = JSON.parse(
    (
      await boardB.request(
        "POST",
        `/api/local-auth/login/${started.attemptId}/transfer`,
      )
    ).body,
  ) as { transfer: { requestId: string; locator: string } };
  expect(asked.transfer.locator).toMatch(/^[0-9A-Z]{6}$/);

  // A sees it, opens it, and reads the code off its own screen.
  const listed = JSON.parse(
    (await boardA.request("GET", "/api/local-auth/transfers")).body,
  ) as { requestId: string; locator: string }[];
  expect(listed[0]?.locator).toBe(asked.transfer.locator);

  let inspection = JSON.parse(
    (
      await boardA.request(
        "POST",
        `/api/local-auth/transfers/${listed[0]!.requestId}/open`,
      )
    ).body,
  ) as { state: string; verificationCode?: string };
  for (let poll = 0; poll < 20 && inspection.state !== "comparing"; poll += 1) {
    await tick();
    inspection = JSON.parse(
      (
        await boardA.request(
          "POST",
          `/api/local-auth/transfers/${listed[0]!.requestId}/open`,
        )
      ).body,
    ) as { state: string; verificationCode?: string };
  }
  expect(inspection.state).toBe("comparing");
  expect((await attempt()).transfer?.verificationCode).toBe(
    inspection.verificationCode,
  );

  // The user says they match.
  await boardA.request(
    "POST",
    `/api/local-auth/transfers/${listed[0]!.requestId}/approve`,
  );

  for (let poll = 0; poll < 500; poll += 1) {
    if ((await attempt()).state === "complete") break;
    await tick();
  }
  expect((await attempt()).state).toBe("complete");

  // Nothing either board was ever told contains the key it was all about.
  for (const body of [...boardA.seen, ...boardB.seen]) {
    expect(body).not.toContain(masterKey);
  }

  await Promise.all(boardB.syncs);
  expect(
    readFileSync(join(resolveTaskDocsDir(b.db, slug), "state.md"), "utf8"),
  ).toContain("A wrote this.");
});
