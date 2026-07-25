import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { updateConfigFile } from "@trace/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  taskAddDocOperation,
  taskCaptureOperation,
  taskCreateOperation,
  taskUpdateDocOperation,
} from "./commands/task-operations.ts";
import { skillWorkOnTaskOperation } from "./commands/skill-operations.ts";
import { createSyncHooks, startTraceServe } from "./serve.ts";
import { requestAutomaticSync } from "./commands/sync.ts";
import type { Env } from "./commands/seam.ts";

/**
 * Every implicit sync trigger, driven through its *production* wiring — none of
 * these rows inject a sync seam, so a trigger site that stopped routing through
 * `requestAutomaticSync` would fail here. The only thing stubbed is the process
 * spawn itself, which stands in for "Trace decided to synchronize task data".
 */
const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawn: spawnMock,
}));

afterEach(() => {
  spawnMock.mockClear();
});

type TriggerContext = { env: Env; cwd: string; stdin: string };

type Trigger = {
  name: string;
  fire: (ctx: TriggerContext) => void | Promise<void>;
};

const TRIGGERS: Trigger[] = [
  {
    name: "task mutation (task capture)",
    fire: (ctx) => {
      const docPath = join(ctx.cwd, "captured.md");
      writeFileSync(docPath, "# Captured\n");
      expect(
        taskCaptureOperation(["Captured task", "--doc", docPath], ctx).exitCode,
      ).toBe(0);
    },
  },
  {
    name: "task mutation (task add-doc)",
    fire: (ctx) => {
      const slug = taskCreateOperation(["Doc task"], ctx).stdout.trim();
      spawnMock.mockClear();
      const docPath = join(ctx.cwd, "notes.md");
      writeFileSync(docPath, "# Notes\n");
      expect(taskAddDocOperation([slug, docPath], ctx).exitCode).toBe(0);
    },
  },
  {
    name: "task mutation (task update-doc)",
    fire: (ctx) => {
      const slug = taskCreateOperation(["Doc task"], ctx).stdout.trim();
      const docPath = join(ctx.cwd, "notes.md");
      writeFileSync(docPath, "# Notes\n");
      taskAddDocOperation([slug, docPath], ctx);
      spawnMock.mockClear();
      expect(
        taskUpdateDocOperation([slug, docPath, "--title", "Notes"], ctx).exitCode,
      ).toBe(0);
    },
  },
  {
    name: "task binding (skill work-on-task)",
    fire: (ctx) => {
      const result = skillWorkOnTaskOperation(
        [
          "Bound task",
          "--id",
          "codex-session-policy",
          "--transcript",
          join(ctx.cwd, "codex-session-policy.jsonl"),
          "--tool",
          "codex",
        ],
        ctx,
      );
      expect(result.exitCode).toBe(0);
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
    name: "board focus (POST /api/sync)",
    fire: (ctx) => {
      createSyncHooks(() => requestAutomaticSync(ctx.env)).requestSync();
    },
  },
  {
    name: "board mutation debounce",
    fire: (ctx) => {
      vi.useFakeTimers();
      try {
        createSyncHooks(() => requestAutomaticSync(ctx.env)).onMutation();
        vi.runOnlyPendingTimers();
      } finally {
        vi.useRealTimers();
      }
    },
  },
  {
    name: "periodic board timer",
    fire: async (ctx) => {
      vi.useFakeTimers();
      try {
        const running = await startTraceServe(ctx.env, { server: fakeServer() });
        spawnMock.mockClear();
        vi.advanceTimersByTime(5 * 60_000);
        await running.close();
      } finally {
        vi.useRealTimers();
      }
    },
  },
];

describe("the AutoSync policy governs every implicit sync trigger", () => {
  for (const trigger of TRIGGERS) {
    test(`${trigger.name} syncs with auto-sync absent`, async () => {
      await withTriggerContext(undefined, (ctx) => trigger.fire(ctx));
      expect(spawnMock).toHaveBeenCalled();
    });

    test(`${trigger.name} syncs with auto-sync enabled`, async () => {
      await withTriggerContext(true, (ctx) => trigger.fire(ctx));
      expect(spawnMock).toHaveBeenCalled();
    });

    test(`${trigger.name} is silent with auto-sync disabled`, async () => {
      await withTriggerContext(false, (ctx) => trigger.fire(ctx));
      expect(spawnMock).not.toHaveBeenCalled();
    });
  }
});

/**
 * A logged-in machine with a configured sync server, so the only thing standing
 * between a trigger and a spawn is the AutoSync policy.
 */
async function withTriggerContext(
  autoSync: boolean | undefined,
  run: (ctx: TriggerContext) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "trace-auto-sync-"));
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
        TRACE_SERVER_URL: "https://sync.test",
      },
      cwd: dir,
      stdin: "",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A `node:http` Server stand-in: the unit env cannot bind sockets. */
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
