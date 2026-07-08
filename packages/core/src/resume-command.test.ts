import { describe, expect, test } from "vitest";
import { resumeCommand } from "./resume-command.ts";

describe("resumeCommand", () => {
  test("builds a Claude resume command", () => {
    expect(
      resumeCommand({
        tool: "claude",
        id: "claude-session-1",
        transcriptPath: "/tmp/claude-session-1.jsonl",
      }),
    ).toBe("claude --resume claude-session-1");
  });

  test("builds a Codex resume command", () => {
    expect(
      resumeCommand({
        tool: "codex",
        id: "codex-session-1",
        transcriptPath: "/tmp/codex-session-1.jsonl",
      }),
    ).toBe("codex resume codex-session-1");
  });

  test("yields no resume command for a Cursor GUI composer", () => {
    expect(
      resumeCommand({
        tool: "cursor",
        id: "composer-1",
        transcriptPath: "cursor:composer-1",
      }),
    ).toBeNull();
  });

  test("builds a cursor-agent resume command for a CLI chat", () => {
    expect(
      resumeCommand({
        tool: "cursor",
        id: "chat-1",
        transcriptPath: "/home/u/.cursor/projects/repo/agent-transcripts/chat-1/chat-1.jsonl",
      }),
    ).toBe("cursor-agent --resume chat-1");
  });
});
