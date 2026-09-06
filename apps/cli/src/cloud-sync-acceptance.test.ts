import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  compareSyncRows,
  openTraceStore,
  updateConfigFile,
  type SyncPayload,
  type SyncSessionRow,
  type SyncTaskRow,
} from "@trace/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  taskAddDocOperation,
  taskCaptureOperation,
  taskCreateOperation,
  taskUpdateDocOperation,
} from "./commands/task-operations.ts";
import { skillWorkOnTaskOperation } from "./commands/skill-operations.ts";
import { createSyncHooks, startTraceServe } from "./serve.ts";
import { requestAutomaticSync, runSyncCommand } from "./commands/sync.ts";
import type { Env } from "./commands/seam.ts";

/**
 * End-to-end acceptance for Cloud Sync's local experience. Where
 * `automatic-sync-policy.test.ts` stops at "was a sync process started?", this
 * harness runs the whole chain — trigger → policy → spawned process env →
 * execution-boundary policy → HTTP transport — against a real sync server
 * listening on loopback, and asserts on the *transport calls that server
 * received*. Nothing about the request shape is stubbed: a machine that stops
 * reaching the network, or one that reaches it while the user opted out, shows
 * up here as recorded traffic that should not exist.
 */

/**
 * Stands in for the spawned `trace sync` process: same command shape, same
 * environment handoff, but executed in-process so the test can await it. The
 * env is what carries `TRACE_AUTOMATIC_SYNC`, so the execution-boundary half of
 * the AutoSync policy is exercised exactly as in production.
 */
const syncRuns = vi.hoisted(() => [] as Promise<unknown>[]);
const spawnMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      syncRuns.push(
        import("./commands/sync.ts").then(({ runSyncCommand }) =>
          runSyncCommand(options.env),
        ),
      );
      return { on: vi.fn(), unref: vi.fn() };
    },
  ),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawn: spawnMock,
}));

afterEach(() => {
  spawnMock.mockClear();
  syncRuns.length = 0;
});

/**
 * A stateful sync server that records every transport call made to it.
 *
 * It is installed as `globalThis.fetch` rather than bound to a socket, because
 * the spawned sync process is only reachable through the process-wide fetch —
 * and because the test environment is not permitted to listen on a port. The
 * recording point is still the real transport boundary: `HttpSyncTransport`
 * composes the URL, method, bearer header, and JSON body exactly as it would
 * against a deployed server, and the server keeps pushed rows so one machine's
 * push can become another machine's pull.
 */
type RecordingSyncServer = {
  url: string;
  /** `"POST /api/sync/push"`, in the order the server handled them. */
  requests: string[];
  /** Bearer tokens presented, so "who reached the network" is answerable. */
  tokens: string[];
  /**
   * What the server has sent so far. `bytes` is the response-body total — the
   * quantity a hosted server pays for — and the row counts say what those
   * bytes carried. Read a copy before a sync and diff it after.
   */
  sent: { bytes: number; tasks: number; sessions: number };
  /** The `since` each pull carried, in order; `null` for one that sent none. */
  pullsSince: (string | null)[];
  /** The cursor each pull was answered with, in the same order. */
  pullCursors: (string | undefined)[];
  /**
   * Clone the rows already pushed until the server holds `count` tasks, so a
   * pull can be measured against a realistic amount of history without paying
   * to create it. Clones a genuinely pushed row, so the shape stays real.
   */
  inflate: (count: number) => void;
  close: () => Promise<void>;
};

/** A stored row and the sequence number the server stamped it with. */
type Versioned<T> = { row: T; seq: number };

/**
 * A stateful sync server that records every transport call made to it and
 * models the cursor contract the deployed server implements: every row carries
 * a server-assigned seq, a pull returns only rows past the client's `since`,
 * and every response carries a fresh watermark — including an empty one, which
 * still has to advance or a caught-up client would never stop asking.
 *
 * Pass `{ cursors: false }` for a server that predates incremental pull: it
 * answers with full state and no cursor, which is what the client has to keep
 * coping with.
 */
