import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  openTraceStore,
  readSyncStatusFile,
  resolveTaskDocsDir,
  updateConfigFile,
} from "@trace/core";
import { FakeCloud } from "./fake-sync-server.ts";
import { AUTOMATIC_SYNC_QUIET_MS } from "./commands/automatic-sync-policy.ts";
import { PERIODIC_SYNC_INTERVAL_MS } from "./serve.ts";
import { runSyncCommand } from "./commands/sync.ts";
import { skillReEnterOperation } from "./commands/skill-operations.ts";
import { sessionTailOperation } from "./commands/session-operations.ts";
import {
  hostedBoard,
  machine as makeMachine,
  machineAWithSyncedWork,
  signInDirectly,
  startLocalRuntime,
  type LocalRuntime,
  type Machine,
} from "./second-machine-fixtures.ts";

/**
 * What happens to the second machine *after* the setup session: both boards
 * closed, nobody watching, each machine's own local EQNX left running.
 *
 * The earlier slices proved B can be unlocked and can watch its work arrive.
 * This one starts from where they finish — B signed in, its key on disk — and
 * asks whether the arrangement survives ordinary use: work made on either
 * machine reaching the other on the scheduler's own terms, a service restart
 * that costs the user nothing, and a document that could not be downloaded
 * being retried rather than losing the pull it was part of.
 *
 * The clock is the only thing these tests drive directly. Sync runs through the
 * real `requestAutomaticSync` chain, so the AutoSync policy — the floor, the
 * quiet window, the execution-boundary re-read — decides which ticks become
 * syncs, exactly as it does in production.
 */

const TOKEN = "cloud-token";
const MASTER_KEY = "77".repeat(32);

/**
 * The bound this arrangement actually promises for a remote change reaching an
 * idle machine — not "instantly", and not the periodic interval alone. A
 * machine with nothing of its own to push suppresses periodic syncs until its
 * last successful one is {@link AUTOMATIC_SYNC_QUIET_MS} old, so the worst case
 * is that window plus one more interval before it asks the server anything.
 */
const REMOTE_CHANGE_ARRIVAL_BOUND_MS =
  AUTOMATIC_SYNC_QUIET_MS + PERIODIC_SYNC_INTERVAL_MS;

let root: string;
let cloud: FakeCloud;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trace-background-sync-"));
  cloud = new FakeCloud({ token: TOKEN, user: { id: "fixture-user" } });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/** Machine B as the restore leaves it: signed in, key on disk, work pulled. */
async function establishedB(
  fetch: typeof globalThis.fetch = cloud.fetch,
): Promise<Machine> {
  const b = makeMachine(root, "b", cloud.url);
  signInDirectly(b, TOKEN, MASTER_KEY);
  const restored = await runSyncCommand(b.env, { fetch });
  expect(restored.exitCode).toBe(0);
  return b;
}

/** Advance the clock the way an unattended afternoon does, letting every sync
 * the runtime decides to start finish before the next tick. */
async function elapse(runtime: LocalRuntime, ms: number): Promise<void> {
  for (
    let remaining = ms;
    remaining > 0;
    remaining -= PERIODIC_SYNC_INTERVAL_MS
  ) {
    await vi.advanceTimersByTimeAsync(
      Math.min(remaining, PERIODIC_SYNC_INTERVAL_MS),
    );
    await runtime.settle();
  }
}

/** Wrap a fetch so a test can see, and interfere with, what crosses the wire. */
function recording(fetch: typeof globalThis.fetch): {
  calls: string[];
  fetch: typeof globalThis.fetch;
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      calls.push(
        `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input)).pathname}`,
      );
      return fetch(input, init);
    }) as typeof globalThis.fetch,
  };
}

function titlesOn(m: Machine): string[] {
  const store = openTraceStore(m.db);
  try {
    return store.listTasks().map((task) => task.title);
  } finally {
    store.close();
  }
}

