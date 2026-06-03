import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";
import { runClaudeSessionStartHook } from "./claude-session-start-hook.ts";

// Regression for the 2026-06-03 gap: a session started via /clear had its
// transcript on disk but never produced a store row. The hook must register a
// clear-sourced session and pick up its token usage, and `session scan
// --claude` must recover the same transcript if the hook ever misses it.
test("a /clear-sourced session registers with its token totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-clear-regression-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "0e92b9b0-clear.jsonl");
  const env = { HOME: dir, TRACE_DB: databasePath };

  try {
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          session_id: "0e92b9b0-clear",
          message: {
            model: "claude-opus-4-7",
            usage: { input_tokens: 11, output_tokens: 22 },
          },
        }),
      ].join("\n"),
    );

    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "0e92b9b0-clear",
        transcript_path: transcriptPath,
        source: "clear",
        hook_event_name: "SessionStart",
      }),
      env,
    );
    expect(result.exitCode).toBe(0);

    const timeline = runTraceCli(["session", "list", "--unassigned"], env);
    expect(timeline.stdout).toContain("0e92b9b0-clear");

    // Token totals are refreshed from the transcript on read.
    const taskId = runTraceCli(["task", "create", "regression"], env).stdout.trim();
    runTraceCli(["session", "assign", "0e92b9b0-clear", taskId], env);
    const json = runTraceCli(["task", "timeline", taskId, "--json"], env).stdout;
    const parsed = JSON.parse(json) as {
      tokenTotals: { inputTokens: number; outputTokens: number };
    };
    expect(parsed.tokenTotals.inputTokens).toBe(11);
    expect(parsed.tokenTotals.outputTokens).toBe(22);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
