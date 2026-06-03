import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  parseClaudeCodeTranscript,
  scanClaudeCodeSessions,
} from "./claude-code-adapter.ts";

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

test("Claude Code transcript adapter skips unparseable lines and sums the rest", () => {
  const transcriptPath = fileURLToPath(
    new URL("./fixtures/claude-code-session.jsonl", import.meta.url),
  );
  const transcript =
    readFileSync(transcriptPath, "utf8").trimEnd() +
    '\n{"type":"assistant","session_id":"claude-session-1","usage":{"input_tok';

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

test("scanClaudeCodeSessions parses every transcript under a projects root and skips garbage", () => {
  const projectsRoot = mkdtempSync(join(tmpdir(), "claude-projects-"));
  const projectDir = join(projectsRoot, "-Users-someone-project");

  try {
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "session-a.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          session_id: "scan-session-a",
          message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 7 } },
        }),
      ].join("\n"),
    );
    writeFileSync(
      join(projectDir, "session-b.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          session_id: "scan-session-b",
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      ].join("\n"),
    );
    // A transcript with no session id can't be registered — it must be skipped,
    // not abort the whole scan.
    writeFileSync(
      join(projectDir, "garbage.jsonl"),
      `${JSON.stringify({ type: "summary", note: "no id here" })}\n`,
    );
    // Non-jsonl files are ignored.
    writeFileSync(join(projectDir, "notes.txt"), "ignore me");

    const sessions = scanClaudeCodeSessions(projectsRoot);

    expect(sessions.map((session) => session.id).sort()).toEqual([
      "scan-session-a",
      "scan-session-b",
    ]);
    const a = sessions.find((session) => session.id === "scan-session-a");
    expect(a?.tool).toBe("claude");
    expect(a?.model).toBe("claude-opus-4-7");
    expect(a?.tokenTotals.inputTokens).toBe(5);
  } finally {
    rmSync(projectsRoot, { recursive: true, force: true });
  }
});

test("scanClaudeCodeSessions returns nothing for a missing projects root", () => {
  expect(scanClaudeCodeSessions(join(tmpdir(), "does-not-exist-xyz"))).toEqual(
    [],
  );
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
