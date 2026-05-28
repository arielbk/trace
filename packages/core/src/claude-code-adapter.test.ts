import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeCodeTranscript } from "./claude-code-adapter.ts";

test("Claude Code transcript adapter returns session identity and token totals", () => {
  const transcriptPath = resolve("packages/core/src/fixtures/claude-code-session.jsonl");
  const transcript = readFileSync(transcriptPath, "utf8");

  assert.deepEqual(parseClaudeCodeTranscript({ transcript, transcriptPath }), {
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
