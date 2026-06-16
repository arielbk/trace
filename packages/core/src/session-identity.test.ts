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

test("prefers codex over claude over cursor when detecting the live session", () => {
  let resolverCalls = 0;
  const identity = inferSessionIdentity(
    {
      CODEX_THREAD_ID: "codex-thread-1",
      CLAUDE_CODE_SESSION_ID: "claude-session-1",
    },
    {
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => {
        resolverCalls += 1;
        return "composer-abc";
      },
    },
  );

  expect(identity).toEqual({
    tool: "codex",
    id: "codex-thread-1",
    transcriptPath: "codex:codex-thread-1",
  });
  expect(resolverCalls).toBe(0);
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

test("uses the chosen tool's transcript-path env var even when id is overridden", () => {
  expect(
    inferSessionIdentity(
      { CLAUDE_TRANSCRIPT_PATH: "/tmp/claude-from-env.jsonl" },
      { tool: "claude", id: "manual-claude-id" },
    ),
  ).toEqual({
    tool: "claude",
    id: "manual-claude-id",
    transcriptPath: "/tmp/claude-from-env.jsonl",
  });
  expect(
    inferSessionIdentity(
      { CODEX_TRANSCRIPT_PATH: "/tmp/codex-from-env.jsonl" },
      { tool: "codex", id: "manual-codex-id" },
    ),
  ).toEqual({
    tool: "codex",
    id: "manual-codex-id",
    transcriptPath: "/tmp/codex-from-env.jsonl",
  });
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

test("treats blank session-id env values as absent", () => {
  // A hook can export CLAUDE_CODE_SESSION_ID with an empty or whitespace-only
  // value; that must read as "no session" here, not survive to registration
  // (which trims and rejects it after callers have already mutated state).
  for (const blank of ["", "   "]) {
    expect(inferSessionIdentity({ CLAUDE_CODE_SESSION_ID: blank })).toEqual({
      tool: "claude",
      id: undefined,
      transcriptPath: undefined,
    });
  }
});

test("trims surrounding whitespace from inferred ids", () => {
  // Registration trims before storing, so the inferred id must match what
  // would be persisted — including in the synthesized transcript path.
  expect(inferSessionIdentity({ CLAUDE_CODE_SESSION_ID: " s1 " })).toEqual({
    tool: "claude",
    id: "s1",
    transcriptPath: "claude:s1",
  });
});

test("a blank id override falls back to env inference", () => {
  const identity = inferSessionIdentity(
    { CLAUDE_CODE_SESSION_ID: "env-id" },
    { id: "   " },
  );

  expect(identity.id).toBe("env-id");
});

test("a blank CLAUDE_TRANSCRIPT_PATH falls back to synthesis", () => {
  expect(
    inferSessionIdentity({
      CLAUDE_CODE_SESSION_ID: "s1",
      CLAUDE_TRANSCRIPT_PATH: "   ",
    }).transcriptPath,
  ).toBe("claude:s1");
});

test("a blank CODEX_THREAD_ID does not select the codex tool", () => {
  expect(
    inferSessionIdentity({
      CODEX_THREAD_ID: "   ",
      CLAUDE_CODE_SESSION_ID: "c1",
    }).tool,
  ).toBe("claude");
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

test("resolves a cursor composer from cwd when no other session env is set", () => {
  // Binding from a Cursor terminal: no claude/codex env var, but the cwd maps to
  // a Cursor workspace whose focused composer is resolved. The GUI sets no env
  // var trace can read, so the composerId is the only driver.
  const identity = inferSessionIdentity(
    {},
    {
      cwd: "/repos/trace-v2",
      resolveCursorComposer: (cwd) =>
        cwd === "/repos/trace-v2" ? "composer-abc" : null,
    },
  );

  expect(identity).toEqual({
    tool: "cursor",
    id: "composer-abc",
    transcriptPath: "cursor:composer-abc",
  });
});

test("a live Claude session takes precedence over cursor cwd resolution", () => {
  // In a Cursor terminal running Claude Code, CLAUDE_CODE_SESSION_ID wins and the
  // cursor resolver is never consulted.
  let resolverCalled = false;
  const identity = inferSessionIdentity(
    { CLAUDE_CODE_SESSION_ID: "claude-live" },
    {
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => {
        resolverCalled = true;
        return "composer-abc";
      },
    },
  );

  expect(identity.tool).toBe("claude");
  expect(identity.id).toBe("claude-live");
  expect(resolverCalled).toBe(false);
});

test("a live Codex session takes precedence over cursor cwd resolution", () => {
  const identity = inferSessionIdentity(
    { CODEX_THREAD_ID: "codex-live" },
    {
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => "composer-abc",
    },
  );

  expect(identity.tool).toBe("codex");
  expect(identity.id).toBe("codex-live");
});

test("cursor resolution runs only after codex and claude env sessions are absent", () => {
  let resolverCalls = 0;
  const identity = inferSessionIdentity(
    {
      CODEX_THREAD_ID: "   ",
      CLAUDE_CODE_SESSION_ID: "   ",
    },
    {
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => {
        resolverCalls += 1;
        return "composer-abc";
      },
    },
  );

  expect(identity).toEqual({
    tool: "cursor",
    id: "composer-abc",
    transcriptPath: "cursor:composer-abc",
  });
  expect(resolverCalls).toBe(1);
});

test("falls back to claude when the cwd maps to no cursor composer", () => {
  const identity = inferSessionIdentity(
    {},
    {
      cwd: "/somewhere/else",
      resolveCursorComposer: () => null,
    },
  );

  expect(identity).toEqual({
    tool: "claude",
    id: undefined,
    transcriptPath: undefined,
  });
});

test("treats a blank resolved composerId as no cursor session", () => {
  const identity = inferSessionIdentity(
    {},
    {
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => "   ",
    },
  );

  expect(identity.tool).toBe("claude");
  expect(identity.id).toBeUndefined();
});

test("a forced cursor tool resolves the composer from cwd", () => {
  const identity = inferSessionIdentity(
    { CLAUDE_CODE_SESSION_ID: "claude-live" },
    {
      tool: "cursor",
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => "composer-xyz",
    },
  );

  expect(identity).toEqual({
    tool: "cursor",
    id: "composer-xyz",
    transcriptPath: "cursor:composer-xyz",
  });
});

test("an explicit id override wins over cursor cwd resolution", () => {
  const identity = inferSessionIdentity(
    {},
    {
      tool: "cursor",
      id: "explicit-composer",
      cwd: "/repos/trace-v2",
      resolveCursorComposer: () => "resolved-composer",
    },
  );

  expect(identity).toEqual({
    tool: "cursor",
    id: "explicit-composer",
    transcriptPath: "cursor:explicit-composer",
  });
});

test("does not attempt cursor resolution without a cwd", () => {
  let resolverCalled = false;
  const identity = inferSessionIdentity(
    {},
    {
      resolveCursorComposer: () => {
        resolverCalled = true;
        return "composer-abc";
      },
    },
  );

  expect(identity.tool).toBe("claude");
  expect(resolverCalled).toBe(false);
});
