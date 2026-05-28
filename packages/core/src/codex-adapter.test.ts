import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseCodexTranscript } from "./codex-adapter.ts";

const codexFixture = fileURLToPath(
  new URL("./fixtures/codex-thread-1.jsonl", import.meta.url),
);

test("Codex transcript adapter validates identity and returns token totals", () => {
  const transcriptPath = codexFixture;
  const transcript = readFileSync(transcriptPath, "utf8");

  expect(parseCodexTranscript({
      transcript,
      transcriptPath,
      expectedThreadId: "codex-thread-1",
    })).toEqual({
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
    });
});

test("Codex transcript adapter rejects mismatched live thread identity", () => {
  const transcriptPath = codexFixture;
  const transcript = readFileSync(transcriptPath, "utf8");

  expect(() =>
      parseCodexTranscript({
        transcript,
        transcriptPath,
        expectedThreadId: "different-thread",
      })).toThrow(/does not match expected thread id/);
});
