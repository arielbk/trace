import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Drive the main-agent Stop hook through the same `trace hook stop` seam the
// plugin's hooks.json uses. Returns the parsed JSON verdict (when stdout is
// JSON) plus the raw result so tests can assert on either.
function runStopHook(
  env: Record<string, string | undefined>,
  cwd: string,
  payload: Record<string, unknown>,
): {
  exitCode: number;
  stdout: string;
  stderr: string;
  decision?: string;
  reason?: string;
} {
  const result = runTraceCli(
    ["hook", "stop"],
    env,
    cwd,
    JSON.stringify({ hook_event_name: "Stop", ...payload }),
  );
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as {
      decision?: string;
      reason?: string;
    };
    return { ...result, ...parsed };
  }
  return result;
}

test("Stop hook blocks with a reflect reason when a bound task's prose has drifted", () => {
  const home = tmp("trace-stop-home-");
  const repoParent = tmp("trace-stop-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const slug = runTraceCli(["task", "create", "Drift task"], env, repo)
      .stdout.trim();

    // A non-state doc materializes state.md with a footer but no prose yet.
    const notesPath = join(repo, "notes.md");
    writeFileSync(notesPath, "# Notes\nSome notes.\n");
    runTraceCli(["task", "add-doc", slug, notesPath], env, repo);

    const sessionId = "stop-session";
    const transcriptPath = join(repo, `${sessionId}.jsonl`);
    runTraceCli(
      [
        "session",
        "register",
        "--id",
        sessionId,
        "--transcript",
        transcriptPath,
        "--tool",
        "claude",
      ],
      env,
      repo,
    );
    runTraceCli(["session", "assign", sessionId, slug], env, repo);

    const result = runStopHook(env, repo, {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("block");
    // The reason routes the warm agent at the skill that owns the state.md
    // template, and still names the reflect command that stamps it.
    expect(result.reason).toContain("trace-state");
    expect(result.reason).toContain(`trace state reflect ${slug}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("Stop hook ends the turn normally once the prose is reconciled", () => {
  const home = tmp("trace-stop-home-");
  const repoParent = tmp("trace-stop-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    const slug = runTraceCli(["task", "create", "Reconciled task"], env, repo)
      .stdout.trim();
    const notesPath = join(repo, "notes.md");
    writeFileSync(notesPath, "# Notes\nSome notes.\n");
    runTraceCli(["task", "add-doc", slug, notesPath], env, repo);

    const sessionId = "stop-session";
    const transcriptPath = join(repo, `${sessionId}.jsonl`);
    runTraceCli(
      ["session", "register", "--id", sessionId, "--transcript", transcriptPath, "--tool", "claude"],
      env,
      repo,
    );
    runTraceCli(["session", "assign", sessionId, slug], env, repo);

    // Write living-state prose, then stamp the fingerprint marker so the docs
    // and prose are reconciled — exactly what the block's reason instructs.
    const statePath = JSON.parse(
      runTraceCli(["state", "check", slug], env, repo).stdout,
    ).statePath as string;
    writeFileSync(statePath, "# Reconciled task\n\nThe living state.\n");
    runTraceCli(["state", "reflect", slug], env, repo);

    const result = runStopHook(env, repo, {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.decision).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("Stop hook never blocks an unbound session, even when the project has a drifted task", () => {
  const home = tmp("trace-stop-home-");
  const repoParent = tmp("trace-stop-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    // A drifted task exists in the project — but is bound to nobody.
    const slug = runTraceCli(["task", "create", "Someone else's task"], env, repo)
      .stdout.trim();
    const notesPath = join(repo, "notes.md");
    writeFileSync(notesPath, "# Notes\nSome notes.\n");
    runTraceCli(["task", "add-doc", slug, notesPath], env, repo);

    // This session is registered but never assigned to any task.
    const sessionId = "unbound-session";
    const transcriptPath = join(repo, `${sessionId}.jsonl`);
    runTraceCli(
      ["session", "register", "--id", sessionId, "--transcript", transcriptPath, "--tool", "claude"],
      env,
      repo,
    );

    const result = runStopHook(env, repo, {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });

    // Strict binding: the most-recent-task fallback must NOT pull the drifted
    // task in. An ordinary chat turn ends normally.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.decision).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("Stop hook resolves the binding live, seeing a task bound after the session started", () => {
  const home = tmp("trace-stop-home-");
  const repoParent = tmp("trace-stop-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });

    // Session registers first, while unbound (as SessionStart would leave it).
    const sessionId = "live-session";
    const transcriptPath = join(repo, `${sessionId}.jsonl`);
    runTraceCli(
      ["session", "register", "--id", sessionId, "--transcript", transcriptPath, "--tool", "claude"],
      env,
      repo,
    );

    // Later in the same session: a task is created, given a doc, and bound.
    const slug = runTraceCli(["task", "create", "Late-bound task"], env, repo)
      .stdout.trim();
    const notesPath = join(repo, "notes.md");
    writeFileSync(notesPath, "# Notes\nSome notes.\n");
    runTraceCli(["task", "add-doc", slug, notesPath], env, repo);
    runTraceCli(["session", "assign", sessionId, slug], env, repo);

    const result = runStopHook(env, repo, {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });

    // The hook re-reads the binding at stop time, so the late binding is seen
    // and the drift blocks.
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("block");
    expect(result.reason).toContain(`trace state reflect ${slug}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});
