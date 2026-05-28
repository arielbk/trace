import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const hookBin = resolve("apps/cli/src/claude-session-start-hook.ts");
const traceBin = resolve("apps/cli/src/trace.ts");

test("Claude Code SessionStart hook registers an unassigned CLI session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-claude-hook-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session.jsonl");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        session_id: "claude-session-1",
        transcript_path: transcriptPath,
        hook_event_name: "SessionStart",
      }),
      encoding: "utf8",
      env,
    });

    const unassigned = execFileSync(process.execPath, [traceBin, "session", "list", "--unassigned"], {
      encoding: "utf8",
      env,
    });

    assert.equal(unassigned, `claude-session-1\tclaude\t${transcriptPath}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