test("work done on A with every board closed reaches B on B's own schedule", async () => {
  const { a, slug } = await machineAWithSyncedWork(
    root,
    cloud,
    TOKEN,
    MASTER_KEY,
  );
  const b = await establishedB();
  const runtime = await startLocalRuntime(b, cloud.fetch);

  try {
    // Both boards are now closed, and some time passes before A's work changes
    // with nobody watching.
    await vi.advanceTimersByTimeAsync(60_000);
    const store = openTraceStore(a.db);
    const task = store.listTasks()[0]!;
    store.updateTaskTitle(task.id, "Ship the second machine, properly");
    store.close();
    writeFileSync(
      join(resolveTaskDocsDir(a.db, slug), "state.md"),
      "# Ship it\n\nA changed this after the boards closed.\n",
    );
    expect((await runSyncCommand(a.env, { fetch: cloud.fetch })).exitCode).toBe(
      0,
    );

    await elapse(runtime, REMOTE_CHANGE_ARRIVAL_BOUND_MS);

    expect(titlesOn(b)).toEqual(["Ship the second machine, properly"]);
    expect(
      readFileSync(join(resolveTaskDocsDir(b.db, slug), "state.md"), "utf8"),
    ).toContain("after the boards closed");
  } finally {
    await runtime.close();
  }
});

test("an idle machine's ticks coalesce into one sync when the quiet window opens", async () => {
  await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);
  const b = await establishedB();
  const runtime = await startLocalRuntime(b, cloud.fetch);

  try {
    // Starting the service does not re-ask a machine that has just synced and
    // has nothing of its own to push, and neither does a tick inside the quiet
    // window: a machine left running overnight is not one syncing every five
    // minutes. The suppression is the policy's, made before any network call.
    await runtime.settle();
    expect(runtime.syncs).toHaveLength(0);

    await elapse(runtime, AUTOMATIC_SYNC_QUIET_MS - PERIODIC_SYNC_INTERVAL_MS);
    expect(runtime.syncs).toHaveLength(0);

    await elapse(runtime, PERIODIC_SYNC_INTERVAL_MS);
    expect(runtime.syncs).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});

test("a change made on B reaches A the same way, with no duplicate task", async () => {
  const { a } = await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);
  const b = await establishedB();
  const runtime = await startLocalRuntime(b, cloud.fetch);

  try {
    const store = openTraceStore(b.db);
    const captured = store.createTask("Written on the second machine");
    store.close();
    mkdirSync(resolveTaskDocsDir(b.db, captured.slug), { recursive: true });
    writeFileSync(
      join(resolveTaskDocsDir(b.db, captured.slug), "notes.md"),
      "# Notes\n\nB wrote this.\n",
    );

    // B has something of its own to push, so the quiet window does not apply:
    // the next tick past the floor carries it.
    await elapse(runtime, PERIODIC_SYNC_INTERVAL_MS);
    expect((await runSyncCommand(a.env, { fetch: cloud.fetch })).exitCode).toBe(
      0,
    );

    expect(titlesOn(a).sort()).toEqual([
      "Ship the second machine",
      "Written on the second machine",
    ]);
    expect(
      readFileSync(
        join(resolveTaskDocsDir(a.db, captured.slug), "notes.md"),
        "utf8",
      ),
    ).toContain("B wrote this");

    // Syncing repeatedly, in both directions, converges rather than accumulates.
    await elapse(runtime, REMOTE_CHANGE_ARRIVAL_BOUND_MS);
    expect((await runSyncCommand(a.env, { fetch: cloud.fetch })).exitCode).toBe(
      0,
    );
    expect(titlesOn(b)).toHaveLength(2);
    expect(titlesOn(a)).toHaveLength(2);
  } finally {
    await runtime.close();
  }
});

