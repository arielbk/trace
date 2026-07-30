import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("Copilot sessionStart payload registers a Copilot session", () => {
  const home = tmp("trace-copilot-hook-home-");
  const project = tmp("trace-copilot-hook-project-");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    const result = runTraceCli(
      ["hook", "session-start"],
      env,
      project,
      JSON.stringify({
        hookEventName: "sessionStart",
        sessionId: "copilot-session-1",
        timestamp: 1_752_592_800_000,
        cwd: project,
      }),
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(runTraceCli(["session", "list", "--unassigned"], env).stdout).toBe(
      "copilot-session-1\tcopilot\tcopilot:copilot-session-1\n",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("Copilot agentStop payload performs the same state freshness check as Claude Stop", () => {
  const home = tmp("trace-copilot-stop-home-");
  const repoParent = tmp("trace-copilot-stop-repo-");
  const repo = join(repoParent, "repo");
  const env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };

  try {
    mkdirSync(join(repo, ".git"), { recursive: true });
    const slug = runTraceCli(["task", "create", "Copilot drift"], env, repo).stdout.trim();
    const notes = join(repo, "notes.md");
    writeFileSync(notes, "# Notes\nDrifted work.\n");
    runTraceCli(["task", "add-doc", slug, notes], env, repo);
    runTraceCli(
      ["session", "register", "--id", "copilot-session-2", "--transcript", join(repo, "events.jsonl"), "--tool", "copilot"],
      env,
      repo,
    );
    runTraceCli(["session", "assign", "copilot-session-2", slug], env, repo);

    const result = runTraceCli(
      ["hook", "stop"],
      env,
      repo,
      JSON.stringify({
        hookEventName: "agentStop",
        sessionId: "copilot-session-2",
        timestamp: 1_752_592_800_001,
        cwd: repo,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining(`trace state reflect ${slug}`),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});

test("Copilot subagentStop payload is accepted while subagent linkage remains a separate scanner", () => {
  const result = runTraceCli(
    ["hook", "subagent-stop"],
    {},
    process.cwd(),
    JSON.stringify({
      hookEventName: "subagentStop",
      sessionId: "copilot-session-3",
      timestamp: 1_752_592_800_002,
      cwd: process.cwd(),
    }),
  );

  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
