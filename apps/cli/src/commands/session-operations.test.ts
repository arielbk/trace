import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { taskCreateOperation } from "./task-operations.ts";
import {
  sessionActiveTaskOperation,
  sessionAssignOperation,
  sessionListOperation,
  sessionRefreshTokensOperation,
  sessionRegisterOperation,
  sessionTailOperation,
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

test("session refresh-tokens heals stale rows and prints counts", () => {
  withTempContext((ctx) => {
    const transcriptPath = join(ctx.cwd, "stale-codex.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "thread.started",
          thread_id: "stale-codex",
          model: "gpt-5-codex",
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cached_input_tokens: 80,
            total_tokens: 110,
          },
        }),
      ].join("\n"),
    );

    sessionRegisterOperation(
      [
        "--id",
        "stale-codex",
        "--transcript",
        transcriptPath,
        "--tool",
        "codex",
        "--input-tokens",
        "100",
        "--output-tokens",
        "10",
        "--cache-read-input-tokens",
        "80",
        "--total-tokens",
        "110",
      ],
      ctx,
    );
    sessionRegisterOperation(
      [
        "--id",
        "gone-claude",
        "--transcript",
        join(ctx.cwd, "gone-claude.jsonl"),
        "--tool",
        "claude",
        "--input-tokens",
        "9",
      ],
      ctx,
    );

    expect(sessionRefreshTokensOperation(["--tool", "codex"], ctx)).toEqual({
      exitCode: 0,
      stdout: "healed: 1\nunchanged: 0\nunhealable: 0\n",
      stderr: "",
    });
    expect(sessionRefreshTokensOperation([], ctx)).toEqual({
      exitCode: 0,
      stdout: "healed: 0\nunchanged: 1\nunhealable: 1\n",
      stderr: "",
    });
  });
});

test("session refresh-tokens --dry-run prints the proposed heal and does not persist", () => {
  withTempContext((ctx) => {
    const transcriptPath = join(ctx.cwd, "stale-codex.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "thread.started",
          thread_id: "stale-codex",
          model: "gpt-5-codex",
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cached_input_tokens: 80,
            total_tokens: 110,
          },
        }),
      ].join("\n"),
    );

    sessionRegisterOperation(
      [
        "--id",
        "stale-codex",
        "--transcript",
        transcriptPath,
        "--tool",
        "codex",
        "--input-tokens",
        "100",
        "--output-tokens",
        "10",
        "--cache-read-input-tokens",
        "80",
        "--total-tokens",
        "110",
      ],
      ctx,
    );

    expect(sessionRefreshTokensOperation(["--dry-run"], ctx)).toEqual({
      exitCode: 0,
      stdout: [
        "stale-codex\tcodex",
        "  input: 100 → 20",
        "  output: 10 → 10",
        "  cache-creation: 0 → 0",
        "  cache-read: 80 → 80",
        "  total: 110 → 110",
        "  model: - → gpt-5-codex",
        "healed: 1",
        "unchanged: 0",
        "unhealable: 0",
        "dry-run: no changes written",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(sessionRefreshTokensOperation([], ctx)).toEqual({
      exitCode: 0,
      stdout: "healed: 1\nunchanged: 0\nunhealable: 0\n",
      stderr: "",
    });
  });
});

test("a transcript that is missing here is reported as absent, not as another machine's", () => {
  withTempContext((ctx) => {
    // Recorded on this very machine, and then pruned — which is ordinary:
    // Claude Code removes old transcripts, and project directories move.
    const transcript = join(ctx.cwd, "session-gone.jsonl");
    writeFileSync(transcript, "");
    sessionRegisterOperation(
      ["--id", "session-gone", "--transcript", transcript, "--tool", "claude"],
      ctx,
    );
    rmSync(transcript);

    const tail = sessionTailOperation(["session-gone"], ctx);
    expect(tail.exitCode).toBe(1);
    // Absence is all this machine can see. Claiming another machine recorded
    // it would be a guess, and here a wrong one.
    expect(tail.stderr).toContain("not on this machine");
    expect(tail.stderr).not.toContain("was recorded by");
  });
});
