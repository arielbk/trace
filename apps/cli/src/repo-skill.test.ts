import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));
const skillReadme = join(repoRoot, "skills", "trace", "SKILL.md");

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

test("repo skill prose carries the re-entry consumption protocol", () => {
  const prose = execFileSync("sed", ["-n", "1,220p", skillReadme], {
    encoding: "utf8",
  });

  const normalizedProse = prose.toLowerCase();

  expect(normalizedProse).toContain("read the decision docs first");
  expect(prose).toContain("transcript tail");
  expect(normalizedProse).toContain("never paste raw transcripts");
  expect(prose).toContain("taskDocsDir");
  expect(prose).toContain("Codex entry point");
});

test("repo skill prose treats the slug as the canonical re-enter ref", () => {
  const prose = execFileSync("sed", ["-n", "1,260p", skillReadme], {
    encoding: "utf8",
  });

  expect(prose).toContain('skill re-enter "break-stop-and-stale-expiry"');
  expect(prose.toLowerCase()).toContain("sentence case");
});

test("repo skill prose points users at trace serve without managing the server", () => {
  const prose = execFileSync("sed", ["-n", "1,260p", skillReadme], {
    encoding: "utf8",
  });

  expect(prose).toContain(
    'node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" serve',
  );
  expect(prose).toContain("trace serve listening on http://");
  expect(prose).toContain("Tell the user the URL");
  expect(prose).toContain("Do not start the server in the background");
  expect(prose).toContain("stops it with Ctrl-C");
});
