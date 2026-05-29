import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  readTranscriptTail,
  tailTranscriptMessages,
} from "./transcript-tail.ts";

const claudeFixture = fileURLToPath(
  new URL("./fixtures/claude-code-session.jsonl", import.meta.url),
);
const codexFixture = fileURLToPath(
  new URL("./fixtures/codex-thread-1.jsonl", import.meta.url),
);

test("tails the last N Claude human and assistant messages in order", () => {
  expect(
    tailTranscriptMessages({
      transcript: readFileSync(claudeFixture, "utf8"),
      tool: "claude",
      limit: 2,
    }),
  ).toEqual([
    { role: "assistant", text: "Use task docs first." },
    { role: "user", text: "Run the focused tests" },
  ]);
});

test("tails the last N Codex human and assistant messages in order", () => {
  expect(
    tailTranscriptMessages({
      transcript: readFileSync(codexFixture, "utf8"),
      tool: "codex",
      limit: 2,
    }),
  ).toEqual([
    { role: "user", text: "Run tests" },
    { role: "assistant", text: "Tests pass" },
  ]);
});

test("returns empty for malformed, empty, and missing transcripts", () => {
  expect(
    tailTranscriptMessages({
      transcript: "{not-json}\n",
      tool: "claude",
      limit: 5,
    }),
  ).toEqual([]);
  expect(
    tailTranscriptMessages({ transcript: "", tool: "codex", limit: 5 }),
  ).toEqual([]);
  expect(
    readTranscriptTail({
      transcriptPath: "/tmp/trace-missing-transcript.jsonl",
      tool: "codex",
      limit: 5,
    }),
  ).toEqual([]);
});
