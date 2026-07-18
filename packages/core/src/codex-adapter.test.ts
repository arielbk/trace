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
import {
  parseCodexTranscript,
  parseCodexTranscriptFile,
  resolveCodexTranscriptPathById,
  scanCodexSessions,
} from "./codex-adapter.ts";

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
        subagentSpawns: [],
        subagentSource: null,
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
    subagentSpawns: [],
    subagentSource: null,
    tokenTotals: {
      // OpenAI's input_tokens includes cached input (42028 with 24320
      // cached); Trace's inputTokens is the fresh remainder.
      inputTokens: 17708,
      outputTokens: 725,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 24320,
      totalTokens: 42753,
    },
  });
});

test("Codex Desktop transcript: separates context growth from cache-miss replay", () => {
  const transcriptPath = "/tmp/019eb759-7cb3-7700-9370-77db8da46f94.jsonl";
  const tokenCounts = [
    {
      total_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 10,
        total_tokens: 110,
      },
      last_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 10,
        total_tokens: 110,
      },
    },
    {
      total_token_usage: {
        input_tokens: 250,
        cached_input_tokens: 100,
        output_tokens: 30,
        total_tokens: 280,
      },
      last_token_usage: {
        input_tokens: 150,
        cached_input_tokens: 100,
        output_tokens: 20,
        total_tokens: 170,
      },
    },
    {
      total_token_usage: {
        input_tokens: 330,
        cached_input_tokens: 120,
        output_tokens: 35,
        total_tokens: 365,
      },
      last_token_usage: {
        input_tokens: 80,
        cached_input_tokens: 20,
        output_tokens: 5,
        total_tokens: 85,
      },
    },
    {
      total_token_usage: {
        input_tokens: 440,
        cached_input_tokens: 200,
        output_tokens: 42,
        total_tokens: 482,
      },
      last_token_usage: {
        input_tokens: 110,
        cached_input_tokens: 80,
        output_tokens: 7,
        total_tokens: 117,
      },
    },
  ];
  const transcript = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019eb759-7cb3-7700-9370-77db8da46f94" },
    }),
    ...tokenCounts.map((info) =>
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info },
      }),
    ),
  ].join("\n");

  expect(
    parseCodexTranscript({ transcript, transcriptPath }).tokenTotals,
  ).toEqual({
    inputTokens: 180,
    outputTokens: 42,
    cacheCreationInputTokens: 60,
    cacheReadInputTokens: 200,
    totalTokens: 482,
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

test("Codex Desktop transcript: model comes from turn_context", () => {
  const transcriptPath = "/tmp/019eb759-7cb3-7700-9370-77db8da46f94.jsonl";
  const transcript = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019eb759-7cb3-7700-9370-77db8da46f94" },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "high" },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { turn_id: "turn-2", model: "gpt-5.5", effort: "high" },
    }),
  ].join("\n");

  const result = parseCodexTranscript({ transcript, transcriptPath });
  // First model wins, matching the claude adapter's convention.
  expect(result.model).toBe("gpt-5.6-sol");
});

test("Codex Desktop transcript: model falls back to thread_settings_applied", () => {
  const transcriptPath = "/tmp/019eb759-7cb3-7700-9370-77db8da46f94.jsonl";
  const transcript = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019eb759-7cb3-7700-9370-77db8da46f94" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      },
    }),
  ].join("\n");

  expect(parseCodexTranscript({ transcript, transcriptPath }).model).toBe(
    "gpt-5.6-sol",
  );
});

test("Codex Desktop transcript: title comes from the codex home session index", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-title-"));
  try {
    const dayDir = join(dir, "sessions", "2026", "07", "10");
    mkdirSync(dayDir, { recursive: true });
    const threadId = "019f4b1c-b288-70b1-b8be-b6d822ca1eb3";
    const transcriptPath = join(
      dayDir,
      `rollout-2026-07-10T10-19-59-${threadId}.jsonl`,
    );
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
    );
    // Renames append; the last row for the thread wins.
    writeFileSync(
      join(dir, "session_index.jsonl"),
      [
        JSON.stringify({
          id: threadId,
          thread_name: "First name",
          updated_at: "2026-07-10T08:20:20Z",
        }),
        JSON.stringify({
          id: "some-other-thread",
          thread_name: "Unrelated",
          updated_at: "2026-07-10T08:21:00Z",
        }),
        JSON.stringify({
          id: threadId,
          thread_name: "Resume Codex plugin audit",
          updated_at: "2026-07-10T09:00:00Z",
        }),
      ].join("\n"),
    );

    expect(parseCodexTranscriptFile(transcriptPath).title).toBe(
      "Resume Codex plugin audit",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex transcript outside a sessions tree has a null title", () => {
  const transcriptPath = "/tmp/019eb759-7cb3-7700-9370-77db8da46f94.jsonl";
  const transcript = JSON.stringify({
    type: "session_meta",
    payload: { id: "019eb759-7cb3-7700-9370-77db8da46f94" },
  });
  expect(parseCodexTranscript({ transcript, transcriptPath }).title).toBe(null);
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

test("Codex transcript adapter collects parent-side subagent spawn records", () => {
  const transcript = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        call_id: "call_1",
        sender_thread_id: "codex-thread-1",
        new_thread_id: "codex-child-1",
        new_agent_nickname: "Huygens",
        new_agent_role: "explorer",
        status: "pending_init",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "collab_agent_spawn_end", new_thread_id: "codex-child-2" },
    }),
  ].join("\n");

  expect(
    parseCodexTranscript({ transcript, transcriptPath: "/tmp/codex-thread-1.jsonl" })
      .subagentSpawns,
  ).toEqual([
    { threadId: "codex-child-1", role: "explorer", nickname: "Huygens" },
    { threadId: "codex-child-2", role: null, nickname: null },
  ]);
});