async function startRecordingSyncServer(
  options: { cursors?: boolean } = {},
): Promise<RecordingSyncServer> {
  const emitsCursors = options.cursors ?? true;
  const requests: string[] = [];
  const tokens: string[] = [];
  const sent = { bytes: 0, tasks: 0, sessions: 0 };
  const pullsSince: (string | null)[] = [];
  const pullCursors: (string | undefined)[] = [];
  const tasks = new Map<string, Versioned<SyncTaskRow>>();
  const sessions = new Map<string, Versioned<SyncSessionRow>>();
  let seq = 0;
  const url = "https://sync.acceptance.test";
  const realFetch = globalThis.fetch;

  /** Last-writer-wins, and only a winning write takes a fresh seq. */
  const write = <T extends { updatedAt: string; machineId: string }>(
    stored: Map<string, Versioned<T>>,
    key: string,
    row: T,
  ): boolean => {
    const existing = stored.get(key);
    if (existing && compareSyncRows(row, existing.row) <= 0) return false;
    stored.set(key, { row, seq: (seq += 1) });
    return true;
  };
  const past = <T>(since: number | null, stored: Iterable<Versioned<T>>): T[] =>
    [...stored].filter((entry) => since === null || entry.seq > since).map((entry) => entry.row);
  const json = (body: Record<string, unknown> | unknown[]) => {
    const text = JSON.stringify(body);
    sent.bytes += Buffer.byteLength(text);
    return new Response(text, { headers: { "content-type": "application/json" } });
  };

  globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ) => {
    const target = String(input);
    if (!target.startsWith(url)) return realFetch(input as never, init);
    const [path, query] = target.slice(url.length).split("?");
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const authorization = (init?.headers as Record<string, string> | undefined)
      ?.authorization;
    if (authorization) tokens.push(authorization);
    const sinceParam = new URLSearchParams(query ?? "").get("since");
    const since = sinceParam === null ? null : Number(sinceParam);
    // The watermark is read before the rows are selected, so it never claims
    // rows the response did not carry.
    const cursor = emitsCursors ? { cursor: String(seq) } : {};

    if (path === "/api/sync/push") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Partial<SyncPayload>;
      let accepted = 0;
      for (const row of payload.tasks ?? []) if (write(tasks, row.id, row)) accepted += 1;
      for (const row of payload.sessions ?? []) if (write(sessions, row.id, row)) accepted += 1;
      return json({ accepted });
    }
    if (path === "/api/sync/pull") {
      pullsSince.push(sinceParam);
      pullCursors.push(cursor.cursor);
      const payload = {
        tasks: past(since, tasks.values()),
        sessions: past(since, sessions.values()),
        ...cursor,
      };
      sent.tasks += payload.tasks.length;
      sent.sessions += payload.sessions.length;
      return json(payload);
    }
    if (path === "/api/sync/docs/push") return json({ accepted: 0, uploaded: 0 });
    if (path === "/api/sync/docs/manifests")
      return json({ manifests: [], wrappedKeys: [], ...cursor });
    if (path === "/api/sync/blobs/missing") return json([]);
    return Response.json({}, { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    url,
    requests,
    tokens,
    sent,
    pullsSince,
    pullCursors,
    inflate: (count: number) => {
      const template = [...tasks.values()][0]?.row;
      if (!template) throw new Error("inflate needs a pushed task to clone");
      for (let index = tasks.size; index < count; index += 1) {
        const id = `inflated-${index}`;
        write(tasks, id, { ...template, id, slug: `${template.slug}-${index}` });
      }
    },
    close: async () => {
      globalThis.fetch = realFetch;
    },
  };
}

type TriggerContext = { env: Env; cwd: string; stdin: string };

type Trigger = {
  name: string;
  fire: (ctx: TriggerContext) => void | Promise<void>;
};

/**
 * The implicit triggers named by the acceptance slice: task mutation, task
 * binding/re-entry, board startup/focus, and the periodic interval. Re-entry
 * itself does not synchronize today (`skill re-enter` has no sync call), so
 * binding is represented by `skill work-on-task`.
 */
const TRIGGERS: Trigger[] = [
  {
    name: "task mutation",
    fire: (ctx) => {
      const docPath = join(ctx.cwd, "captured.md");
      writeFileSync(docPath, "# Captured\n");
      expect(
        taskCaptureOperation(["Captured task", "--doc", docPath], ctx).exitCode,
      ).toBe(0);
      const slug = taskCreateOperation(["Doc task"], ctx).stdout.trim();
      const notesPath = join(ctx.cwd, "notes.md");
      writeFileSync(notesPath, "# Notes\n");
      expect(taskAddDocOperation([slug, notesPath], ctx).exitCode).toBe(0);
      expect(
        taskUpdateDocOperation([slug, notesPath, "--title", "Notes"], ctx)
          .exitCode,
      ).toBe(0);
    },
  },
  {
    name: "task binding",
    fire: (ctx) => {
      expect(
        skillWorkOnTaskOperation(
          [
            "Bound task",
            "--id",
            "acceptance-session",
            "--transcript",
            join(ctx.cwd, "acceptance-session.jsonl"),
            "--tool",
            "codex",
          ],
          ctx,
        ).exitCode,
      ).toBe(0);
    },
  },
  {
    name: "board startup",
    fire: async (ctx) => {
      const running = await startTraceServe(ctx.env, { server: fakeServer() });
      await running.close();
    },
  },
  {
    name: "board focus",
    fire: (ctx) => {
      createSyncHooks(() => requestAutomaticSync(ctx.env)).requestSync();
    },
  },
  {
    name: "periodic interval",
    fire: async (ctx) => {
      vi.useFakeTimers();
      try {
        const running = await startTraceServe(ctx.env, { server: fakeServer() });
        vi.advanceTimersByTime(5 * 60_000);
        await running.close();
      } finally {
        vi.useRealTimers();
      }
    },
  },
];

