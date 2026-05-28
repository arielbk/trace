import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const hookBin = fileURLToPath(new URL("./claude-session-start-hook.ts", import.meta.url));
const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

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

    expect(unassigned).toBe(`claude-session-1\tclaude\t${transcriptPath}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
