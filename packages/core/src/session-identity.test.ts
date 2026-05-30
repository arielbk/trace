import { expect, test } from "vitest";
import { inferSessionIdentity } from "./index.ts";

test("infers a live Codex session from CODEX_THREAD_ID", () => {
  const identity = inferSessionIdentity({ CODEX_THREAD_ID: "codex-thread-1" });

  expect(identity).toEqual({
    tool: "codex",
    id: "codex-thread-1",
    transcriptPath: "codex:codex-thread-1",
  });
});

test("defaults to Claude and reads CLAUDE_CODE_SESSION_ID when no Codex env", () => {
  const identity = inferSessionIdentity({
    CLAUDE_CODE_SESSION_ID: "live-claude-session",
  });

  expect(identity).toEqual({
    tool: "claude",
    id: "live-claude-session",
    transcriptPath: "claude:live-claude-session",
  });
});

test("prefers CLAUDE_CODE_SESSION_ID over the legacy id names", () => {
  const identity = inferSessionIdentity({
    CLAUDE_CODE_SESSION_ID: "current",
    CLAUDE_SESSION_ID: "legacy",
    session_id: "stdin",
  });

  expect(identity.id).toBe("current");
});

test("falls back to CLAUDE_SESSION_ID then session_id for Claude", () => {
  expect(inferSessionIdentity({ CLAUDE_SESSION_ID: "legacy" }).id).toBe(
    "legacy",
  );
  expect(inferSessionIdentity({ session_id: "stdin" }).id).toBe("stdin");
});

test("uses CLAUDE_TRANSCRIPT_PATH for a Claude session when present", () => {
  const identity = inferSessionIdentity({
    CLAUDE_CODE_SESSION_ID: "s1",
    CLAUDE_TRANSCRIPT_PATH: "/tmp/claude.jsonl",
  });

  expect(identity.transcriptPath).toBe("/tmp/claude.jsonl");
});

test("uses CODEX_TRANSCRIPT_PATH for a Codex session when present", () => {
  const identity = inferSessionIdentity({
    CODEX_THREAD_ID: "t1",
    CODEX_TRANSCRIPT_PATH: "/tmp/codex.jsonl",
  });

  expect(identity.transcriptPath).toBe("/tmp/codex.jsonl");
});

test("ignores the other tool's transcript-path env var", () => {
  // A Claude session must not pick up CODEX_TRANSCRIPT_PATH, and vice versa.
  expect(
    inferSessionIdentity({
      CLAUDE_CODE_SESSION_ID: "s1",
      CODEX_TRANSCRIPT_PATH: "/tmp/codex.jsonl",
    }).transcriptPath,
  ).toBe("claude:s1");
});

test("leaves id and transcriptPath undefined when no session env is set", () => {
  const identity = inferSessionIdentity({});

  expect(identity).toEqual({
    tool: "claude",
    id: undefined,
    transcriptPath: undefined,
  });
});

test("a tool override redirects which env var supplies the id", () => {
  // No CODEX_THREAD_ID, but the caller forces codex: id stays undefined rather
  // than leaking the Claude session id.
  const identity = inferSessionIdentity(
    { CLAUDE_CODE_SESSION_ID: "claude-only" },
    { tool: "codex" },
  );

  expect(identity).toEqual({
    tool: "codex",
    id: undefined,
    transcriptPath: undefined,
  });
});

test("an explicit id override is used and feeds transcript-path synthesis", () => {
  const identity = inferSessionIdentity({}, { id: "explicit-id" });

  expect(identity).toEqual({
    tool: "claude",
    id: "explicit-id",
    transcriptPath: "claude:explicit-id",
  });
});

test("an explicit transcriptPath override wins over synthesis", () => {
  const identity = inferSessionIdentity(
    { CODEX_THREAD_ID: "t1" },
    { transcriptPath: "/custom/path.jsonl" },
  );

  expect(identity).toEqual({
    tool: "codex",
    id: "t1",
    transcriptPath: "/custom/path.jsonl",
  });
});
