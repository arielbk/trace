import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));
const skillReadme = join(repoRoot, "plugin", "skills", "trace", "SKILL.md");

test("trace skill resolves or creates a task by title, binds a simulated session, and re-enters context", () => {
  expect(existsSync(skillReadme)).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const bound = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
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

    const taskList = execFileSync(
      process.execPath,
      [traceBin, "task", "list"],
      {
        encoding: "utf8",
        env,
      },
    );
    const [slug, title] = taskList.trim().split("\t");
    if (!slug) {
      throw new Error("Expected created task slug");
    }
    expect(slug).toBe("checkout");
    expect(title).toBe("checkout");
    expect(bound).toBe(
      [
        `claude-session-1\tclaude\t/tmp/claude-session-1.jsonl`,
        `taskDocsDir: ${join(dir, "tasks", slug, "docs")}`,
        "",
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", slug, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(/task:\n {2}id: [0-9a-f-]{36}/);
    expect(context).toMatch(/title: checkout/);
    expect(context).toMatch(/docs:\n- path: \/tmp\/spec\.md/);
    expect(context).toMatch(
      /sessions:\n- id: claude-session-1\n {2}tool: claude\n {2}transcript: \/tmp\/claude-session-1\.jsonl\n {2}mostRecent: true/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work-on-task given an existing task's id resolves it instead of creating a duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
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

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", "checkout"],
      { encoding: "utf8", env },
    );
    const taskId = shown.match(/^id: (\S+)$/m)?.[1];
    if (!taskId) {
      throw new Error(`Expected a task id in: ${shown}`);
    }

    // An agent re-entering with the task *id* instead of the title must bind
    // to the same task, not mint a UUID-titled duplicate.
    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        taskId,
        "--id",
        "claude-session-2",
        "--transcript",
        "/tmp/claude-session-2.jsonl",
        "--tool",
        "claude",
      ],
      { encoding: "utf8", env },
    );

    const taskList = execFileSync(
      process.execPath,
      [traceBin, "task", "list"],
      { encoding: "utf8", env },
    );
    const rows = taskList.trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("checkout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-enter resolves a slug exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Break stop and stale expiry"],
      { encoding: "utf8", env },
    );

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "break-stop-and-stale-expiry"],
      { encoding: "utf8", env },
    );
    expect(context).toMatch(/title: Break stop and stale expiry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-enter falls back to a normalized-exact title match", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Break stop and stale expiry"],
      { encoding: "utf8", env },
    );

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "  break STOP and stale expiry  "],
      { encoding: "utf8", env },
    );
    expect(context).toMatch(/title: Break stop and stale expiry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-enter miss fails with near candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Break stop and stale expiry"],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Checkout wizard"],
      { encoding: "utf8", env },
    );

    let failed: { status: number | null; stderr: string } | null = null;
    try {
      execFileSync(process.execPath, [traceBin, "skill", "re-enter", "stale"], {
        encoding: "utf8",
        env,
      });
    } catch (error) {
      const e = error as { status: number | null; stderr: string };
      failed = { status: e.status, stderr: e.stderr };
    }

    expect(failed?.status).toBe(1);
    expect(failed?.stderr).toContain("Task not found: stale");
    expect(failed?.stderr).toContain(
      "break-stop-and-stale-expiry — Break stop and stale expiry",
    );
    expect(failed?.stderr).not.toContain("checkout-wizard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work-on-task resolves an existing slug instead of creating a duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-repo-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Break stop and stale expiry"],
      { encoding: "utf8", env },
    );

    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "break-stop-and-stale-expiry",
        "--id",
        "claude-session-1",
        "--transcript",
        "/tmp/claude-session-1.jsonl",
        "--tool",
        "claude",
      ],
      { encoding: "utf8", env },
    );

    const taskList = execFileSync(
      process.execPath,
      [traceBin, "task", "list"],
      { encoding: "utf8", env },
    );
    const rows = taskList.trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Break stop and stale expiry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo skill prose is pruned to the bind verb and dispatches the host nudge", () => {
  const prose = execFileSync("sed", ["-n", "1,260p", skillReadme], {
    encoding: "utf8",
  });

  // What the shared dispatcher keeps: the We're-working-on-X bind verb and a
  // pointer to each host's binding flow.
  expect(prose).toContain("skill work-on-task");
  expect(prose).toContain("taskDocsDir");
  expect(prose.toLowerCase()).toContain("sentence case");
  expect(prose).toContain("resources/claude.md");
  expect(prose).toContain("resources/codex.md");

  // The Claude SessionStart no-task nudge now lives in its host resource, not
  // in the shared SKILL.md.
  const claudeResource = join(
    repoRoot,
    "plugin",
    "skills",
    "trace",
    "resources",
    "claude.md",
  );
  expect(readFileSync(claudeResource, "utf8")).toContain(
    "No active task for this session",
  );

  // The re-entry protocol and the board verb have moved to their own skills.
  // The dispatcher hands off to the trace-reenter skill rather than restating
  // the protocol here.
  expect(prose).toContain("trace-reenter");
  expect(prose.toLowerCase()).not.toContain("never paste raw transcripts");
  expect(prose).not.toContain("skill re-enter");
  expect(prose).not.toContain("trace serve listening on http://");
  expect(prose).not.toContain("Open the task board");
});
