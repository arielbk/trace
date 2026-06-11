import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

test("a Claude task can be re-entered from Codex with prior docs and sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-claude-to-codex-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const bound = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "Cross tool checkout",
        "--id",
        "claude-session-1",
        "--transcript",
        join(dir, "claude-session-1.jsonl"),
        "--tool",
        "claude",
        "--description",
        "Move checkout work between tools",
      ],
      { encoding: "utf8", env, cwd: dir },
    );
    const docsDir = /^taskDocsDir: (.+)$/m.exec(bound)?.[1];
    expect(docsDir).toBeTruthy();
    mkdirSync(docsDir as string, { recursive: true });
    writeFileSync(
      join(docsDir as string, "decision.md"),
      "# Decision\n\nKeep the checkout state file authoritative.\n",
    );

    const reentered = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "Cross tool checkout"],
      {
        encoding: "utf8",
        env: { ...env, CODEX_THREAD_ID: "codex-thread-1" },
        cwd: dir,
      },
    );

    expect(reentered).toContain("title: Cross tool checkout");
    expect(reentered).toContain(
      "description: Move checkout work between tools",
    );
    expect(reentered).toContain("decision.md");
    expect(reentered).toMatch(
      /sessions:\n- id: claude-session-1\n {2}tool: claude\n {2}transcript: .*claude-session-1\.jsonl\n {2}mostRecent: true/,
    );

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", "cross-tool-checkout"],
      { encoding: "utf8", env, cwd: dir },
    );
    expect(shown).toContain("- claude-session-1\tclaude");
    expect(shown).toContain("- codex-thread-1\tcodex\tcodex:codex-thread-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex-created work can be re-entered from Claude through the same manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-to-claude-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const bound = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "Codex created task",
        "--id",
        "codex-session-1",
        "--transcript",
        join(dir, "codex-session-1.jsonl"),
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env, cwd: dir },
    );
    const docsDir = /^taskDocsDir: (.+)$/m.exec(bound)?.[1];
    expect(docsDir).toBeTruthy();
    mkdirSync(docsDir as string, { recursive: true });
    writeFileSync(
      join(docsDir as string, "notes.md"),
      "# Notes\n\nCreated in Codex.\n",
    );

    const reentered = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "Codex created task"],
      {
        encoding: "utf8",
        env: {
          ...env,
          CLAUDE_CODE_SESSION_ID: "claude-session-1",
          CLAUDE_TRANSCRIPT_PATH: join(dir, "claude-session-1.jsonl"),
        },
        cwd: dir,
      },
    );

    expect(reentered).toContain("title: Codex created task");
    expect(reentered).toContain("notes.md");
    expect(reentered).toMatch(
      /sessions:\n- id: codex-session-1\n {2}tool: codex\n {2}transcript: .*codex-session-1\.jsonl\n {2}mostRecent: true/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