test("restarting B's service costs no re-pairing, no re-login, and no key entry", async () => {
  await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);
  const b = await establishedB();
  const board = hostedBoard(b, cloud);
  const before = await startLocalRuntime(b, cloud.fetch);
  await before.settle();
  await before.close();

  // The service goes away and comes back — a reboot, an update, a crash.
  const after = await startLocalRuntime(b, cloud.fetch);
  try {
    await after.settle();

    // The same browser comes back to the same machine: no new pairing minted,
    // no login attempt to resume, and the sync header already says synced.
    const reopened = hostedBoard(b, cloud, {
      browserToken: board.browserToken,
    });
    const status = await reopened.request("GET", "/api/sync/status");
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({
      state: "synced",
      restore: { phase: "ready" },
    });

    const attempt = await reopened.request(
      "GET",
      "/api/local-auth/login/current",
    );
    expect(attempt.status).toBe(200);
    expect(JSON.parse(attempt.body)).toBeNull();

    const tasks = await reopened.request("GET", "/api/tasks");
    expect(JSON.parse(tasks.body)).toHaveLength(1);
    expect(existsSync(join(b.home, ".trace", "key.json"))).toBe(true);
  } finally {
    await after.close();
  }
});

test("a machine with automatic sync off never reaches the network on its own", async () => {
  await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);
  const b = await establishedB();
  updateConfigFile(b.db, { autoSync: false });

  const wire = recording(cloud.fetch);
  const runtime = await startLocalRuntime(b, wire.fetch);
  try {
    await elapse(runtime, REMOTE_CHANGE_ARRIVAL_BOUND_MS * 2);
    expect(runtime.syncs).toHaveLength(0);
    expect(wire.calls).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test("a runtime that does not own the periodic interval schedules nothing", async () => {
  await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);
  const b = await establishedB();

  // What `eqnx serve` becomes when the managed connection already owns the
  // endpoint: it serves the board, and leaves the scheduling alone.
  const deferring = await startLocalRuntime(b, cloud.fetch, {
    periodicSync: false,
  });
  try {
    await deferring.settle();
    const atStartup = deferring.syncs.length;
    await elapse(deferring, REMOTE_CHANGE_ARRIVAL_BOUND_MS * 2);
    expect(deferring.syncs).toHaveLength(atStartup);
  } finally {
    await deferring.close();
  }
});

test("the cloud holds no plaintext document, whichever machine wrote it", async () => {
  await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);
  const b = await establishedB();
  const runtime = await startLocalRuntime(b, cloud.fetch);

  try {
    const store = openTraceStore(b.db);
    const captured = store.createTask("Written on the second machine");
    store.close();
    mkdirSync(resolveTaskDocsDir(b.db, captured.slug), { recursive: true });
    writeFileSync(
      join(resolveTaskDocsDir(b.db, captured.slug), "notes.md"),
      "# Notes\n\nB wrote this secret sentence.\n",
    );
    await elapse(runtime, PERIODIC_SYNC_INTERVAL_MS);

    expect(cloud.stored).not.toContain("B wrote this secret sentence");
    expect(cloud.stored).not.toContain("A wrote this");
    expect(cloud.stored).not.toContain("notes.md");
    expect(cloud.stored).not.toContain(MASTER_KEY);
  } finally {
    await runtime.close();
  }
});

