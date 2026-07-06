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

test("Codex transcript adapter returns a null title (titles are out of scope)", () => {
  const transcript = readFileSync(codexFixture, "utf8");

  expect(
    parseCodexTranscript({
      transcript,
      transcriptPath: codexFixture,
      expectedThreadId: "codex-thread-1",
    }).title,
  ).toBe(null);
});

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
    title: null,
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
    title: null,
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
        title: null,
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

test("Codex Desktop transcript: parses session_meta id and token_count totals", () => {
  const transcriptPath =
    "/tmp/rollout-2026-06-11T17-42-35-019eb759-7cb3-7700-9370-77db8da46f94.jsonl";
  const transcript = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019eb759-7cb3-7700-9370-77db8da46f94" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 19728,
            cached_input_tokens: 4992,
            output_tokens: 396,
            total_tokens: 20124,
          },
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 42028,
            cached_input_tokens: 24320,
            output_tokens: 725,
            total_tokens: 42753,
          },
        },
      },
    }),
  ].join("\n");

  expect(parseCodexTranscript({ transcript, transcriptPath })).toEqual({
    id: "019eb759-7cb3-7700-9370-77db8da46f94",
    transcriptPath,
    tool: "codex",
    model: null,
    title: null,
    tokenTotals: {
      inputTokens: 42028,
      outputTokens: 725,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 24320,
      totalTokens: 42753,
    },
  });
});

test("Codex Desktop transcript: uses last token_count as cumulative total", () => {
  const transcriptPath = "/tmp/019eb759-7cb3-7700-9370-77db8da46f94.jsonl";
  const transcript = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019eb759-7cb3-7700-9370-77db8da46f94" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
        },
      },
    }),
  ].join("\n");

  const result = parseCodexTranscript({ transcript, transcriptPath });
  expect(result.tokenTotals.inputTokens).toBe(200);
  expect(result.tokenTotals.outputTokens).toBe(80);
  expect(result.tokenTotals.totalTokens).toBe(280);
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
