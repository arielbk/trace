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
const copilotFixture = fileURLToPath(
  new URL("./fixtures/copilot-session-1.events.jsonl", import.meta.url),
);

test("copilot adapter answers identity, model, output-only tokens, head, and tail", () => {
  const adapter = getTranscriptAdapter("copilot");
  const transcript = readFileSync(copilotFixture, "utf8");

  expect(adapter.tool).toBe("copilot");
  expect(adapter.parse({ transcript, transcriptPath: copilotFixture })).toEqual({
    id: "copilot-session-1",
    transcriptPath: copilotFixture,
    tool: "copilot",
    model: "gpt-5-mini",
    title: null,
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 37,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 37,
    },
  });
  expect(adapter.head({ transcript, limit: 8 })).toEqual([
    { role: "user", text: "Inspect the failing test" },
    { role: "user", text: "Run the focused suite" },
  ]);
  expect(adapter.tail({ transcript, limit: 2 })).toEqual([
    { role: "user", text: "Run the focused suite" },
    { role: "assistant", text: "The focused suite passes." },
  ]);
});

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
      inputTokens: 6,
      outputTokens: 29,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 11,
      totalTokens: 46,
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

const localMachine = { sessionMachineId: "machine-a", localMachineId: "machine-a" };

function includedBytes(tool: "claude" | "codex" | "copilot" | "cursor", path: string) {
  const result = getTranscriptAdapter(tool).exportTranscript({
    transcriptPath: path,
    ...localMachine,
  });
  expect(result.status).toBe("included");
  if (result.status !== "included") throw new Error("expected included transcript");
  return result;
}

test("exportTranscript copies a claude transcript byte-for-byte with its native format", () => {
  const exported = includedBytes("claude", claudeFixture);
  expect(exported.bytes).toEqual(new Uint8Array(readFileSync(claudeFixture)));
  expect(exported.format).toBe("claude-jsonl");
  expect(exported.extension).toBe(".jsonl");
});

test("exportTranscript copies a codex transcript byte-for-byte with its native format", () => {
  const exported = includedBytes("codex", codexFixture);
  expect(exported.bytes).toEqual(new Uint8Array(readFileSync(codexFixture)));
  expect(exported.format).toBe("codex-jsonl");
  expect(exported.extension).toBe(".jsonl");
});

test("exportTranscript copies a copilot transcript byte-for-byte with its native format", () => {
  const exported = includedBytes("copilot", copilotFixture);
  expect(exported.bytes).toEqual(new Uint8Array(readFileSync(copilotFixture)));
  expect(exported.format).toBe("copilot-jsonl");
  expect(exported.extension).toBe(".jsonl");
});

test("exportTranscript copies a Cursor agent-transcript locator byte-for-byte", () => {
  const exported = includedBytes("cursor", claudeFixture);
  expect(exported.bytes).toEqual(new Uint8Array(readFileSync(claudeFixture)));
  expect(exported.format).toBe("cursor-agent-jsonl");
  expect(exported.extension).toBe(".jsonl");
});

test("exportTranscript reports another-machine when the file is missing and machine ids differ", () => {
  expect(
    getTranscriptAdapter("claude").exportTranscript({
      transcriptPath: "/tmp/trace-export-missing-transcript.jsonl",
      sessionMachineId: "other-machine",
      localMachineId: "machine-a",
    }),
  ).toEqual({ status: "another-machine" });
});

test("exportTranscript reports file-gone when the path no longer exists on this machine", () => {
  expect(
    getTranscriptAdapter("claude").exportTranscript({
      transcriptPath: "/tmp/trace-export-missing-transcript.jsonl",
      ...localMachine,
    }),
  ).toEqual({ status: "file-gone" });
});

test("exportTranscript reports no-transcript-file for a Codex subagent synthetic locator", () => {
  expect(
    getTranscriptAdapter("codex").exportTranscript({
      transcriptPath: "codex:subagent-thread",
      ...localMachine,
    }),
  ).toEqual({ status: "no-transcript-file" });
});

test("exportTranscript reports no-transcript-file for a Cursor composer locator", () => {
  expect(
    getTranscriptAdapter("cursor").exportTranscript({
      transcriptPath: "cursor:composer-1",
      ...localMachine,
    }),
  ).toEqual({ status: "no-transcript-file" });
});