test("a document whose blob will not download leaves the task visible and lands on the next sync", async () => {
  const { slug } = await machineAWithSyncedWork(root, cloud, TOKEN, MASTER_KEY);

  // The one thing that fails is fetching a blob's bytes; everything else about
  // the sync — rows, manifests, the missing-blob probe — still works.
  let downloadsFail = true;
  const offline: typeof globalThis.fetch = (input, init) => {
    const { pathname } = new URL(String(input));
    const isDownload =
      (init?.method ?? "GET").toUpperCase() === "GET" &&
      pathname.startsWith("/api/sync/blobs/");
    if (downloadsFail && isDownload) {
      return Promise.resolve(new Response("", { status: 503 }));
    }
    return cloud.fetch(input, init);
  };

  const b = makeMachine(root, "b", cloud.url);
  signInDirectly(b, TOKEN, MASTER_KEY);
  const runtime = await startLocalRuntime(b, offline);
  try {
    const [first] = await runtime.settle();

    // The pull is not lost to the failed download: the rows landed, the task is
    // on the board, and the machine says out loud that it is not finished.
    expect(first!.exitCode).toBe(0);
    expect(titlesOn(b)).toEqual(["Ship the second machine"]);
    expect(existsSync(join(resolveTaskDocsDir(b.db, slug), "state.md"))).toBe(
      false,
    );
    expect(readSyncStatusFile(b.db)?.restore?.phase).toBe("partial");
    expect(readSyncStatusFile(b.db)?.lastError).toBeUndefined();

    // Connectivity returns; the retry is the next scheduled sync, not a spin.
    downloadsFail = false;
    await elapse(runtime, REMOTE_CHANGE_ARRIVAL_BOUND_MS);

    expect(
      readFileSync(join(resolveTaskDocsDir(b.db, slug), "state.md"), "utf8"),
    ).toContain("A wrote this");
    expect(readSyncStatusFile(b.db)?.restore?.phase).toBe("ready");
  } finally {
    await runtime.close();
  }
});

test("re-entry on B reads the synced state locally and says whose machine the transcript is on", async () => {
  const { a, slug } = await machineAWithSyncedWork(
    root,
    cloud,
    TOKEN,
    MASTER_KEY,
  );

  const transcriptOnA = join(a.home, ".claude", "projects", "session-a.jsonl");
  mkdirSync(join(a.home, ".claude", "projects"), { recursive: true });
  writeFileSync(
    transcriptOnA,
    `${JSON.stringify({ type: "user", message: { role: "user", content: "left off here" } })}\n`,
  );
  const storeA = openTraceStore(a.db);
  const task = storeA.listTasks()[0]!;
  storeA.registerSession({
    id: "session-a",
    transcriptPath: transcriptOnA,
    tool: "claude",
    title: "Machine A work",
  });
  storeA.assignSession("session-a", task.id);
  storeA.close();
  expect((await runSyncCommand(a.env, { fetch: cloud.fetch })).exitCode).toBe(
    0,
  );

  const b = await establishedB();
  const onA = { env: a.env, cwd: join(root, "a"), stdin: "" };
  const onB = { env: b.env, cwd: join(root, "b"), stdin: "" };

  // On the machine that ran the session, nothing changes: the manifest points
  // at the transcript and the tail reads it.
  expect(skillReEnterOperation([slug], onA).stdout).not.toContain(
    "not on this machine",
  );
  expect(sessionTailOperation(["session-a"], onA).stdout).toContain(
    "left off here",
  );

  // These two machines share a filesystem, which a real pair does not: A's
  // transcript is removed here to stand for the boundary a second Mac has by
  // construction. What B holds afterwards is what actually synced — the
  // session row, and a locator pointing somewhere B cannot read.
  rmSync(transcriptOnA);

  const manifest = skillReEnterOperation([slug], onB);
  expect(manifest.exitCode).toBe(0);
  // The docs did come down, so B reads them from its own tree.
  expect(manifest.stdout).toContain(
    join(resolveTaskDocsDir(b.db, slug), "state.md"),
  );
  // The transcript did not, and the manifest says so rather than pointing an
  // agent at a path that is not there.
  expect(manifest.stdout).toContain(transcriptOnA);
  expect(manifest.stdout).toContain("not on this machine");

  // And the follow-up the re-entry protocol suggests refuses honestly instead
  // of printing an empty tail that reads as "nothing was said".
  const tail = sessionTailOperation(["session-a"], onB);
  expect(tail.exitCode).toBe(1);
  expect(tail.stderr).toContain("not on this machine");
});
