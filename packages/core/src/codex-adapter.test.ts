import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexTranscript } from "./codex-adapter.ts";

test("Codex transcript adapter validates identity and returns token totals", () => {
  const transcriptPath = resolve("packages/core/src/fixtures/codex-thread-1.jsonl");
  const transcript = readFileSync(transcriptPath, "utf8");

  assert.deepEqual(
    parseCodexTranscript({
      transcript,
      transcriptPath,
      expectedThreadId: "codex-thread-1",
    }),
    {
      id: "codex-thread-1",
      transcriptPath,
      tool: "codex",
      tokenTotals: {
        inputTokens: 17,
        outputTokens: 29,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 11,
        totalTokens: 57,
      },
    },
  );
});

test("Codex transcript adapter rejects mismatched live thread identity", () => {
  const transcriptPath = resolve("packages/core/src/fixtures/codex-thread-1.jsonl");
  const transcript = readFileSync(transcriptPath, "utf8");

  assert.throws(
    () =>
      parseCodexTranscript({
        transcript,
        transcriptPath,
        expectedThreadId: "different-thread",
      }),
    /does not match expected thread id/,
  );
});
