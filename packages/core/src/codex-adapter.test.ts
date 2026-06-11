import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseCodexTranscript, scanCodexSessions } from "./codex-adapter.ts";

const codexFixture = fileURLToPath(
  new URL("./fixtures/codex-thread-1.jsonl", import.meta.url),
);

test("Codex transcript adapter validates identity and returns token totals", () => {
  const transcriptPath = codexFixture;
  const transcript = readFileSync(transcriptPath, "utf8");

  expect(
    parseCodexTranscript({
      transcript,
      transcriptPath,
      expectedThreadId: "codex-thread-1",
    }),
  ).toEqual({
    id: "codex-thread-1",
    transcriptPath,
    tool: "codex",
    model: "gpt-5-codex",
    tokenTotals: {
      inputTokens: 17,
      outputTokens: 29,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 11,
      totalTokens: 57,
    },
  });
});

test("Codex transcript adapter skips unparseable lines and sums the rest", () => {
  const transcriptPath = codexFixture;
  const transcript =
    readFileSync(transcriptPath, "utf8").trimEnd() +
    '\n{"type":"turn.completed","usage":{"input_tok';

  expect(
    parseCodexTranscript({
      transcript,
      transcriptPath,
      expectedThreadId: "codex-thread-1",
    }),
  ).toEqual({
    id: "codex-thread-1",
    transcriptPath,
    tool: "codex",
    model: "gpt-5-codex",
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
    }),
  ).toThrow(/does not match expected thread id/);
});

test("Codex transcript adapter returns null when model is absent", () => {
  const transcriptPath = "/tmp/codex-without-model.jsonl";
  const transcript = [
    JSON.stringify({
      type: "thread.started",
      thread_id: "codex-without-model",
    }),
  ].join("\n");

  expect(parseCodexTranscript({ transcript, transcriptPath }).model).toBe(null);
});

test("Codex scan falls back to sessions when index entries have no transcript paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-pathless-index-"));
  const sessionsDir = join(dir, "sessions");
  const transcriptPath = join(sessionsDir, "codex-thread-1.jsonl");

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(dir, "session_index.jsonl"),
      `${JSON.stringify({ id: "metadata-only", thread_name: "No path" })}\n`,
    );
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    );

    expect(scanCodexSessions(dir)).toEqual([
      {
        id: "codex-thread-1",
        transcriptPath,
        tool: "codex",
        model: null,
        tokenTotals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 0,
        },
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex scan skips unparseable transcript files", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-skip-bad-"));
  const sessionsDir = join(dir, "sessions");
  const validPath = join(sessionsDir, "codex-thread-1.jsonl");
  const invalidPath = join(sessionsDir, "bad.jsonl");

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      validPath,
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    );
    writeFileSync(invalidPath, JSON.stringify({ type: "turn.completed" }));

    expect(scanCodexSessions(dir).map((session) => session.id)).toEqual([
      "codex-thread-1",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
