import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openTraceStore, resolveTaskDocsDir } from "@trace/core";
import { expect, test, vi } from "vitest";
import {
  skillDocsDirOperation,
  skillReEnterOperation,
  skillWorkOnTaskOperation,
} from "./skill-operations.ts";
import type { Env } from "./seam.ts";

// The CLI's identity composition root (identity.ts) wires the real
// cwd→cursor-session resolver; stub it so tests control what a "live Cursor
// session" looks like. Defaults to null — no Cursor session — which matches
// the temp-dir reality the other tests run in.
const resolveCursorSessionMock = vi.hoisted(() =>
  vi.fn<
    (cwd: string) => { id: string; transcriptPath: string | null } | null
  >(() => null),
);
vi.mock("@trace/cursor-reader", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCursorSession: resolveCursorSessionMock,
}));

// Env vars that would let the claude/codex locators win precedence over
// cursor; stripped when a test simulates a bare Cursor terminal.
function withoutSessionEnv(env: Env): Env {
  const cleaned = { ...env };
  delete cleaned.CLAUDE_CODE_SESSION_ID;
  delete cleaned.CLAUDE_SESSION_ID;
  delete cleaned.session_id;
  delete cleaned.CODEX_THREAD_ID;
  return cleaned;
}

function withTempContext(run: (ctx: { env: Env; cwd: string; stdin: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-skill-ops-"));
  const env: Env = { ...process.env, TRACE_DB: join(dir, "trace.sqlite") };

  try {
    mkdirSync(join(dir, ".git"));
    run({ env, cwd: dir, stdin: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Spec-first precondition: create a task and register a native doc under its
// docs dir, but leave state.md unrendered — reproducing "spec first, create
// task after, bind later" where the footer has never been materialized.
function seedTaskWithDoc(
  ctx: { env: Env; cwd: string },
  title: string,
  fileName: string,
  body: string,
): { slug: string; statePath: string } {
  const databasePath = ctx.env.TRACE_DB as string;
  const store = openTraceStore(databasePath);
  try {
    const task = store.createTask(title, ctx.cwd);
    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, fileName);
    writeFileSync(docPath, body);
    store.addTaskDoc(task.id, docPath, { description: "The spec" });
    return { slug: task.slug, statePath: join(docsDir, "state.md") };
  } finally {
    store.close();
  }
}

test("skill work-on-task materializes the state.md footer on bind for a task with a native doc", () => {
  withTempContext((ctx) => {
    const { statePath } = seedTaskWithDoc(ctx, "Checkout flow", "spec.md", "Spec body.\n");
    expect(existsSync(statePath)).toBe(false);

    skillWorkOnTaskOperation(
      [
        "Checkout flow",
        "--id",
        "claude-bind-1",
        "--transcript",
        join(ctx.cwd, "claude-bind-1.jsonl"),
        "--tool",
        "claude",
      ],
      ctx,
    );

    // The footer materialized at the bind seam — no `trace state check` ran.
    expect(existsSync(statePath)).toBe(true);
    const written = readFileSync(statePath, "utf8");
    expect(written).toContain("# Checkout flow");
    expect(written).toContain("- [spec.md](spec.md) — The spec");
  });
});

test("skill work-on-task does not materialize state.md for a task with no non-state docs", () => {
  withTempContext((ctx) => {
    skillWorkOnTaskOperation(
      [
        "Empty task",
        "--id",
        "claude-bind-2",
        "--transcript",
        join(ctx.cwd, "claude-bind-2.jsonl"),
        "--tool",
        "claude",
      ],
      ctx,
    );

    const statePath = join(
      resolveTaskDocsDir(ctx.env.TRACE_DB as string, "empty-task"),
      "state.md",
    );
    expect(existsSync(statePath)).toBe(false);
  });
});

test("skill work-on-task creates a task and binds the session", () => {
  withTempContext((ctx) => {
    expect(
      skillWorkOnTaskOperation(
        [
          "Checkout flow",
          "--id",
          "codex-session-1",
          "--transcript",
          join(ctx.cwd, "codex-session-1.jsonl"),
          "--tool",
          "codex",
          "--description",
          "Tighten the checkout path",
        ],
        ctx,
      ),
    ).toEqual({
      exitCode: 0,
      stdout: [
        `created new project ${basename(ctx.cwd).toLowerCase()}`,
        `codex-session-1\tcodex\t${join(ctx.cwd, "codex-session-1.jsonl")}`,
        `taskDocsDir: ${join(ctx.cwd, "tasks", "checkout-flow", "docs")}`,
        "",
      ].join("\n"),
      stderr: "",
    });

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const task = store.getTaskByRef("checkout-flow");
      expect(task).toMatchObject({
        title: "Checkout flow",
        description: "Tighten the checkout path",
      });
      expect(store.getSession("codex-session-1")?.taskId).toBe(task?.id);
    } finally {
      store.close();
    }
  });
});

test("skill re-enter returns a manifest and binds the current session", () => {
  withTempContext((ctx) => {
    skillWorkOnTaskOperation(
      [
        "Manifest task",
        "--id",
        "claude-session-1",
        "--transcript",
        join(ctx.cwd, "claude-session-1.jsonl"),
        "--tool",
        "claude",
      ],
      ctx,
    );
    const docsDir = join(ctx.cwd, "tasks", "manifest-task", "docs");
    const docPath = join(docsDir, "decision.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(docPath, "# Decision\n");

    const reentered = skillReEnterOperation(["Manifest task"], {
      ...ctx,
      env: { ...ctx.env, CODEX_THREAD_ID: "codex-thread-1" },
    });

    expect(reentered.exitCode).toBe(0);
    expect(reentered.stdout).toContain("title: Manifest task");
    expect(reentered.stdout).toContain(`taskDocsDir: ${docsDir}`);
    expect(reentered.stdout).toContain(`- path: ${docPath}`);

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const task = store.getTaskByRef("manifest-task");
      expect(store.getSession("codex-thread-1")?.taskId).toBe(task?.id);
    } finally {
      store.close();
    }
  });
});

test("skill work-on-task binds the live Cursor session resolved from the cwd", () => {
  withTempContext((ctx) => {
    const env = withoutSessionEnv(ctx.env);
    resolveCursorSessionMock.mockReturnValueOnce({
      id: "composer-abc",
      transcriptPath: null,
    });

    const result = skillWorkOnTaskOperation(["Cursor task"], { ...ctx, env });

    expect(result.exitCode).toBe(0);
    expect(resolveCursorSessionMock).toHaveBeenCalledWith(ctx.cwd);

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const session = store.getSession("composer-abc");
      expect(session).toMatchObject({
        tool: "cursor",
        transcriptPath: "cursor:composer-abc",
      });
      expect(session?.taskId).toBe(store.getTaskByRef("cursor-task")?.id);
    } finally {
      store.close();
    }
  });
});

test("skill re-enter registers and binds the live Cursor session", () => {
  withTempContext((ctx) => {
    skillWorkOnTaskOperation(
      [
        "Cursor re-entry",
        "--id",
        "claude-session-9",
        "--transcript",
        join(ctx.cwd, "claude-session-9.jsonl"),
        "--tool",
        "claude",
      ],
      ctx,
    );

    const env = withoutSessionEnv(ctx.env);
    const transcriptPath = join(ctx.cwd, "chat-1", "chat-1.jsonl");
    resolveCursorSessionMock.mockReturnValueOnce({ id: "chat-1", transcriptPath });

    const reentered = skillReEnterOperation(["Cursor re-entry"], { ...ctx, env });

    expect(reentered.exitCode).toBe(0);
    expect(reentered.stdout).toContain("title: Cursor re-entry");

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const session = store.getSession("chat-1");
      expect(session).toMatchObject({ tool: "cursor", transcriptPath });
      expect(session?.taskId).toBe(store.getTaskByRef("cursor-re-entry")?.id);
    } finally {
      store.close();
    }
  });
});

test("skill docs-dir reports an unbound session with re-enter guidance", () => {
  withTempContext((ctx) => {
    skillWorkOnTaskOperation(
      [
        "Recent task",
        "--id",
        "older-session",
        "--transcript",
        join(ctx.cwd, "older-session.jsonl"),
        "--tool",
        "codex",
      ],
      ctx,
    );

    expect(skillDocsDirOperation(["--id", "unbound-session"], ctx)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "Session is not bound to a task. Re-enter the most recent task with: trace skill re-enter recent-task\n",
    });
  });
});
