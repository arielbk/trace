import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(branch = "main"): string {
  const root = mkdtempSync(join(tmpdir(), "trace-cli-git-"));
  git(root, "init", "-b", branch, "--quiet");
  git(root, "config", "user.email", "trace@example.com");
  git(root, "config", "user.name", "EQNX Tests");
  writeFileSync(join(root, "README.md"), "trace\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "initial");
  return realpathSync(root);
}

function envFor(databasePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TRACE_DB: databasePath };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.session_id;
  delete env.CODEX_THREAD_ID;
  return env;
}

function runTrace(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin = "",
): string {
  return execFileSync(process.execPath, [traceBin, ...args], {
    cwd,
    env,
    encoding: "utf8",
    input: stdin,
  });
}

test("re-enter reports last-worked-on branch from a primary checkout", () => {
  const cwd = createRepository("main");
  const env = envFor(join(cwd, "trace.sqlite"));

  try {
    runTrace(
      [
        "skill",
        "work-on-task",
        "Last work",
        "--id",
        "session-main",
        "--transcript",
        "/tmp/session-main.jsonl",
        "--tool",
        "claude",
      ],
      cwd,
      env,
    );

    const reentered = runTrace(["skill", "re-enter", "Last work"], cwd, env);
    expect(reentered).toContain("lastWorkedOn:\n  branch: main\n");
    expect(reentered).not.toContain("worktree:");
    expect(reentered).not.toMatch(/\bHEAD\b/);
    expect(reentered).not.toMatch(/\b[0-9a-f]{40}\b/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("re-enter reports a linked-worktree label and the latest session wins", () => {
  const mainRoot = createRepository("main");
  const container = mkdtempSync(join(tmpdir(), "trace-cli-wt-"));
  const worktreeRoot = join(container, "feature-checkout");
  const env = envFor(join(container, "trace.sqlite"));

  try {
    git(mainRoot, "worktree", "add", "-b", "feature-branch", "--quiet", worktreeRoot);

    runTrace(
      [
        "skill",
        "work-on-task",
        "Last work",
        "--id",
        "session-main",
        "--transcript",
        "/tmp/session-main.jsonl",
        "--tool",
        "claude",
      ],
      mainRoot,
      env,
    );
    runTrace(
      [
        "skill",
        "work-on-task",
        "Last work",
        "--id",
        "session-feature",
        "--transcript",
        "/tmp/session-feature.jsonl",
        "--tool",
        "claude",
      ],
      worktreeRoot,
      env,
    );

    const reentered = runTrace(
      ["skill", "re-enter", "Last work"],
      mainRoot,
      env,
    );
    expect(reentered).toContain("lastWorkedOn:\n  branch: feature-branch\n");
    expect(reentered).toContain(`  worktree: ${basename(worktreeRoot)}\n`);
    expect(reentered).not.toContain(realpathSync(worktreeRoot));
    expect(reentered).not.toMatch(/\b[0-9a-f]{40}\b/);
  } finally {
    rmSync(container, { recursive: true, force: true });
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test("the Stop hook re-samples the branch a bound session moved to", () => {
  const cwd = createRepository("main");
  const env = envFor(join(cwd, "trace.sqlite"));
  const transcript = join(cwd, "session-moving.jsonl");

  try {
    runTrace(
      [
        "skill",
        "work-on-task",
        "Moving work",
        "--id",
        "session-moving",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      cwd,
      env,
    );

    // The normal flow the re-entry manifest itself invites: bind on the branch
    // you arrived on, then cut the branch the work actually lands on.
    git(cwd, "checkout", "-b", "feature-deepen", "--quiet");

    runTrace(["hook", "stop"], cwd, env, JSON.stringify({
      hook_event_name: "Stop",
      session_id: "session-moving",
      transcript_path: transcript,
      cwd,
    }));

    // Read the manifest from an unbound invocation, so the answer comes from
    // what the Stop hook recorded rather than from a fresh bind.
    const reentered = runTrace(["skill", "re-enter", "Moving work"], cwd, env);
    expect(reentered).toContain("lastWorkedOn:\n  branch: feature-deepen\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the Stop hook leaves an unbound session's branch alone", () => {
  const cwd = createRepository("main");
  const env = envFor(join(cwd, "trace.sqlite"));
  const transcript = join(cwd, "session-bystander.jsonl");

  try {
    runTrace(
      [
        "skill",
        "work-on-task",
        "Bound work",
        "--id",
        "session-bound",
        "--transcript",
        join(cwd, "session-bound.jsonl"),
        "--tool",
        "claude",
      ],
      cwd,
      env,
    );
    runTrace(
      [
        "session",
        "register",
        "--id",
        "session-bystander",
        "--transcript",
        transcript,
        "--tool",
        "claude",
      ],
      cwd,
      env,
    );

    git(cwd, "checkout", "-b", "feature-bystander", "--quiet");

    runTrace(["hook", "stop"], cwd, env, JSON.stringify({
      hook_event_name: "Stop",
      session_id: "session-bystander",
      transcript_path: transcript,
      cwd,
    }));

    // The bystander is not bound to the task, so its turn must not relabel
    // where the task was last worked on.
    const reentered = runTrace(["skill", "re-enter", "Bound work"], cwd, env);
    expect(reentered).toContain("lastWorkedOn:\n  branch: main\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
