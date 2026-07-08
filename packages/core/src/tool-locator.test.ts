import { expect, test } from "vitest";
import {
  getSessionLocator,
  sessionLocatorsByPrecedence,
  type LocateContext,
  type ToolSessionLocator,
} from "./tool-locator.ts";

test("looks up registered locators by tool and preserves precedence", () => {
  expect(sessionLocatorsByPrecedence.map((locator) => locator.tool)).toEqual([
    "codex",
    "claude",
    "cursor",
  ]);

  expect(getSessionLocator("codex").tool).toBe("codex");
  expect(getSessionLocator("claude").tool).toBe("claude");
  expect(getSessionLocator("cursor").tool).toBe("cursor");
});

test("throws when no locator is registered for a tool", () => {
  expect(() => getSessionLocator("unknown" as never)).toThrow(
    'No session locator registered for tool "unknown"',
  );
});

test("codex locator reads CODEX_THREAD_ID and CODEX_TRANSCRIPT_PATH", () => {
  const locator = getSessionLocator("codex");

  expect(
    locator.locate({
      env: {
        CODEX_THREAD_ID: " codex-thread-1 ",
        CODEX_TRANSCRIPT_PATH: " /tmp/codex.jsonl ",
      },
    }),
  ).toEqual({
    tool: "codex",
    id: "codex-thread-1",
    nativeTranscriptPath: "/tmp/codex.jsonl",
  });
});

test("codex locator collapses blank id and native transcript values", () => {
  const locator = getSessionLocator("codex");

  expect(
    locator.locate({
      env: {
        CODEX_THREAD_ID: "   ",
        CODEX_TRANSCRIPT_PATH: "   ",
      },
    }),
  ).toBeNull();
  expect(
    locator.locate({
      env: {
        CODEX_THREAD_ID: "codex-thread-1",
        CODEX_TRANSCRIPT_PATH: "   ",
      },
    }),
  ).toEqual({
    tool: "codex",
    id: "codex-thread-1",
    nativeTranscriptPath: undefined,
  });
});

test("claude locator reads the current and legacy session id env names", () => {
  const locator = getSessionLocator("claude");

  expect(
    locator.locate({
      env: {
        CLAUDE_CODE_SESSION_ID: " current ",
        CLAUDE_SESSION_ID: "legacy",
        session_id: "stdin",
        CLAUDE_TRANSCRIPT_PATH: " /tmp/claude.jsonl ",
      },
    }),
  ).toEqual({
    tool: "claude",
    id: "current",
    nativeTranscriptPath: "/tmp/claude.jsonl",
  });
  expect(locator.locate({ env: { CLAUDE_SESSION_ID: "legacy" } })?.id).toBe(
    "legacy",
  );
  expect(locator.locate({ env: { session_id: "stdin" } })?.id).toBe("stdin");
});

test("claude locator collapses blank ids and native transcript values", () => {
  const locator = getSessionLocator("claude");

  expect(
    locator.locate({
      env: {
        CLAUDE_CODE_SESSION_ID: "   ",
        CLAUDE_SESSION_ID: "   ",
        session_id: "   ",
        CLAUDE_TRANSCRIPT_PATH: "   ",
      },
    }),
  ).toBeNull();
  expect(
    locator.locate({
      env: {
        CLAUDE_CODE_SESSION_ID: "claude-session-1",
        CLAUDE_TRANSCRIPT_PATH: "   ",
      },
    }),
  ).toEqual({
    tool: "claude",
    id: "claude-session-1",
    nativeTranscriptPath: undefined,
  });
});

test("cursor locator resolves from cwd only when cursor context is available", () => {
  const locator = getSessionLocator("cursor");
  const ctx: LocateContext = {
    env: {},
    cwd: " /repos/trace-v2 ",
    resolveCursorSession: (cwd) =>
      cwd === "/repos/trace-v2"
        ? { id: " composer-abc ", transcriptPath: null }
        : null,
  };

  expect(locator.locate(ctx)).toEqual({
    tool: "cursor",
    id: "composer-abc",
    nativeTranscriptPath: undefined,
  });
  expect(
    locator.locate({
      env: {},
      resolveCursorSession: () => ({ id: "abc", transcriptPath: null }),
    }),
  ).toBeNull();
  expect(locator.locate({ env: {}, cwd: "/repo" })).toBeNull();
  expect(
    locator.locate({
      env: {},
      cwd: "/repo",
      resolveCursorSession: () => ({ id: "   ", transcriptPath: null }),
    }),
  ).toBeNull();
});

test("cursor locator carries the agent transcript path for a CLI chat", () => {
  const locator = getSessionLocator("cursor");
  const transcriptPath =
    "/home/u/.cursor/projects/repo/agent-transcripts/chat-1/chat-1.jsonl";

  expect(
    locator.locate({
      env: {},
      cwd: "/repo",
      resolveCursorSession: () => ({ id: "chat-1", transcriptPath }),
    }),
  ).toEqual({
    tool: "cursor",
    id: "chat-1",
    nativeTranscriptPath: transcriptPath,
  });
});

test("only the cursor locator consumes resolveCursorSession", () => {
  let resolverCalls = 0;
  const ctx: LocateContext = {
    env: {
      CODEX_THREAD_ID: "codex-thread-1",
      CLAUDE_CODE_SESSION_ID: "claude-session-1",
    },
    cwd: "/repos/trace-v2",
    resolveCursorSession: () => {
      resolverCalls += 1;
      return { id: "composer-abc", transcriptPath: null };
    },
  };

  expect(getSessionLocator("codex").locate(ctx)?.id).toBe("codex-thread-1");
  expect(getSessionLocator("claude").locate(ctx)?.id).toBe("claude-session-1");
  expect(resolverCalls).toBe(0);

  expect(getSessionLocator("cursor").locate(ctx)?.id).toBe("composer-abc");
  expect(resolverCalls).toBe(1);
});

test("a typed partial registry allows tools to be unregistered", () => {
  const partial: Partial<Record<ToolSessionLocator["tool"], ToolSessionLocator>> = {
    codex: getSessionLocator("codex"),
  };

  expect(partial.claude).toBeUndefined();
});
