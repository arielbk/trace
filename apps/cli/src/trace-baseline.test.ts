// Golden behavior harness for the citty migration.
// Asserts exit codes and key stdout/stderr patterns for every command/flag
// combination. Help/usage text is NOT asserted verbatim — it is the one
// permitted delta after migration. Tests here must stay green before and
// after the citty subtree is wired in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `trace-baseline-${prefix}-`));
}

function makeEnv(home: string): Record<string, string | undefined> {
  return { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
}

// ─── top-level dispatch ──────────────────────────────────────────────────────

test("unknown command exits 2 with usage on stderr", () => {
  const home = tmp("unknown");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["bogus"], makeEnv(home), sandbox);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("no args exits 2 with usage on stderr", () => {
  const home = tmp("noargs");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli([], makeEnv(home), sandbox);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── init ────────────────────────────────────────────────────────────────────

test("init exits 0 and describes installation", () => {
  const home = tmp("init");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["init"], makeEnv(home), sandbox);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    // Must mention the plugin-based install path — not the old CLAUDE.md approach.
    expect(r.stdout).toContain("plugin");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── hook ────────────────────────────────────────────────────────────────────

test("hook session-start registers session from stdin, exits 0", () => {
  const home = tmp("hook");
  const project = tmp("project");
  const transcript = join(project, "session.jsonl");
  writeFileSync(transcript, "");
  try {
    const r = runTraceCli(
      ["hook", "session-start"],
      makeEnv(home),
      project,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "baseline-hook-sess",
        transcript_path: transcript,
        cwd: project,
      }),
    );
    expect(r.exitCode).toBe(0);
    // Session must be queryable after hook fires.
    const listed = runTraceCli(
      ["session", "list", "--unassigned"],
      makeEnv(home),
      project,
    );
    expect(listed.stdout).toContain("baseline-hook-sess");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("hook with unknown action exits non-zero with usage on stderr", () => {
  const home = tmp("hook-bad");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["hook", "bogus-action"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task create ─────────────────────────────────────────────────────────────

test("task create exits 0 and outputs a slug on stdout", () => {
  const home = tmp("task-create");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    const r = runTraceCli(
      ["task", "create", "Baseline create"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toMatch(/^[a-z0-9-]+$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task create --help exits 0 with usage on stdout", () => {
  const home = tmp("task-create-help");
  const sandbox = tmp("sandbox");
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runTraceCli(["task", "create", flag], makeEnv(home), sandbox);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("task create with no title exits non-zero with usage on stderr", () => {
  const home = tmp("task-create-notitle");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["task", "create"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task update ─────────────────────────────────────────────────────────────

test("task update exits 0 and outputs task detail block", () => {
  const home = tmp("task-update");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    const created = runTraceCli(
      ["task", "create", "Update target"],
      makeEnv(home),
      repo,
    );
    const slug = created.stdout.trim();

    const r = runTraceCli(
      ["task", "update", slug, "--description", "Updated description"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("slug:");
    expect(r.stdout).toContain("id:");
    expect(r.stdout).toContain("title:");
    expect(r.stdout).toContain("description: Updated description");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task update --help exits 0 with usage on stdout", () => {
  const home = tmp("task-update-help");
  const sandbox = tmp("sandbox");
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runTraceCli(["task", "update", flag], makeEnv(home), sandbox);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task capture ─────────────────────────────────────────────────────────────

test("task capture exits 0 and outputs a task id on stdout", () => {
  const home = tmp("task-capture");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const docPath = join(repo, "spec.md");
  writeFileSync(docPath, "# Spec\n");
  try {
    const r = runTraceCli(
      ["task", "capture", "Baseline capture", "--doc", docPath],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task capture --help exits 0 with usage on stdout", () => {
  const home = tmp("task-capture-help");
  const sandbox = tmp("sandbox");
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runTraceCli(["task", "capture", flag], makeEnv(home), sandbox);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task show ────────────────────────────────────────────────────────────────

test("task show exits 0 and outputs all task fields", () => {
  const home = tmp("task-show");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    const created = runTraceCli(
      ["task", "create", "Show target"],
      makeEnv(home),
      repo,
    );
    const slug = created.stdout.trim();

    const r = runTraceCli(["task", "show", slug], makeEnv(home), repo);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("slug:");
    expect(r.stdout).toContain("id:");
    expect(r.stdout).toContain("title:");
    expect(r.stdout).toContain("createdAt:");
    expect(r.stdout).toContain("projectRoot:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task show with unknown ref exits 1 with not-found on stderr", () => {
  const home = tmp("task-show-missing");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["task", "show", "no-such-task"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not found");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("task show with no id exits non-zero", () => {
  const home = tmp("task-show-noid");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["task", "show"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task list ────────────────────────────────────────────────────────────────

test("task list exits 0, empty when no tasks", () => {
  const home = tmp("task-list-empty");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["task", "list"], makeEnv(home), sandbox);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("task list exits 0 and outputs slug tab title lines", () => {
  const home = tmp("task-list");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    runTraceCli(["task", "create", "List task one"], makeEnv(home), repo);
    runTraceCli(["task", "create", "List task two"], makeEnv(home), repo);

    const r = runTraceCli(["task", "list"], makeEnv(home), repo);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    // Each line is "slug\ttitle\n".
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toContain("\t");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── task timeline ────────────────────────────────────────────────────────────

test("task timeline --json exits 0 and outputs valid JSON", () => {
  const home = tmp("task-timeline");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    const created = runTraceCli(
      ["task", "create", "Timeline task"],
      makeEnv(home),
      repo,
    );
    const slug = created.stdout.trim();

    const r = runTraceCli(
      ["task", "timeline", slug, "--json"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as unknown;
    expect(parsed).toBeDefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task timeline without --json exits non-zero", () => {
  const home = tmp("task-timeline-nojson");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    const created = runTraceCli(
      ["task", "create", "Timeline no json"],
      makeEnv(home),
      repo,
    );
    const slug = created.stdout.trim();

    const r = runTraceCli(["task", "timeline", slug], makeEnv(home), repo);
    expect(r.exitCode).not.toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task timeline with unknown id exits 1", () => {
  const home = tmp("task-timeline-missing");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["task", "timeline", "no-such-task", "--json"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task add-doc ─────────────────────────────────────────────────────────────

test("task add-doc exits 0 and outputs slug tab path", () => {
  const home = tmp("task-adddoc");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const docPath = join(repo, "notes.md");
  writeFileSync(docPath, "# Notes\n");
  try {
    const created = runTraceCli(
      ["task", "create", "Add doc task"],
      makeEnv(home),
      repo,
    );
    const slug = created.stdout.trim();

    const r = runTraceCli(
      ["task", "add-doc", slug, docPath],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    // Output is "slug\tpath\n".
    expect(r.stdout).toContain(slug);
    expect(r.stdout).toContain(docPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task add-doc with unknown task exits 1", () => {
  const home = tmp("task-adddoc-missing");
  const sandbox = tmp("sandbox");
  const docPath = join(sandbox, "notes.md");
  try {
    const r = runTraceCli(
      ["task", "add-doc", "no-such-task", docPath],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── task (no action) ─────────────────────────────────────────────────────────

test("task with no action exits non-zero with usage on stderr", () => {
  const home = tmp("task-noaction");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["task"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── session register ─────────────────────────────────────────────────────────

test("session register exits 0 and outputs session id tab tool tab path", () => {
  const home = tmp("session-register");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    const r = runTraceCli(
      [
        "session",
        "register",
        "--id",
        "baseline-reg-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    // session register outputs just the session id, not the full summary.
    expect(r.stdout.trim()).toBe("baseline-reg-sess");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── session assign ───────────────────────────────────────────────────────────

test("session assign exits 0 and outputs session summary with task bound", () => {
  const home = tmp("session-assign");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    const created = runTraceCli(
      ["task", "create", "Assign target"],
      makeEnv(home),
      repo,
    );
    const slug = created.stdout.trim();

    const registered = runTraceCli(
      [
        "session",
        "register",
        "--id",
        "assign-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );
    expect(registered.exitCode).toBe(0);

    const r = runTraceCli(
      ["session", "assign", "assign-sess", slug],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("assign-sess");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── session active-task ──────────────────────────────────────────────────────

test("session active-task exits 0 and outputs JSON with kind field", () => {
  const home = tmp("session-activetask");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    runTraceCli(
      [
        "skill",
        "work-on-task",
        "Active task target",
        "--id",
        "active-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );

    const r = runTraceCli(
      ["session", "active-task", "--id", "active-sess"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as { kind: string };
    expect(["bound", "re-enter", "none"]).toContain(parsed.kind);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("session active-task without --id exits non-zero mentioning --id", () => {
  const home = tmp("session-activetask-noid");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["session", "active-task"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--id");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── session list --unassigned ────────────────────────────────────────────────

test("session list --unassigned exits 0, empty when no sessions", () => {
  const home = tmp("session-list-empty");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["session", "list", "--unassigned"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("session list --unassigned exits 0 and includes unassigned session lines", () => {
  const home = tmp("session-list");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "unassigned-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );

    const r = runTraceCli(
      ["session", "list", "--unassigned"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("unassigned-sess");
    expect(r.stdout).toContain("claude");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── session tail ─────────────────────────────────────────────────────────────

test("session tail exits 0 and returns empty output for empty transcript", () => {
  const home = tmp("session-tail");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    runTraceCli(
      [
        "session",
        "register",
        "--id",
        "tail-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );

    const r = runTraceCli(["session", "tail", "tail-sess"], makeEnv(home), repo);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("session tail with unknown session exits 1", () => {
  const home = tmp("session-tail-missing");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["session", "tail", "no-such-session"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("session tail without session id exits non-zero", () => {
  const home = tmp("session-tail-noid");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["session", "tail"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── session scan ─────────────────────────────────────────────────────────────

test("session scan --codex with empty home exits 0 and outputs nothing", () => {
  const home = tmp("session-scan-codex");
  const codexHome = tmp("codex-home");
  try {
    const r = runTraceCli(
      ["session", "scan", "--codex", "--codex-home", codexHome],
      makeEnv(home),
      home,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("session scan --claude with empty projects root exits 0 and outputs nothing", () => {
  const home = tmp("session-scan-claude");
  const projectsRoot = tmp("projects");
  try {
    const r = runTraceCli(
      ["session", "scan", "--claude", "--projects-root", projectsRoot],
      makeEnv(home),
      home,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectsRoot, { recursive: true, force: true });
  }
});

// ─── session (no action) ──────────────────────────────────────────────────────

test("session with no action exits non-zero with usage on stderr", () => {
  const home = tmp("session-noaction");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["session"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── skill work-on-task ───────────────────────────────────────────────────────

test("skill work-on-task exits 0 and outputs taskDocsDir on stdout", () => {
  const home = tmp("skill-wot");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    const r = runTraceCli(
      [
        "skill",
        "work-on-task",
        "Work on task target",
        "--id",
        "wot-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("taskDocsDir:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("skill work-on-task --help exits 0 with usage on stdout", () => {
  const home = tmp("skill-wot-help");
  const sandbox = tmp("sandbox");
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runTraceCli(
        ["skill", "work-on-task", flag],
        makeEnv(home),
        sandbox,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill work-on-task without session id exits non-zero", () => {
  const home = tmp("skill-wot-nosess");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["skill", "work-on-task", "Some task"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).not.toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── skill recall-candidates ──────────────────────────────────────────────────

test("skill recall-candidates exits 0 and outputs a JSON array", () => {
  const home = tmp("skill-recall");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["skill", "recall-candidates"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── skill re-enter ───────────────────────────────────────────────────────────

test("skill re-enter exits 0 and outputs manifest with required fields", () => {
  const home = tmp("skill-reenter");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  try {
    runTraceCli(["task", "create", "Re-enter target"], makeEnv(home), repo);

    const r = runTraceCli(
      ["skill", "re-enter", "Re-enter target"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("task:");
    expect(r.stdout).toContain("taskDocsDir:");
    expect(r.stdout).toContain("docs:");
    expect(r.stdout).toContain("sessions:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("skill re-enter --help exits 0 with usage on stdout", () => {
  const home = tmp("skill-reenter-help");
  const sandbox = tmp("sandbox");
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runTraceCli(
        ["skill", "re-enter", flag],
        makeEnv(home),
        sandbox,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill re-enter with unknown ref exits 1", () => {
  const home = tmp("skill-reenter-missing");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(
      ["skill", "re-enter", "no-such-task"],
      makeEnv(home),
      sandbox,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill re-enter with no ref exits non-zero with usage on stderr", () => {
  const home = tmp("skill-reenter-noref");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["skill", "re-enter"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── skill docs-dir ───────────────────────────────────────────────────────────

test("skill docs-dir exits 0 and outputs taskDocsDir: <path> when session is bound", () => {
  const home = tmp("skill-docsdir");
  const repo = tmp("repo");
  mkdirSync(join(repo, ".git"));
  const transcript = join(repo, "sess.jsonl");
  writeFileSync(transcript, "");
  try {
    runTraceCli(
      [
        "skill",
        "work-on-task",
        "Docs dir task",
        "--id",
        "docsdir-sess",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      makeEnv(home),
      repo,
    );

    const r = runTraceCli(
      ["skill", "docs-dir", "--id", "docsdir-sess"],
      makeEnv(home),
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^taskDocsDir: .+\n$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("skill docs-dir --help exits 0 with usage on stdout", () => {
  const home = tmp("skill-docsdir-help");
  const sandbox = tmp("sandbox");
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runTraceCli(
        ["skill", "docs-dir", flag],
        makeEnv(home),
        sandbox,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill docs-dir without --id and no session env exits non-zero", () => {
  const home = tmp("skill-docsdir-noid");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["skill", "docs-dir"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ─── skill (no action) ────────────────────────────────────────────────────────

test("skill with no action exits non-zero with usage on stderr", () => {
  const home = tmp("skill-noaction");
  const sandbox = tmp("sandbox");
  try {
    const r = runTraceCli(["skill"], makeEnv(home), sandbox);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});
