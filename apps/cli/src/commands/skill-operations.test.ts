import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceStore } from "@trace/core";
import { expect, test } from "vitest";
import {
  skillDocsDirOperation,
  skillReEnterOperation,
  skillWorkOnTaskOperation,
} from "./skill-operations.ts";
import type { Env } from "./seam.ts";

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
