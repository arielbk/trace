import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseClaudeCodeTranscript } from "./claude-code-adapter.ts";

test("Claude Code transcript adapter returns session identity and token totals", () => {
  const transcriptPath = fileURLToPath(
    new URL("./fixtures/claude-code-session.jsonl", import.meta.url),
  );
  const transcript = readFileSync(transcriptPath, "utf8");

  expect(parseClaudeCodeTranscript({ transcript, transcriptPath })).toEqual({
    id: "claude-session-1",
    transcriptPath,
    tool: "claude",
    model: "claude-opus-4-7",
    tokenTotals: {
      inputTokens: 13,
      outputTokens: 25,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 6,
      totalTokens: 48,
    },
  });
});

test("Claude Code transcript adapter returns null when model is absent", () => {
  const transcriptPath = "/tmp/claude-without-model.jsonl";
  const transcript = [
    JSON.stringify({
      type: "system",
      session_id: "claude-session-without-model",
      message: { usage: { input_tokens: 1, output_tokens: 2 } },
    }),
  ].join("\n");

  expect(parseClaudeCodeTranscript({ transcript, transcriptPath }).model).toBe(
    null,
  );
});
