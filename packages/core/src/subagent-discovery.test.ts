import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverClaudeCodeSubagentSessions, openTraceStore } from "./index.ts";

test("discovers Claude Code subagent transcripts under a parent session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-subagents-"));
  const databasePath = join(dir, "trace.sqlite");
  const projectDir = join(dir, "claude-project");
  const parentId = "parent-session";
  const parentTranscriptPath = join(projectDir, `${parentId}.jsonl`);
  const subagentsDir = join(projectDir, parentId, "subagents");
  const agentTranscriptPath = join(subagentsDir, "agent-researcher-1.jsonl");

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
                id: "toolu_research",
                name: "Task",
                input: {
                  subagent_type: "researcher",
                  description: "Collect evidence",
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
                tool_use_id: "toolu_research",
                content: [
                  { type: "text", text: "done" },
                  { type: "text", text: "agentId: researcher-1" },
                ],
              },
            ],
          },
          toolUseResult: { agentId: "researcher-1" },
        }),
      ].join("\n"),
    );
    writeFileSync(
      agentTranscriptPath,
      [
        JSON.stringify({
          type: "user",
          sessionId: parentId,
          agentId: "researcher-1",
          isSidechain: true,
          message: { role: "user", content: "Collect evidence" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: parentId,
          agentId: "researcher-1",
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 5, output_tokens: 7 },
          },
        }),
      ].join("\n"),
    );

    const store = openTraceStore(databasePath);
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: parentId,
      transcriptPath: parentTranscriptPath,
      tool: "claude",
    });
    store.assignSession(parent.id, task.id);

    const discovered = discoverClaudeCodeSubagentSessions({
      store,
      parentSessionId: parent.id,
    });
    const secondRun = discoverClaudeCodeSubagentSessions({
      store,
      parentSessionId: parent.id,
    });

    expect(discovered).toHaveLength(1);
    expect(secondRun).toEqual(discovered);
    expect(store.listSessionsForTask(task.id)).toEqual([
      expect.objectContaining({ id: parent.id, origin: "root" }),
      expect.objectContaining({
        transcriptPath: agentTranscriptPath,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "researcher",
        agentId: "researcher-1",
        model: "claude-sonnet-4-6",
        taskId: task.id,
        tokenTotals: expect.objectContaining({
          inputTokens: 5,
          outputTokens: 7,
          totalTokens: 12,
        }),
      }),
    ]);
    expect(readFileSync(agentTranscriptPath, "utf8")).toContain(
      '"isSidechain":true',
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
