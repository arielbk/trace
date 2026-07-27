import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { openTraceStore, updateConfigFile, type SyncPayload } from "@trace/core";
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
  close: () => Promise<void>;
};

async function startRecordingSyncServer(): Promise<RecordingSyncServer> {
  const requests: string[] = [];
  const tokens: string[] = [];
  const stored: SyncPayload = { tasks: [], sessions: [] };
  const url = "https://sync.acceptance.test";
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ) => {
    const target = String(input);
    if (!target.startsWith(url)) return realFetch(input as never, init);
    const path = target.slice(url.length);
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const authorization = (init?.headers as Record<string, string> | undefined)
      ?.authorization;
    if (authorization) tokens.push(authorization);

    if (path === "/api/sync/push") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Partial<SyncPayload>;
      stored.tasks = [...stored.tasks, ...(payload.tasks ?? [])];
      stored.sessions = [...stored.sessions, ...(payload.sessions ?? [])];
      return Response.json({ accepted: payload.tasks?.length ?? 0 });
    }
    if (path === "/api/sync/pull") return Response.json(stored);
    if (path === "/api/sync/docs/push")
      return Response.json({ accepted: 0, uploaded: 0 });
    if (path === "/api/sync/docs/manifests")
      return Response.json({ manifests: [], wrappedKeys: [] });
    if (path === "/api/sync/blobs/missing") return Response.json([]);
    return Response.json({}, { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    url,
    requests,
    tokens,
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
