import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

test("scan --claude backfills on-disk transcripts missing from the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-claude-scan-"));
  const databasePath = join(dir, "trace.sqlite");
  // The unregistered transcript in the field lived under a .claude-infinum
  // config home, so the operator points --projects-root at whichever home holds
  // the gap.
  const projectsRoot = join(dir, ".claude-infinum", "projects");
  const projectDir = join(projectsRoot, "-Users-someone-project");
  const transcriptPath = join(projectDir, "0e92b9b0-8cb7-40e1-8a66-73520cf148b9.jsonl");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          session_id: "0e92b9b0-8cb7-40e1-8a66-73520cf148b9",
          message: { model: "claude-opus-4-7", usage: { input_tokens: 9, output_tokens: 4 } },
        }),
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [traceBin, "session", "scan", "--claude", "--projects-root", projectsRoot],
      { encoding: "utf8", env },
    );

    const unassigned = execFileSync(
      process.execPath,
      [traceBin, "session", "list", "--unassigned"],
      { encoding: "utf8", env },
    );

    expect(unassigned).toBe(
      `0e92b9b0-8cb7-40e1-8a66-73520cf148b9\tclaude\t${transcriptPath}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