// Codex Desktop 0.142+ writes no collab_agent_spawn_end at all; the spawn is a
// spawn_agent function_call (role in its JSON-string arguments) answered by a
// function_call_output (child id and nickname in its JSON-string output),
// correlated by call_id.
test("Codex transcript adapter recovers spawns from Desktop spawn_agent call/output pairs", () => {
  const transcript = [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-thread-1" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "multi_agent_v1",
        arguments: JSON.stringify({ agent_type: "explorer", message: "audit" }),
        call_id: "call_spawn_1",
      },
    }),
    // An unrelated tool call sharing the stream must not be mistaken for a spawn.
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls" }),
        call_id: "call_other",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_other",
        output: "file listing",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_1",
        output: JSON.stringify({
          agent_id: "codex-child-1",
          nickname: "Hooke",
        }),
      },
    }),
    // A failed spawn returns an error string instead of an agent handle.
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: JSON.stringify({ agent_type: "reviewer" }),
        call_id: "call_spawn_2",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_2",
        output: "error: agent limit reached",
      },
    }),
  ].join("\n");

  expect(
    parseCodexTranscript({ transcript, transcriptPath: "/tmp/codex-thread-1.jsonl" })
      .subagentSpawns,
  ).toEqual([{ threadId: "codex-child-1", role: "explorer", nickname: "Hooke" }]);
});

// Codex Desktop 0.144+ (multi-agent v2): the spawn_agent output carries only
// {task_name}; the child thread id arrives in a sub_agent_activity "started"
// event_msg, correlated to the call by event_id. Later activity kinds
// (interacted, completed) for the same thread must not duplicate the spawn.
test("Codex transcript adapter recovers spawns from Desktop sub_agent_activity events", () => {
  const transcript = [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-thread-1" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: JSON.stringify({
          task_name: "test_codex_update",
          fork_turns: "all",
          message: "gAAAAABqUKt_encrypted",
        }),
        call_id: "call_spawn_1",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_1",
        output: JSON.stringify({ task_name: "/root/test_codex_update" }),
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: "call_spawn_1",
        agent_thread_id: "codex-child-1",
        agent_path: "/root/test_codex_update",
        kind: "started",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: "call_send_1",
        agent_thread_id: "codex-child-1",
        agent_path: "/root/test_codex_update",
        kind: "interacted",
      },
    }),
  ].join("\n");

  expect(
    parseCodexTranscript({
      transcript,
      transcriptPath: "/tmp/codex-thread-1.jsonl",
    }).subagentSpawns,
  ).toEqual([
    { threadId: "codex-child-1", role: null, nickname: "test_codex_update" },
  ]);
});

test("Codex transcript adapter dedupes a child named by both spawn record shapes", () => {
  const transcript = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        new_thread_id: "codex-child-1",
        new_agent_nickname: "Hooke",
        new_agent_role: "explorer",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: JSON.stringify({ agent_type: "explorer" }),
        call_id: "call_spawn_1",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_1",
        output: JSON.stringify({
          agent_id: "codex-child-1",
          nickname: "Hooke",
        }),
      },
    }),
  ].join("\n");

  expect(
    parseCodexTranscript({ transcript, transcriptPath: "/tmp/codex-thread-1.jsonl" })
      .subagentSpawns,
  ).toEqual([{ threadId: "codex-child-1", role: "explorer", nickname: "Hooke" }]);
});

test("Codex transcript adapter reads a subagent child's own parent linkage", () => {
  const transcript = JSON.stringify({
    type: "session_meta",
    payload: {
      id: "codex-child-1",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "codex-thread-1",
            depth: 1,
            agent_nickname: "Huygens",
            agent_role: "explorer",
          },
        },
      },
    },
  });

  expect(
    parseCodexTranscript({ transcript, transcriptPath: "/tmp/codex-child-1.jsonl" })
      .subagentSource,
  ).toEqual({
    parentThreadId: "codex-thread-1",
    role: "explorer",
    nickname: "Huygens",
  });
});

test("resolveCodexTranscriptPathById finds a rollout across date directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-resolve-"));
  const childId = "019de084-4f0d-72b2-986d-b53366f73408";
  const childPath = join(
    dir,
    "sessions",
    "2026",
    "05",
    "01",
    `rollout-2026-05-01T00-31-00-${childId}.jsonl`,
  );

  try {
    mkdirSync(join(dir, "sessions", "2026", "05", "01"), { recursive: true });
    writeFileSync(
      childPath,
      JSON.stringify({ type: "thread.started", thread_id: childId }),
    );

    expect(resolveCodexTranscriptPathById(dir, childId)).toBe(childPath);
    expect(resolveCodexTranscriptPathById(dir, "missing-thread")).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
