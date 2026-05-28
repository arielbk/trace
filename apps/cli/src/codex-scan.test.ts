import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

test("scan --codex backfills sessions from a Codex sessions directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-scan-"));
  const databasePath = join(dir, "trace.sqlite");
  const codexHome = join(dir, "codex-home");
  const sessionsDir = join(codexHome, "sessions");
  const transcriptPath = join(sessionsDir, "codex-thread-1.jsonl");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 17, output_tokens: 29, cache_read_input_tokens: 11 },
        }),
      ].join("\n"),
    );
    writeFileSync(
      join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ thread_id: "codex-thread-1", path: "sessions/codex-thread-1.jsonl" })}\n`,
    );

    execFileSync(process.execPath, [traceBin, "session", "scan", "--codex", "--codex-home", codexHome], {
      encoding: "utf8",
      env,
    });

    const unassigned = execFileSync(process.execPath, [traceBin, "session", "list", "--unassigned"], {
      encoding: "utf8",
      env,
    });

    expect(unassigned).toBe(`codex-thread-1\tcodex\t${transcriptPath}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
