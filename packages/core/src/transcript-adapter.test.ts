import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { getTranscriptAdapter } from "./transcript-adapter.ts";

const claudeFixture = fileURLToPath(
  new URL("./fixtures/claude-code-session.jsonl", import.meta.url),
);
const codexFixture = fileURLToPath(
  new URL("./fixtures/codex-thread-1.jsonl", import.meta.url),
);

test("claude adapter answers identity, model, tokens, and message tail", () => {
  const adapter = getTranscriptAdapter("claude");
  const transcript = readFileSync(claudeFixture, "utf8");

  expect(adapter.tool).toBe("claude");
  expect(adapter.parse({ transcript, transcriptPath: claudeFixture })).toEqual({
    id: "claude-session-1",
    transcriptPath: claudeFixture,
    tool: "claude",
    model: "claude-opus-4-7",
    title: null,
    tokenTotals: {
      inputTokens: 13,
      outputTokens: 25,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 6,
      totalTokens: 48,
    },
  });
  expect(adapter.tail({ transcript, limit: 2 })).toEqual([
    { role: "assistant", text: "Use task docs first." },
    { role: "user", text: "Run the focused tests" },
  ]);
});

test("codex adapter answers identity, tokens, tail, and honors expected id", () => {
  const adapter = getTranscriptAdapter("codex");
  const transcript = readFileSync(codexFixture, "utf8");

  expect(adapter.tool).toBe("codex");
  expect(
    adapter.parse({
      transcript,
      transcriptPath: codexFixture,
      expectedId: "codex-thread-1",
    }),
  ).toEqual({
    id: "codex-thread-1",
    transcriptPath: codexFixture,
    tool: "codex",
    model: "gpt-5-codex",
    title: null,
    subagentSpawns: [],
    subagentSource: null,
    tokenTotals: {
      inputTokens: 17,
      outputTokens: 29,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 11,
      totalTokens: 57,
    },
  });
  expect(() =>
    adapter.parse({
      transcript,
      transcriptPath: codexFixture,
      expectedId: "different-thread",
    }),
  ).toThrow(/does not match expected thread id/);
  expect(adapter.tail({ transcript, limit: 2 })).toEqual([
    { role: "user", text: "Run tests" },
    { role: "assistant", text: "Tests pass" },
  ]);
});

test("adapters surface the first user messages as the head, per tool", () => {
  const claudeTranscript = readFileSync(claudeFixture, "utf8");
  expect(
    getTranscriptAdapter("claude").head({ transcript: claudeTranscript, limit: 1 }),
  ).toEqual([{ role: "user", text: "Plan checkout flow" }]);

  const codexTranscript = readFileSync(codexFixture, "utf8");
  expect(
    getTranscriptAdapter("codex").head({ transcript: codexTranscript, limit: 8 }),
  ).toEqual([
    { role: "user", text: "Inspect failing test" },
    { role: "user", text: "Run tests" },
  ]);
});

test("readHead reads from disk and returns empty for a missing transcript", () => {
  expect(
    getTranscriptAdapter("codex").readHead({
      transcriptPath: "/tmp/trace-missing-adapter-transcript.jsonl",
      limit: 5,
    }),
  ).toEqual([]);
  expect(
    getTranscriptAdapter("codex").readHead({
      transcriptPath: codexFixture,
      limit: 8,
    }),
  ).toEqual([
    { role: "user", text: "Inspect failing test" },
    { role: "user", text: "Run tests" },
  ]);
});

test("readTail reads from disk and returns empty for a missing transcript", () => {
  expect(
    getTranscriptAdapter("codex").readTail({
      transcriptPath: "/tmp/trace-missing-adapter-transcript.jsonl",
      limit: 5,
    }),
  ).toEqual([]);
  expect(
    getTranscriptAdapter("claude").readTail({
      transcriptPath: claudeFixture,
      limit: 2,
    }),
  ).toEqual([
    { role: "assistant", text: "Use task docs first." },
    { role: "user", text: "Run the focused tests" },
  ]);
});
