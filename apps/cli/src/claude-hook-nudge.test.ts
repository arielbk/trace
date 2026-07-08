import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";
import { runClaudeSessionStartHook } from "./claude-session-start-hook-runner.ts";

// A SessionStart hook's stdout is surfaced to Claude as additional context. The
// hook does double duty: register the session, then emit exactly one nudge line
// derived from the session's active task — a quiet confirmation when bound, an
// offer to re-enter or start tracking when not.

function setupRepo(): {
  dir: string;
  repo: string;
  env: Record<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), "trace-hook-nudge-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  return {
    dir,
    repo,
    env: { HOME: dir, TRACE_DB: join(dir, "trace.sqlite") },
  };
}

test("a bound session gets a quiet tracking confirmation", () => {
  const { dir, repo, env } = setupRepo();
  try {
    runTraceCli(
      [
        "skill",
        "work-on-task",
        "Checkout flow",
        "--id",
        "session-bound",
        "--transcript",
        join(repo, "s.jsonl"),
        "--tool",
        "claude",
        "--project",
        repo,
      ],
      env,
      repo,
    );

    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "session-bound",
        transcript_path: join(repo, "s.jsonl"),
        cwd: repo,
        source: "resume",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("✓ Trace tracking: Checkout flow\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unbound session in a known project is offered re-entry of the recent task", () => {
  const { dir, repo, env } = setupRepo();
  try {
    runTraceCli(["task", "create", "Prior work", "--project", repo], env, repo);

    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "session-unbound",
        transcript_path: join(repo, "s.jsonl"),
        cwd: repo,
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Prior work");
    expect(result.stdout).toContain("re-enter");
    // Exactly one line.
    expect(result.stdout.trimEnd()).not.toContain("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unbound session in a fresh project is nudged to start tracking", () => {
  const { dir, repo, env } = setupRepo();
  try {
    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "session-fresh",
        transcript_path: join(repo, "s.jsonl"),
        cwd: repo,
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no task");
    expect(result.stdout).toContain("start tracking");
    expect(result.stdout.trimEnd()).not.toContain("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the session is still registered before the nudge is resolved", () => {
  const { dir, repo, env } = setupRepo();
  try {
    runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "session-registered",
        transcript_path: join(repo, "s.jsonl"),
        cwd: repo,
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    const unassigned = runTraceCli(["session", "list", "--unassigned"], env);
    expect(unassigned.stdout).toContain("session-registered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing active-task lookup degrades to a registered session with no nudge and a breadcrumb", () => {
  const { dir, env } = setupRepo();
  try {
    // A cwd that does not exist makes the active-task project resolution fail,
    // while session registration (which does not touch the project root) still
    // succeeds — the additive nudge must never take the registration down.
    const missingCwd = join(dir, "gone");

    const result = runClaudeSessionStartHook(
      JSON.stringify({
        session_id: "session-degrade",
        transcript_path: join(dir, "s.jsonl"),
        cwd: missingCwd,
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    // The session was still registered.
    const unassigned = runTraceCli(["session", "list", "--unassigned"], env);
    expect(unassigned.stdout).toContain("session-degrade");

    // The failure left an inspectable breadcrumb beside the db.
    const logPath = join(dir, "hook-errors.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("session-degrade");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
