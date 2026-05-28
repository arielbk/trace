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
    tokenTotals: {
      inputTokens: 13,
      outputTokens: 25,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 6,
      totalTokens: 48,
    },
  });
});
