import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

test("SubagentStop hook discovers finished Claude Code subagent sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-subagent-stop-"));
  const databasePath = join(dir, "trace.sqlite");
  const projectDir = join(dir, "claude-project");
  const parentId = "parent-session";
  const parentTranscriptPath = join(projectDir, `${parentId}.jsonl`);
  const subagentsDir = join(projectDir, parentId, "subagents");
  const agentTranscriptPath = join(subagentsDir, "agent-reviewer-1.jsonl");
  const env = { HOME: dir, TRACE_DB: databasePath };

  try {
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      parentTranscriptPath,
      [
        JSON.stringify({
          type: "assistant",
          session_id: parentId,
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_review",
                name: "Task",
                input: {
                  subagent_type: "reviewer",
                  description: "Review the hook wiring",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          session_id: parentId,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_review",
                content: "agentId: reviewer-1",
              },
            ],
          },
          toolUseResult: { agentId: "reviewer-1" },
        }),
      ].join("\n"),
    );
    writeFileSync(
      agentTranscriptPath,
      [
        JSON.stringify({
          type: "user",
          sessionId: parentId,
          agentId: "reviewer-1",
          isSidechain: true,
          message: { role: "user", content: "Review the hook wiring" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: parentId,
          agentId: "reviewer-1",
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        }),
      ].join("\n"),
    );

    const taskId = runTraceCli(
      ["task", "create", "parent task"],
      env,
    ).stdout.trim();
    runTraceCli(
      [
        "session",
        "register",
        "--id",
        parentId,
        "--transcript",
        parentTranscriptPath,
        "--tool",
        "claude",
      ],
      env,
    );
    runTraceCli(["session", "assign", parentId, taskId], env);

    const result = runTraceCli(
      ["hook", "subagent-stop"],
      env,
      process.cwd(),
      JSON.stringify({
        hook_event_name: "SubagentStop",
        session_id: parentId,
        transcript_path: parentTranscriptPath,
      }),
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const timeline = JSON.parse(
      runTraceCli(["task", "timeline", taskId, "--json"], env).stdout,
    ) as {
      items: Array<{
        type: string;
        session?: {
          parentSessionId: string | null;
          origin: string;
          subagentType: string | null;
          agentId: string | null;
        };
      }>;
    };

    expect(timeline.items).toContainEqual(
      expect.objectContaining({
        type: "session",
        session: expect.objectContaining({
          parentSessionId: parentId,
          origin: "subagent",
          subagentType: "reviewer",
          agentId: "reviewer-1",
        }),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