describe("a default-configured machine synchronizes automatically", () => {
  for (const trigger of TRIGGERS) {
    test(`${trigger.name} reaches the sync server`, async () => {
      const server = await startRecordingSyncServer();
      try {
        await withMachine(server.url, undefined, async (ctx) => {
          await trigger.fire(ctx);
          await settleSyncRuns();
        });
        expect(server.requests).toContain("POST /api/sync/push");
        expect(server.requests).toContain("GET /api/sync/pull");
        expect(server.tokens).toContain("Bearer secret");
      } finally {
        await server.close();
      }
    });
  }
});

describe("a manual-mode machine synchronizes only when asked", () => {
  test("every implicit trigger leaves the sync server untouched", async () => {
    const server = await startRecordingSyncServer();
    try {
      await withMachine(server.url, false, async (ctx) => {
        for (const trigger of TRIGGERS) {
          await trigger.fire(ctx);
          await settleSyncRuns();
        }
      });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("one explicit trace sync then transfers the accumulated work", async () => {
    const server = await startRecordingSyncServer();
    try {
      await withMachine(server.url, false, async (ctx) => {
        expect(taskCreateOperation(["Manual mode task"], ctx).exitCode).toBe(0);
        await settleSyncRuns();
        expect(server.requests).toEqual([]);

        const result = await runSyncCommand(ctx.env);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Sync complete");
      });
      expect(server.requests).toContain("POST /api/sync/push");
    } finally {
      await server.close();
    }
  });
});

describe("two machines hand work over through the sync server", () => {
  test("a task created on one machine arrives on the other", async () => {
    const server = await startRecordingSyncServer();
    try {
      let title = "";
      await withMachine(server.url, undefined, async (ctx) => {
        const slug = taskCreateOperation(["Handoff task"], ctx).stdout.trim();
        expect(slug).not.toBe("");
        title = "Handoff task";
        expect((await runSyncCommand(ctx.env)).exitCode).toBe(0);
      });

      await withMachine(server.url, undefined, async (ctx) => {
        expect((await runSyncCommand(ctx.env)).exitCode).toBe(0);
        const store = openTraceStore(ctx.env.TRACE_DB as string);
        try {
          expect(store.syncSnapshot().tasks.map((task) => task.title)).toContain(
            title,
          );
        } finally {
          store.close();
        }
      });
    } finally {
      await server.close();
    }
  });
});

/**
 * What a machine with nothing to learn may transfer. Syncs are frequent and
 * mostly uneventful, so this is the number that decides how much data an idle
 * client moves; the first sync of a populated account has to blow past it for
 * the second one's staying under to mean anything.
 */
const NO_CHANGE_SYNC_BUDGET_BYTES = 50 * 1024;

describe("a machine with nothing to learn costs almost nothing to sync", () => {
  test("its second sync is sent no rows, and a fraction of the budget in bytes", async () => {
    const server = await startRecordingSyncServer();
    try {
      await seedServerHistory(server, 250);

      await withMachine(server.url, undefined, async (ctx) => {
        const first = await measureSync(server, ctx);
        const second = await measureSync(server, ctx);

        expect(first.tasks).toBe(250);
        expect(first.bytes).toBeGreaterThan(NO_CHANGE_SYNC_BUDGET_BYTES);
        expect(second.tasks).toBe(0);
        expect(second.bytes).toBeLessThan(NO_CHANGE_SYNC_BUDGET_BYTES);
      });
    } finally {
      await server.close();
    }
  });

  test("it asks with the watermark its last pull handed it", async () => {
    const server = await startRecordingSyncServer();
    try {
      await seedServerHistory(server, 5);

      await withMachine(server.url, undefined, async (ctx) => {
        await measureSync(server, ctx);
        const handedOut = server.pullCursors.at(-1);
        await measureSync(server, ctx);

        expect(handedOut).toEqual(expect.any(String));
        expect(server.pullsSince.at(-2)).toBeNull();
        expect(server.pullsSince.at(-1)).toBe(handedOut);
      });
    } finally {
      await server.close();
    }
  });

  test("a change made elsewhere still reaches it on the next sync", async () => {
    const server = await startRecordingSyncServer();
    try {
      await seedServerHistory(server, 5);

      await withMachine(server.url, undefined, async (ctx) => {
        await measureSync(server, ctx);
        await withMachine(server.url, undefined, async (other) => {
          expect(taskCreateOperation(["Elsewhere task"], other).exitCode).toBe(0);
          expect((await runSyncCommand(other.env)).exitCode).toBe(0);
        });

        const catchUp = await measureSync(server, ctx);
        expect(catchUp.tasks).toBe(1);
        expect(catchUp.bytes).toBeLessThan(NO_CHANGE_SYNC_BUDGET_BYTES);
        expect(titlesOn(ctx)).toContain("Elsewhere task");
      });
    } finally {
      await server.close();
    }
  });
});

// A server that predates incremental pull sends no cursor, so the client keeps
// no watermark and asks for everything, every time. Expensive, but a machine
// that cannot upgrade in step with the server must still end up correct.
test("a server that answers without a cursor still gets the machine in sync", async () => {
  const server = await startRecordingSyncServer({ cursors: false });
  try {
    await seedServerHistory(server, 5);

    await withMachine(server.url, undefined, async (ctx) => {
      const first = await measureSync(server, ctx);
      const second = await measureSync(server, ctx);

      expect(first.tasks).toBe(5);
      expect(second.tasks).toBe(5);
      expect(server.pullsSince).toEqual([null, null, null]);
      expect(titlesOn(ctx)).toContain("Seed task");
    });
  } finally {
    await server.close();
  }
});

/**
 * Give the server a history to serve: one machine pushes a real task, which is
 * then cloned up to `count` rows. Cloning beats creating — the shape is a row
 * the CLI genuinely produced, without paying to create hundreds of them.
 */
async function seedServerHistory(
  server: RecordingSyncServer,
  count: number,
): Promise<void> {
  await withMachine(server.url, undefined, async (ctx) => {
    expect(taskCreateOperation(["Seed task"], ctx).exitCode).toBe(0);
    expect((await runSyncCommand(ctx.env)).exitCode).toBe(0);
  });
  server.inflate(count);
}

/** One explicit sync, weighed by what the server had to send to serve it. */
async function measureSync(
  server: RecordingSyncServer,
  ctx: TriggerContext,
): Promise<{ bytes: number; tasks: number; sessions: number }> {
  const before = { ...server.sent };
  expect((await runSyncCommand(ctx.env)).exitCode).toBe(0);
  return {
    bytes: server.sent.bytes - before.bytes,
    tasks: server.sent.tasks - before.tasks,
    sessions: server.sent.sessions - before.sessions,
  };
}

function titlesOn(ctx: TriggerContext): string[] {
  const store = openTraceStore(ctx.env.TRACE_DB as string);
  try {
    return store.syncSnapshot().tasks.map((task) => task.title);
  } finally {
    store.close();
  }
}

/** Let every sync process this trigger started finish before asserting. */
async function settleSyncRuns(): Promise<void> {
  while (syncRuns.length > 0) {
    const pending = syncRuns.splice(0, syncRuns.length);
    await Promise.all(pending);
  }
}

/** A logged-in machine pointed at the recording server. */
async function withMachine(
  serverUrl: string,
  autoSync: boolean | undefined,
  run: (ctx: TriggerContext) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "trace-cloud-sync-acceptance-"));
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".trace"));
    writeFileSync(
      join(dir, ".trace", "auth.json"),
      JSON.stringify({ accessToken: "secret" }),
    );
    writeFileSync(
      join(dir, ".trace", "key.json"),
      JSON.stringify({ masterKey: "12".repeat(32) }),
    );
    const databasePath = join(dir, "trace.sqlite");
    if (autoSync !== undefined) updateConfigFile(databasePath, { autoSync });

    await run({
      env: {
        ...process.env,
        HOME: dir,
        TRACE_DB: databasePath,
        TRACE_SERVER_URL: serverUrl,
      },
      cwd: dir,
      stdin: "",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A `node:http` Server stand-in: `trace serve` need not bind a real socket. */
function fakeServer(): Parameters<typeof startTraceServe>[1] extends {
  server?: infer S;
}
  ? S
  : never {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    listen: (_port: number, _host: string, onListening: () => void) => {
      onListening();
      return emitter;
    },
    address: () => ({ port: 4317 }),
    close: (onClose?: (error?: Error) => void) => onClose?.(),
  }) as never;
}
