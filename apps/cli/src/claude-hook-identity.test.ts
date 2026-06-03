import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";
import { runClaudeSessionStartHook } from "./claude-session-start-hook.ts";

// The hook derives the registered session's identity through the core
// session-identity seam (tool/id/transcript path), rather than re-deriving the
// "claude" tool inline. It still requires session_id + transcript_path from the
// hook's stdin contract.
test("hook registers a claude session resolved through the identity seam", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-hook-identity-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session.jsonl");
  const env = { HOME: dir, TRACE_DB: databasePath };

  try {
    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "claude-session-9",
        transcript_path: transcriptPath,
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).toBe(0);

    const unassigned = runTraceCli(
      ["session", "list", "--unassigned"],
      env,
    );
    expect(unassigned.stdout).toBe(
      `claude-session-9\tclaude\t${transcriptPath}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Claude Code fires SessionStart with a `source` discriminator
// (startup/resume/clear/compact). Registration must not depend on which one —
// the gap that motivated this work was a session whose start source never
// produced a store row.
test.each(["startup", "resume", "clear", "compact"])(
  "hook registers a session regardless of source=%s",
  (source) => {
    const dir = mkdtempSync(join(tmpdir(), "trace-hook-source-"));
    const databasePath = join(dir, "trace.sqlite");
    const transcriptPath = join(dir, `session-${source}.jsonl`);
    const env = { HOME: dir, TRACE_DB: databasePath };

    try {
      const result = runClaudeSessionStartHook(
        JSON.stringify({
          session_id: `claude-session-${source}`,
          transcript_path: transcriptPath,
          source,
          hook_event_name: "SessionStart",
        }),
        env,
      );

      expect(result.exitCode).toBe(0);

      const unassigned = runTraceCli(["session", "list", "--unassigned"], env);
      expect(unassigned.stdout).toBe(
        `claude-session-${source}\tclaude\t${transcriptPath}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("hook still rejects input missing session_id", () => {
  const result = runClaudeSessionStartHook(
    JSON.stringify({ transcript_path: "/tmp/x.jsonl" }),
    {},
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("session_id");
});
