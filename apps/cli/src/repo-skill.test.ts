import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));
const skillHelper = join(
  repoRoot,
  ".claude",
  "skills",
  "trace",
  "trace-skill.mjs",
);
const skillReadme = join(repoRoot, ".claude", "skills", "trace", "SKILL.md");

test("repo skill helper resolves or creates a task, binds a simulated session, and re-enters context", () => {
  expect(existsSync(skillReadme)).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = {
    ...process.env,
    TRACE_DB: databasePath,
    TRACE_BIN: `${process.execPath} ${traceBin}`,
  };

  try {
    const bound = execFileSync(
      process.execPath,
      [
        skillHelper,
        "work-on-task",
        "checkout",
        "--id",
        "claude-session-1",
        "--transcript",
        "/tmp/claude-session-1.jsonl",
        "--tool",
        "claude",
      ],
      { encoding: "utf8", env },
    );

    expect(bound).toBe(
      `claude-session-1\tclaude\t/tmp/claude-session-1.jsonl\n`,
    );

    const taskList = execFileSync(
      process.execPath,
      [traceBin, "task", "list"],
      {
        encoding: "utf8",
        env,
      },
    );
    const [taskId, title] = taskList.trim().split("\t");
    if (!taskId) {
      throw new Error("Expected created task id");
    }
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(title).toBe("checkout");

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );

    const context = execFileSync(
      process.execPath,
      [skillHelper, "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(new RegExp(`task:\\n  id: ${taskId}`));
    expect(context).toMatch(/title: checkout/);
    expect(context).toMatch(/docs:\n- path: \/tmp\/spec\.md/);
    expect(context).toMatch(
      /sessions:\n- id: claude-session-1\n  tool: claude\n  transcript: \/tmp\/claude-session-1\.jsonl\n  mostRecent: true/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
