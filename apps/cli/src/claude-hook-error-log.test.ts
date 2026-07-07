import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runClaudeSessionStartHook } from "./claude-session-start-hook-runner.ts";

// Claude Code does not surface a SessionStart hook's stderr or exit code, so a
// failed registration is invisible to the user. The hook appends a structured
// line to an error log next to the trace db, turning silent gaps into something
// inspectable.
test("hook appends to the error log when registration fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-hook-errlog-"));
  // Point TRACE_DB at a subdir path whose own name is an existing directory, so
  // opening the sqlite file at that path fails — the log lands beside it.
  const dbDir = join(dir, "data");
  const databasePath = join(dbDir, "trace.sqlite");
  // Create a directory where the db file is expected so DatabaseSync can't open it.
  rmSync(databasePath, { recursive: true, force: true });
  const env = { HOME: dir, TRACE_DB: databasePath };

  try {
    // Pre-create the db path as a directory to force an open failure.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(databasePath, { recursive: true });

    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "claude-session-fails",
        transcript_path: join(dir, "session.jsonl"),
        source: "clear",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).not.toBe(0);

    const logPath = join(dbDir, "hook-errors.log");
    expect(existsSync(logPath)).toBe(true);

    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("claude-session-fails");
    expect(contents).toContain("SessionStart");
    // Each entry is timestamped so gaps can be correlated with a time window.
    expect(contents).toMatch(/\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook does not write an error log on success", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-hook-errlog-ok-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { HOME: dir, TRACE_DB: databasePath };

  try {
    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "claude-session-ok",
        transcript_path: join(dir, "session.jsonl"),
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, "hook-errors.log"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
