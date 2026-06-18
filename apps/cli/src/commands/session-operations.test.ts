import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { taskCreateOperation } from "./task-operations.ts";
import {
  sessionActiveTaskOperation,
  sessionAssignOperation,
  sessionListOperation,
  sessionRegisterOperation,
} from "./session-operations.ts";
import type { Env } from "./seam.ts";

function withTempContext(run: (ctx: { env: Env; cwd: string; stdin: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-session-ops-"));
  const env: Env = { ...process.env, TRACE_DB: join(dir, "trace.sqlite") };

  try {
    mkdirSync(join(dir, ".git"));
    run({ env, cwd: dir, stdin: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("session register then assign binds the session to a task", () => {
  withTempContext((ctx) => {
    const taskRef = taskCreateOperation(["Assigned task"], ctx).stdout.trim();

    expect(
      sessionRegisterOperation(
        [
          "--id",
          "session-1",
          "--transcript",
          join(ctx.cwd, "session-1.jsonl"),
          "--tool",
          "codex",
        ],
        ctx,
      ),
    ).toEqual({ exitCode: 0, stdout: "session-1\n", stderr: "" });

    expect(sessionAssignOperation(["session-1", taskRef], ctx)).toEqual({
      exitCode: 0,
      stdout: `session-1\tcodex\t${join(ctx.cwd, "session-1.jsonl")}\n`,
      stderr: "",
    });
  });
});

test("session active-task resolves a bound task", () => {
  withTempContext((ctx) => {
    const taskRef = taskCreateOperation(["Active target"], ctx).stdout.trim();
    sessionRegisterOperation(
      [
        "--id",
        "session-2",
        "--transcript",
        join(ctx.cwd, "session-2.jsonl"),
        "--tool",
        "claude",
      ],
      ctx,
    );
    sessionAssignOperation(["session-2", taskRef], ctx);

    expect(sessionActiveTaskOperation(["--id", "session-2"], ctx)).toEqual({
      exitCode: 0,
      stdout: '{"kind":"bound","task":{"title":"Active target","slug":"active-target"}}\n',
      stderr: "",
    });
  });
});

test("session list --unassigned prints only unassigned sessions", () => {
  withTempContext((ctx) => {
    const taskRef = taskCreateOperation(["Assigned task"], ctx).stdout.trim();
    sessionRegisterOperation(
      [
        "--id",
        "unassigned-session",
        "--transcript",
        join(ctx.cwd, "unassigned.jsonl"),
        "--tool",
        "codex",
      ],
      ctx,
    );
    sessionRegisterOperation(
      [
        "--id",
        "assigned-session",
        "--transcript",
        join(ctx.cwd, "assigned.jsonl"),
        "--tool",
        "codex",
      ],
      ctx,
    );
    sessionAssignOperation(["assigned-session", taskRef], ctx);

    expect(sessionListOperation(["--unassigned"], ctx)).toEqual({
      exitCode: 0,
      stdout: `unassigned-session\tcodex\t${join(ctx.cwd, "unassigned.jsonl")}\n`,
      stderr: "",
    });
  });
});
