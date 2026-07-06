import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

// The CLI session summary shows the resolved conversation name. A transcript
// carrying an `ai-title` is adopted on read (refresh-on-read persists it), so
// `session list` surfaces that real name rather than only the transcript path.
test("session list shows the conversation title resolved from the transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-session-title-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "titled-session.jsonl");
  const env = { HOME: dir, TRACE_DB: databasePath };

  try {
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "system", session_id: "titled-cli-session" }),
        JSON.stringify({
          type: "ai-title",
          sessionId: "titled-cli-session",
          aiTitle: "Refactor the checkout flow",
        }),
      ].join("\n"),
    );

    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "titled-cli-session",
        "--transcript",
        transcriptPath,
        "--tool",
        "claude",
      ],
      env,
    );

    const unassigned = runTraceCli(["session", "list", "--unassigned"], env);
    expect(unassigned.stdout).toContain("Refactor the checkout flow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
